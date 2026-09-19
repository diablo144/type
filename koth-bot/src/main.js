// KOTH bot entry point.
// Usage:
//   KOTH_TOKEN=<rctf-session-token> node src/main.js [--server URL] [--once]
//     --server  KOTH server origin (default https://koth.z0d1ak.org)
//     --once    submit roster + join queue, then exit (smoke test)
//
// The bot loop:
//   1. fetch /api/config -> current formatId + clocks
//   2. validate local team for the format (when the sim knows it), submit roster
//   3. join queue, wait for a battle seat (see findSeat override below)
//   4. play the battle with BattleAI, report result, requeue
//   5. on format change (rosters wiped): resubmit + requeue immediately
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
  const token = process.env.KOTH_TOKEN || '';
  if (!token && !process.env.KOTH_COOKIE) {
    console.error('Missing auth: set KOTH_TOKEN (rCTF session token from browser DevTools).');
    console.error('See README.md ("Auth token") for how to extract it.');
    process.exit(2);
  }
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  const client = new KothClient({server, token, log});

  // 1. config
  const config = await client.refreshConfig();
  log(`server config: format=${config.formatId} accept=${config.acceptSeconds}s turn=${config.turnSeconds}s eloStart=${config.eloStart}`);
  const meta = formatMeta(config.formatId);
  log(`format meta: gen=${meta.gen} gameType=${meta.gameType} level=${meta.defaultLevel}`);

  // 2. local team check + roster submit
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
  const ok = await client.ensureRoster();
  if (!ok) {
    log('Roster not accepted. Check the TODO endpoints in src/koth-client.js PROTOCOL.');
    if (once) process.exit(4);
  }
  if (once) {
    await client.http.joinQueue().then(r => log(`queue join: ${r.path} -> http ${r.status}`));
    return;
  }

  // 3-5. main loop with reconnect + format watch
  let wins = 0, losses = 0, ties = 0;
  for (;;) {
    try {
      await client.refreshConfig(); // picks up operator format switches
      await client.ensureRoster();
      log(`in queue for ${client.formatId} (record ${wins}W-${losses}L-${ties}T)`);
      const seat = await client.findSeat();
      if (!seat) {
        log('stopped.');
        return;
      }
      // Accept inside the acceptSeconds window, then play.
      // (Battles normally arrive on the shared queue socket: seat.shared.)
      await client.acceptSeat(seat);
      const ws = client.connectBattleWs(seat.wsUrl || null);
      const result = await client.playBattle(ws, seat.room || null);
      if (!seat.shared) {
        try { ws.close(); } catch { /* ignore */ }
      }
      if (result === 'win') wins++;
      else if (result === 'loss') losses++;
      else ties++;
      log(`record now ${wins}W-${losses}L-${ties}T`);
    } catch (e) {
      const waitMs = (client.config && client.config.reconnectSeconds
        ? client.config.reconnectSeconds * 1000 : 30000);
      log(`loop error: ${e.message} — retrying in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
