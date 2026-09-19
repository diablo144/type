// Protocol sniffer: maps the live lobby API in ~60 seconds using YOUR session.
// Usage (run on a machine with internet access to koth.z0d1ak.org):
//   KOTH_COOKIE='<paste from browser DevTools>' node src/sniff.js [--probe] [--time 30]
//     --probe   also send candidate join/leave messages on the queue socket
//               (default: listen-only; NEVER auto-accepts a seat)
//     --time N  socket listen window in seconds (default 30)
//
// What it does:
//   1. GET /api/config (public) — prints current format + clocks
//   2. GET /api/me, /api/ladder (authed) — prints shapes, proves auth works
//   3. GET /api/queue with Origin — prints whatever it says (state? error?)
//   4. Opens the /api/queue WebSocket, dumps every server frame verbatim
// Paste the full output back to the agent and the bot gets wired precisely.
import WebSocket from 'ws';
import {KothHttp, PROTOCOL, classifyServerFrame, extractSeat} from './koth-client.js';

function parseArgs(argv) {
  const out = {
    server: process.env.KOTH_SERVER || 'https://koth.z0d1ak.org',
    probe: false,
    time: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i];
    else if (argv[i] === '--probe') out.probe = true;
    else if (argv[i] === '--time' && argv[i + 1]) out.time = parseFloat(argv[++i]);
  }
  return out;
}

const token = process.env.KOTH_TOKEN || '';
const cookie = process.env.KOTH_COOKIE || '';
if (!token && !cookie) {
  console.error('Missing auth: set KOTH_COOKIE (preferred) or KOTH_TOKEN.');
  console.error('  1. Sign in at https://koth.z0d1ak.org in your browser.');
  console.error('  2. DevTools -> Application -> Cookies -> copy the session cookie');
  console.error('     as a single "name=value" string (or the whole Cookie header).');
  process.exit(2);
}

const {server, probe, time} = parseArgs(process.argv.slice(2));
const http = new KothHttp(server.replace(/\/$/, ''), token, cookie);
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function show(label, promise) {
  try {
    const {status, json, text} = await promise;
    const body = json ? JSON.stringify(json).slice(0, 1000) : (text || '').slice(0, 1000);
    log(`${label} -> http ${status}: ${body}`);
  } catch (e) {
    log(`${label} -> ERROR: ${e.message}`);
  }
}

async function main() {
  log(`sniffing ${server} (probe=${probe}, listen=${time}s)`);
  await show('GET /api/config', http.fetchConfig());
  await show('GET /api/me     ', http.fetchMe());
  await show('GET /api/ladder ', http.fetchLadder());
  await show('GET /api/queue  ', http.queueState());

  const url = server.replace(/\/$/, '').replace(/^http/, 'ws') + PROTOCOL.queuePath;
  log(`opening ${url} ...`);
  const ws = new WebSocket(url, {
    headers: {Origin: server.replace(/\/$/, ''), ...PROTOCOL.authHeaders(token, cookie)},
  });
  const deadline = Date.now() + time * 1000;
  let frames = 0;

  ws.on('open', () => {
    log('socket OPEN (handshake accepted auth + Origin)');
    if (probe) {
      for (const hello of PROTOCOL.queueHello) {
        const text = JSON.stringify(hello);
        log(`C> ${text}`);
        ws.send(text);
      }
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN && Date.now() < deadline) {
          const text = JSON.stringify(PROTOCOL.queueLeave);
          log(`C> ${text}`);
          try { ws.send(text); } catch { /* ignore */ }
        }
      }, Math.min(15000, (time * 1000) / 2));
    } else {
      log('(listen-only: send nothing; use --probe to try join/leave)');
    }
  });
  ws.on('message', (data) => {
    frames++;
    const frame = String(data);
    const cls = classifyServerFrame(frame);
    log(`S> [${cls.kind}] ${frame.slice(0, 600)}`);
    if (cls.kind === 'json') {
      const seat = extractSeat(cls.msg);
      if (seat) log(`*** SEAT DETECTED (not accepting): ${JSON.stringify(seat).slice(0, 400)}`);
    }
    if (cls.kind === 'battle' && !probe) {
      log('*** battle traffic while listen-only — the server deals seats unsolicited?');
    }
  });
  ws.on('close', (code, reason) => log(`socket CLOSED (${code} ${String(reason).slice(0, 200)})`));
  ws.on('error', (e) => log(`socket ERROR: ${e.message}`));

  while (Date.now() < deadline && ws.readyState !== WebSocket.CLOSED) {
    await new Promise(r => setTimeout(r, 500));
  }
  log(`done: ${frames} server frames in ${time}s`);
  try { ws.close(); } catch { /* ignore */ }
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
