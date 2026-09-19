// KOTH bot entry point.
// Usage (run on a machine with internet access to koth.z0d1ak.org):
//   KOTH_COOKIE='<session cookie from browser DevTools>' node src/main.js [--server URL] [--once]
//     --server  KOTH server origin (default https://koth.z0d1ak.org)
//     --once    smoke test: config + roster + join queue, watch 15s, leave, exit
//
// The bot loop:
//   1. boot: GET /api/config + refresh (/api/me + /api/queue)
//   2. ensureRoster: PUT /api/team for the current format (leaves queue first
//      if the roster is locked; resubmits after operator format switches)
//   3. joinAndAccept: POST /api/queue, poll, accept instantly in the window
//   4. playMatch: snapshot GET + WS /ws/battle/{id} to done (with reconnect)
//   5. requeue; track W/L/T + Elo.
import {KothClient} from './koth-client.js';
import {validateTeamExport} from './validate.js';
import {formatMeta, getBattleExport, hasTeam} from '../teams/index.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {server: process.env.KOTH_SERVER || 'https://koth.z0d1ak.org', once: false};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i];
    else if (argv[i] === '--once') out.once = true;
  }
  return out;
}

async function main() {
  const {server, once} = parseArgs(process.argv.slice(2));
  const cookie = process.env.KOTH_COOKIE || process.env.KOTH_TOKEN || '';
  if (!cookie) {
    console.error('Missing auth: set KOTH_COOKIE (session cookie from browser DevTools).');
    console.error('  1. Sign in at https://koth.z0d1ak.org in your browser.');
    console.error('  2. DevTools -> Application -> Cookies -> copy the session cookie');
    console.error('     ("name=value", or the whole Cookie header value).');
    process.exit(2);
  }
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  const client = new KothClient({server, cookie, log});
  const stop = () => {
    log('stopping...');
    client.stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // 1. boot
  let config;
  try {
    config = await client.boot();
  } catch (e) {
    if (e.status === 401 || e.error === 'invalid_session') {
      console.error('Auth rejected (invalid_session): re-sign-in and refresh KOTH_COOKIE.');
      process.exit(5);
    }
    throw e;
  }
  log(`signed in as ${client.me.name} (elo ${client.me.elo}, games ${client.me.gamesPlayed}, occupancy ${client.occupancy})`);
  const meta = formatMeta(config.formatId);
  log(`format meta: gen=${meta.gen} gameType=${meta.gameType} level=${meta.defaultLevel}`);

  // Local legality pre-check (server is authoritative; problems only warn).
  if (!hasTeam(config.formatId)) {
    console.error(`No team file for ${config.formatId} (teams/${config.formatId}.txt missing).`);
    process.exit(3);
  }
  const problems = validateTeamExport(config.formatId, getBattleExport(config.formatId));
  if (problems === null) log('local legality check: LEGAL');
  else if (problems.length && String(problems[0]).startsWith('unknown format')) {
    log(`local legality check: skipped (${problems[0]} — trusting shipped team)`);
  } else {
    log(`local legality check FAILED:\n  - ${problems.join('\n  - ')}`);
    log('Submitting anyway (server is authoritative) — fix teams/ if rejected.');
  }

  // 2. roster
  if (!await client.ensureRoster()) {
    log('Roster not accepted; cannot queue. Fix teams/ and retry.');
    process.exit(4);
  }

  if (once) {
    // Smoke test: join, watch the lobby for 15s, leave, exit.
    await client.http.joinQueue().then(
      () => log('queue join ok'),
      (e) => log(`queue join failed: ${e.message}`));
    for (let i = 0; i < 5; i++) {
      await sleep(3000);
      try {
        await client.refresh();
        const m = client.match;
        log(`poll: occupancy=${client.occupancy}` +
          (m ? ` match=${m.id} ${m.status} vs ${m.opponent}` : ''));
        // Never hold a seat in smoke-test mode.
        if (m && m.status === 'accepting') {
          await client.http.rejectMatch(m.id);
          log('rejected probe seat (smoke-test mode)');
        }
      } catch (e) {
        log(`poll failed: ${e.message}`);
      }
    }
    await client.http.leaveQueue().then(
      () => log('queue leave ok'),
      (e) => log(`queue leave failed: ${e.message}`));
    try {
      const ladder = await client.http.ladder();
      const teams = ladder.teams || [];
      const i = teams.findIndex(t => t.name === client.me.name);
      log(`ladder: ${teams.length} teams` + (i >= 0 ? `, we are #${i + 1}` : ''));
    } catch (e) {
      log(`ladder read failed: ${e.message}`);
    }
    return;
  }

  // 3-5. main loop
  let wins = 0, losses = 0, ties = 0, cancelled = 0;
  for (;;) {
    if (client.stopped) return;
    try {
      if (!await client.ensureRoster()) {
        log('roster not accepted; retrying in 15s');
        await sleep(15000);
        continue;
      }
      log(`in queue for ${client.sessionFormat} (record ${wins}W-${losses}L-${ties}T)`);
      const match = await client.joinAndAccept();
      if (!match) {
        log('stopped.');
        return;
      }
      const result = await client.playMatch(match);
      if (result === 'win') wins++;
      else if (result === 'loss') losses++;
      else if (result === 'tie') ties++;
      else cancelled++;
      try {
        await client.refresh();
        log(`record ${wins}W-${losses}L-${ties}T (${cancelled} cancelled), elo ${client.me.elo}`);
      } catch {
        log(`record ${wins}W-${losses}L-${ties}T (${cancelled} cancelled)`);
      }
    } catch (e) {
      if (e.status === 401 || e.error === 'invalid_session' || e.error === 'banned') {
        log(`AUTH LOST (${e.error || e.message}): re-sign-in and refresh KOTH_COOKIE. Exiting.`);
        process.exit(5);
      }
      const waitMs = client.config && client.config.reconnectSeconds
        ? client.config.reconnectSeconds * 1000 : 30000;
      log(`loop error: ${e.message} — retrying in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
