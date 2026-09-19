// Lobby inspector: verifies auth + prints live shapes from the real endpoints.
// Usage (run on a machine with internet access to koth.z0d1ak.org):
//   KOTH_COOKIE='<session cookie>' node src/sniff.js [--probe] [--time 15]
//     --probe   also join the queue, poll, then leave (never accepts a seat:
//               any probe match is rejected immediately)
//     --time N  probe window in seconds (default 15)
import {KothHttp, KothError} from './koth-client.js';

function parseArgs(argv) {
  const out = {
    server: (process.env.KOTH_SERVER || 'https://koth.z0d1ak.org').replace(/\/$/, ''),
    probe: false,
    time: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i].replace(/\/$/, '');
    else if (argv[i] === '--probe') out.probe = true;
    else if (argv[i] === '--time' && argv[i + 1]) out.time = parseFloat(argv[++i]);
  }
  return out;
}

const cookie = process.env.KOTH_COOKIE || process.env.KOTH_TOKEN || '';
if (!cookie) {
  console.error('Missing auth: set KOTH_COOKIE (session cookie from browser DevTools).');
  process.exit(2);
}

const {server, probe, time} = parseArgs(process.argv.slice(2));
const http = new KothHttp(server, cookie);
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function show(label, fn) {
  try {
    const json = await fn();
    log(`${label} -> ${JSON.stringify(json).slice(0, 800)}`);
    return json;
  } catch (e) {
    if (e instanceof KothError) {
      log(`${label} -> ERROR http ${e.status} ${e.error}` +
        (e.problems.length ? ` problems=${JSON.stringify(e.problems).slice(0, 300)}` : ''));
    } else {
      log(`${label} -> ERROR ${e.message}`);
    }
    return null;
  }
}

async function main() {
  const config = await show('GET /api/config', () => http.config());
  const me = await show('GET /api/me     ', () => http.me());
  await show('GET /api/queue  ', () => http.queueState());
  await show('GET /api/ladder ', () => http.ladder());
  if (!config || !me) {
    log('config/me failed; not probing further.');
    process.exit(1);
  }
  if (!probe) {
    log('(read-only; use --probe to join+leave the queue)');
    return;
  }
  if (!me.hasTeam) {
    log('no saved roster: PUT /api/team first (the bot does this); skipping queue probe.');
    return;
  }
  await show('POST /api/queue ', () => http.joinQueue());
  const deadline = Date.now() + time * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const q = await show('poll /api/queue', () => http.queueState());
    if (q && q.match && q.match.status === 'accepting') {
      log(`probe match ${q.match.id} is accepting: REJECTING (never hold a probe seat)`);
      await show('POST .../reject ', () => http.rejectMatch(q.match.id));
      break;
    }
    if (q && q.match && (q.match.status === 'pending_connect' || q.match.status === 'active')) {
      log(`probe match ${q.match.id} went ${q.match.status} without us (expected: we never accept).`);
      break;
    }
  }
  await show('DELETE /api/queue', () => http.leaveQueue());
  log('done.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
