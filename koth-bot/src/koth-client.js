// KOTH bot client: HTTP lobby layer + Showdown-protocol battle driver.
//
// WHAT IS KNOWN (verified against the live server on 2026-09-19):
//   GET /api/config               -> public JSON: {formatId, acceptSeconds,
//                                      reconnectSeconds, turnSeconds, eloStart,
//                                      rctfEnabled, nowMs, formats:[54]}.
//   GET /api/me, /api/ladder      -> {"error":"invalid_session"} unauthenticated,
//                                      so both EXIST and need auth.
//   GET /api/queue                -> {"error":"invalid_origin"}: EXISTS and checks
//                                      the Origin header. Almost certainly the
//                                      WebSocket upgrade for queue + battle traffic.
//   GET /auth/rctf/start          -> OAuth login entry.
//   35+ other paths (/api/team, /api/roster, /api/battle, /ws, ...) -> not_found.
//   CONCLUSION: the lobby API is tiny on purpose. All live traffic goes through
//   ONE origin-guarded socket: /api/queue. Roster submit is most likely
//   POST/PATCH/PUT /api/me {formatId, team} or a message on the queue socket;
//   the client tries candidates in order (server error strings are informative).
//
// Battle protocol (Showdown standard, verified locally against @pkmn/sim):
//   - server sends `|request|{...}` per decision point; client replies
//     `<room>|/choose <choiceString>` where choiceString is e.g.
//     `move 1 2, move 3`, `switch 4`, `team 1, 2, 3`, `pass, switch 3`.
//   - invalid choices come back as `|error|[Invalid choice] ...` with NO new
//     request: re-decide the SAME request excluding rejected strings.
//   - wait-requests (`{"wait":true}`) mean "opponent is deciding": send NOTHING.
//   - fainted slots may be offered moves with no forceSwitch flag (no bench to
//     switch to): those slots must get `pass`, never move/switch.
//   - mid-turn single-slot prompts (`{forceSwitch:[true,false]}`, no `active`)
//     take a SINGLE action, not one per slot.
import WebSocket from 'ws';
import {BattleAI} from './ai.js';
import {Tracker} from './tracker.js';
import {formatMeta, getBattleExport, getPackedTeam} from '../teams/index.js';

// ---------------------------------------------------------------------------
// PROTOCOL — every server-specific guess lives here.
// ---------------------------------------------------------------------------
export const PROTOCOL = {
  // Public config (KNOWN GOOD).
  configPath: '/api/config',
  // Authed identity + standings (KNOWN TO EXIST, shapes unknown until sniffed).
  mePath: '/api/me',
  ladderPath: '/api/ladder',
  // The one live wire: queue + (probably) battle multiplex (KNOWN TO EXIST,
  // origin-guarded; message vocabulary discovered at runtime, see sniff.js).
  queuePath: '/api/queue',
  // Roster submit candidates, tried in order until one is not 404.
  // Each entry: [method, path, body(formatId, packedTeam, exportText)].
  // The server answers validation errors as JSON, which the logs surface.
  rosterAttempts: [
    ['POST', '/api/me', (f, packed) => ({formatId: f, team: packed})],
    ['PATCH', '/api/me', (f, packed) => ({formatId: f, team: packed})],
    ['PUT', '/api/me', (f, packed) => ({formatId: f, team: packed})],
    ['POST', '/api/me', (f, _p, exp) => ({formatId: f, team: exp})],
    ['POST', '/api/me', (_f, packed) => ({team: packed})],
  ],
  // Queue state via plain HTTP (works only if the route also serves GET).
  queueStateAttempts: [
    ['GET', '/api/queue', () => undefined],
  ],
  // Queue join/leave if they turn out to be HTTP rather than socket messages.
  queueJoinAttempts: [
    ['POST', '/api/queue', () => ({action: 'join'})],
    ['POST', '/api/queue', () => ({type: 'join'})],
  ],
  queueLeaveAttempts: [
    ['POST', '/api/queue', () => ({action: 'leave'})],
    ['POST', '/api/queue', () => ({type: 'leave'})],
  ],
  // Seat accept if it turns out to be HTTP rather than a socket message.
  acceptAttempts: [
    ['POST', '/api/queue', () => ({action: 'accept'})],
    ['POST', '/api/queue', () => ({type: 'accept'})],
  ],
  // Candidate hello/join messages for the queue socket (sniff.js --probe sends
  // these one at a time; the live client sends the join pair on connect).
  queueHello: [
    {type: 'join'},
    {action: 'join'},
  ],
  queueLeave: {type: 'leave'},
  queueAccept: [
    {type: 'accept'},
    {action: 'accept'},
  ],
  // Auth: the rCTF session cookie copied from the browser (KOTH_COOKIE), or a
  // bearer token (KOTH_TOKEN) if the deployment issues one. Sent as Cookie on
  // WS and as both Cookie + Authorization on HTTP.
  authHeaders: (token, cookie) => {
    const h = {};
    if (cookie) h.Cookie = cookie;
    else if (token) h.Cookie = `token=${token}`;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  },
};
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class KothHttp {
  constructor(server, token, cookie = '') {
    this.server = server.replace(/\/$/, '');
    this.token = token;
    this.cookie = cookie;
  }
  headers() {
    return {
      'Content-Type': 'application/json',
      Origin: this.server, // /api/queue (and maybe others) demand this
      ...PROTOCOL.authHeaders(this.token, this.cookie),
    };
  }
  async req(method, path, body) {
    const res = await fetch(this.server + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return {status: res.status, json, text};
  }
  async tryAttempts(attempts, ...args) {
    let last = null;
    for (const [method, path, bodyFn] of attempts) {
      last = await this.req(method, path, bodyFn(...args));
      if (last.status !== 404) return {path, method, ...last};
    }
    const [method, path] = attempts[attempts.length - 1];
    return {path, method, ...last};
  }
  fetchConfig() { return this.req('GET', PROTOCOL.configPath); }
  fetchMe() { return this.req('GET', PROTOCOL.mePath); }
  fetchLadder() { return this.req('GET', PROTOCOL.ladderPath); }
  queueState() { return this.tryAttempts(PROTOCOL.queueStateAttempts); }
  setRoster(formatId) {
    return this.tryAttempts(PROTOCOL.rosterAttempts, formatId, getPackedTeam(formatId), getBattleExport(formatId));
  }
  joinQueue() { return this.tryAttempts(PROTOCOL.queueJoinAttempts); }
  leaveQueue() { return this.tryAttempts(PROTOCOL.queueLeaveAttempts); }
  acceptBattle() { return this.tryAttempts(PROTOCOL.acceptAttempts); }
}

// ---------------------------------------------------------------------------
// Showdown-protocol battle session over one WebSocket.
// `sendRaw(text)` writes client->server; server frames are fed to `onServer()`
// as full strings (room prefix + payload). Resolves with 'win' | 'loss' | 'tie'.
// ---------------------------------------------------------------------------
export class BattleSession {
  constructor({formatId, mySide = null, log = () => {}} = {}) {
    this.meta = formatMeta(formatId);
    this.formatId = formatId;
    this.mySide = mySide; // 'p1' | 'p2' | null (autodetect from |player|)
    this.log = log;
    this.ai = new BattleAI({
      formatId,
      gen: this.meta.gen,
      gameType: this.meta.gameType,
      defaultLevel: this.meta.defaultLevel,
    });
    this.tracker = null;
    this.room = null;
    this.lastReq = null;
    this.rejected = new Set();
    this.turns = 0;
    this.errors = 0;
    this.done = false;
    this._resolve = null;
    this.resultPromise = new Promise(r => { this._resolve = r; });
  }

  // -- incoming -------------------------------------------------------------
  onServer(frame) {
    if (this.done) return;
    // Split `>room\npayload` frames; payload may itself be multiline.
    let room = null;
    let payload = frame;
    if (frame.startsWith('>')) {
      const nl = frame.indexOf('\n');
      room = frame.slice(1, nl < 0 ? undefined : nl);
      payload = nl < 0 ? '' : frame.slice(nl + 1);
      if (!this.room && room.startsWith('battle-')) this.room = room;
    }
    if (this.room && room && room !== this.room) return; // another room
    for (const chunk of payload.split('\n')) {
      if (!chunk) continue;
      this.onChunk(chunk);
      if (this.done) return;
    }
  }

  onChunk(chunk) {
    // Win / tie ends the session.
    const win = /\|win\|([^\n|]*)/.exec(chunk) || /\|tie\|([^\n]*)/.exec(chunk);
    if (win) {
      const who = (win[1] || '').trim().toLowerCase();
      let result = 'tie';
      if (/\|win\|/.test(chunk)) {
        const myName = (this.myName || '').trim().toLowerCase();
        // |win| carries the winner's player name; fall back to side number.
        const iWon = myName
          ? (who === myName || who.includes(myName))
          : this.mySide
            ? who.includes(this.mySide === 'p1' ? '1' : '2')
            : who.includes('1');
        result = iWon ? 'win' : 'loss';
      }
      return this.finish(result, chunk);
    }
    const tm = /\|turn\|(\d+)/.exec(chunk);
    if (tm) this.turns = Math.max(this.turns, parseInt(tm[1], 10));

    // Detect our side from |player|pX|name (our name set via setIdentity).
    const pl = /\|player\|(p[12])\|([^\n|]*)/.exec(chunk);
    if (pl && this.myName && pl[2].trim() === this.myName) {
      this.mySide = pl[1];
      if (!this.tracker) this.tracker = new Tracker(this.mySide);
    }

    // Choice error: NO new request follows; re-decide the SAME request.
    if (chunk.startsWith('|error|')) {
      this.errors++;
      const m = /\[Invalid choice\][^\n]*/.exec(chunk);
      this.log(`choice error (${this.errors}): ${m ? m[0] : chunk.slice(0, 120)}`);
      this.rejected.add(this.ai.lastChoice);
      this.answer(this.lastReq, true);
      return;
    }

    // Request (may be glued after log lines in one chunk: split on |request|).
    const ri = chunk.indexOf('|request|');
    if (ri >= 0) {
      const logPart = chunk.slice(0, ri);
      let req = null;
      try {
        req = JSON.parse(chunk.slice(ri + '|request|'.length));
      } catch (e) {
        this.log(`bad request JSON, ignoring (${e.message})`);
        return;
      }
      if (logPart && this.tracker) this.tracker.feed(logPart);
      this.lastReq = req;
      this.rejected.clear();
      this.answer(req, false);
      return;
    }

    // Plain battle log.
    if (this.tracker && chunk.startsWith('|')) this.tracker.feed(chunk + '\n');
  }

  setIdentity(name) {
    this.myName = name;
  }

  // -- outgoing ---------------------------------------------------------------
  answer(req, isRetry) {
    if (this.done || !req) return;
    if (!this.tracker && this.mySide) this.tracker = new Tracker(this.mySide);
    let dec;
    try {
      dec = this.ai.decide(req, this.tracker || new Tracker(this.mySide || 'p1'), this.rejected);
    } catch (e) {
      this.log(`AI exception (retry ${isRetry}): ${e.message}`);
      dec = {choiceString: 'default'};
    }
    if (!dec.choiceString) return; // wait-request: send nothing
    // Our AI never emits `default` except as a last resort; the sim resolves it.
    this.ai.lastChoice = dec.choiceString;
    this.send(`/choose ${dec.choiceString}`);
  }

  send(text) {
    if (this.done) return;
    if (this.room) this.emit(`${this.room}|${text}`);
    else this.emit(text);
  }

  // Wired by the owner to ws.send().
  emit(text) {
    if (this._emit) this._emit(text);
  }

  finish(result) {
    if (this.done) return;
    this.done = true;
    this.log(`battle over: ${result} after ${this.turns} turns (${this.errors} choice errors)`);
    if (this._resolve) this._resolve(result);
  }
}

// ---------------------------------------------------------------------------
// Message classification for the queue socket. Returns one of:
//   {kind:'battle', text}      Showdown battle frame (room-prefixed or |...|)
//   {kind:'json', msg}         parsed JSON lobby message
//   {kind:'text', text}        anything else (log + stash)
// ---------------------------------------------------------------------------
export function classifyServerFrame(frame) {
  if (/^>battle-/.test(frame)) return {kind: 'battle', text: frame};
  if (frame.startsWith('|')) return {kind: 'battle', text: frame};
  const trimmed = frame.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return {kind: 'json', msg: JSON.parse(trimmed), text: frame};
    } catch { /* fall through to text */ }
  }
  // Some servers wrap PS frames in JSON: {room, data} or {type:'battle', ...}.
  return {kind: 'text', text: frame};
}

// Heuristic: does this JSON lobby message describe a battle seat?
// Looks for room/battle ids, side assignments, accept prompts. Returns a seat
// object {room, side?, acceptIn?, raw} or null.
export function extractSeat(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const blob = JSON.stringify(msg).toLowerCase();
  const hasRoom = msg.room || msg.battleId || msg.battle || msg.roomId;
  const hasSide = msg.side === 'p1' || msg.side === 'p2' || msg.player;
  const wantsAccept = /accept|confirm|ready|seat|match|opponent|battle/.test(blob);
  if (hasRoom || (hasSide && wantsAccept) || (wantsAccept && msg.format)) {
    return {
      room: msg.room || msg.roomId || (msg.battleId ? `battle-${msg.battleId}` : msg.battle) || null,
      side: msg.side || null,
      acceptIn: msg.acceptIn || msg.acceptSeconds || null,
      raw: msg,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// High-level client: config -> roster -> queue socket -> battle loop.
// The queue socket is multiplexed: battle frames go to a BattleSession, JSON
// lobby messages go to seat/accept handling, everything is transcript-logged.
// ---------------------------------------------------------------------------
export class KothClient {
  constructor({server, token, cookie = '', log = console.log}) {
    this.server = server.replace(/\/$/, '');
    this.token = token;
    this.cookie = cookie || process.env.KOTH_COOKIE || '';
    this.http = new KothHttp(this.server, token, this.cookie);
    this.log = log;
    this.formatId = null;
    this.config = null;
    this.myName = null;
    this.stopped = false;
    this.qws = null;         // live queue socket (shared with battles)
    this.transcript = [];    // last ~200 server frames (for protocol forensics)
    this.session = null;     // active BattleSession, if any
  }

  // -- setup ----------------------------------------------------------------
  async refreshConfig() {
    const {status, json} = await this.http.fetchConfig();
    if (status !== 200 || !json || !json.formatId) {
      throw new Error(`config fetch failed (http ${status})`);
    }
    const changed = this.config && this.config.formatId !== json.formatId;
    this.config = json;
    this.formatId = json.formatId;
    if (changed) this.log(`format changed -> ${this.formatId} (rosters wiped, resubmitting)`);
    return json;
  }

  async identify() {
    const {status, json, text} = await this.http.fetchMe();
    if (status >= 200 && status < 300 && json) {
      this.myName = json.name || json.username || json.team || null;
      this.log(`/api/me: ${JSON.stringify(json).slice(0, 300)}`);
      return json;
    }
    this.log(`/api/me -> http ${status}: ${(text || '').slice(0, 200)}`);
    return null;
  }

  async ensureRoster() {
    const {path, method, status, json, text} = await this.http.setRoster(this.formatId);
    if (status >= 200 && status < 300) {
      this.log(`roster accepted for ${this.formatId} via ${method} ${path}`);
      return true;
    }
    this.log(`roster submit failed (${method} ${path} -> http ${status}): ${(text || '').slice(0, 200)}`);
    if (json && json.error) this.log(`server says: ${JSON.stringify(json.error).slice(0, 300)}`);
    return false;
  }

  wsHeaders() {
    return {
      Origin: this.server, // required: server gates /api/queue on Origin
      ...PROTOCOL.authHeaders(this.token, this.cookie),
    };
  }

  queueWsUrl() {
    return this.server.replace(/^http/, 'ws') + PROTOCOL.queuePath;
  }

  stash(dir, frame) {
    this.transcript.push(`${dir} ${String(frame).slice(0, 500)}`);
    if (this.transcript.length > 200) this.transcript.shift();
  }

  dumpTranscript() {
    return this.transcript.join('\n');
  }

  // -- queue socket -----------------------------------------------------------
  // Opens the queue socket, announces presence, and resolves with a seat once
  // the server deals one: {room, side?, ws(shared), shared:true}.
  // Rejects if the socket closes/errors before a seat arrives.
  async findSeat() {
    const url = this.queueWsUrl();
    this.log(`opening queue socket ${url}`);
    const ws = new WebSocket(url, {headers: this.wsHeaders()});
    this.qws = ws;
    this.session = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      ws.on('open', () => {
        this.log('queue socket open, sending join hello');
        for (const hello of PROTOCOL.queueHello) {
          const text = JSON.stringify(hello);
          this.stash('C>', text);
          ws.send(text);
        }
      });
      ws.on('message', (data) => {
        const frame = String(data);
        this.stash('S>', frame);
        const cls = classifyServerFrame(frame);
        if (cls.kind === 'battle') {
          // Battle traffic on the queue socket: a seat by definition.
          if (!this.session) {
            this.log(`battle traffic on queue socket (${frame.slice(0, 80)}…)`);
            done(resolve, {room: null, side: null, ws, shared: true});
          } else {
            this.session.onServer(cls.text);
          }
          return;
        }
        if (cls.kind === 'json') {
          const seat = extractSeat(cls.msg);
          this.log(`[lobby] ${frame.slice(0, 250)}`);
          if (seat) {
            this.log(`seat detected: ${JSON.stringify({...seat, raw: undefined})}`);
            done(resolve, {...seat, ws, shared: true});
          }
          return;
        }
        this.log(`[lobby] ${frame.slice(0, 250)}`);
      });
      ws.on('close', (code, reason) => {
        this.log(`queue socket closed (${code} ${String(reason).slice(0, 120)})`);
        this.qws = null;
        done(reject, new Error(`queue socket closed before seat (${code})`));
      });
      ws.on('error', (e) => {
        this.log(`queue socket error: ${e.message}`);
        done(reject, e);
      });
    });
  }

  // Accept a seat: socket messages first (shared queue socket), then HTTP.
  async acceptSeat(seat) {
    const ws = (seat && seat.ws) || this.qws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (const a of PROTOCOL.queueAccept) {
        const text = JSON.stringify(seat && seat.room ? {...a, room: seat.room} : a);
        this.stash('C>', text);
        ws.send(text);
      }
      this.log('accept sent on queue socket');
      return {path: 'ws:/api/queue', status: 101};
    }
    const r = await this.http.acceptBattle();
    this.log(`accept: ${r.path} -> http ${r.status}`);
    return r;
  }

  connectBattleWs(wsUrl) {
    // Battles normally arrive on the shared queue socket (wsUrl null).
    // A separate battle URL is supported in case the seat carries one.
    if (!wsUrl) return this.qws;
    return new WebSocket(wsUrl, {headers: this.wsHeaders()});
  }

  // Play one battle on a socket (shared queue socket or a dedicated one).
  // Resolves 'win'|'loss'|'tie'.
  playBattle(ws, roomHint = null) {
    if (!ws) throw new Error('playBattle: no socket (queue socket died?)');
    const session = new BattleSession({
      formatId: this.formatId,
      log: (m) => this.log(`[battle] ${m}`),
    });
    this.session = session;
    if (this.myName) session.setIdentity(this.myName);
    if (roomHint) session.room = roomHint;
    session._emit = (text) => {
      if (ws.readyState === WebSocket.OPEN) {
        this.stash('C>', text);
        ws.send(text);
      }
    };
    const onMessage = (data) => {
      const frame = String(data);
      this.stash('S>', frame);
      const cls = classifyServerFrame(frame);
      if (cls.kind === 'battle') {
        session.onServer(cls.text);
        return;
      }
      // Lobby chatter during battle: surface, and track requeue prompts.
      this.log(`[lobby] ${frame.slice(0, 200)}`);
    };
    ws.on('message', onMessage);
    const cleanup = () => ws.off('message', onMessage);
    session.resultPromise.then(cleanup, cleanup);
    const armTimer = () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          if (roomHint) ws.send(`${roomHint}|/timer on`);
          else session.send('/timer on');
        }
      } catch { /* ignore */ }
    };
    if (ws.readyState === WebSocket.OPEN) armTimer();
    else ws.once('open', armTimer);
    ws.once('close', () => session.finish('tie'));
    ws.once('error', (e) => this.log(`[battle] ws error: ${e.message}`));
    return session.resultPromise;
  }

  leaveQueue() {
    const ws = this.qws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const text = JSON.stringify(PROTOCOL.queueLeave);
      this.stash('C>', text);
      try { ws.send(text); } catch { /* ignore */ }
    }
    return this.http.leaveQueue().catch(() => null);
  }

  stop() {
    this.stopped = true;
    try { if (this.qws) this.qws.close(); } catch { /* ignore */ }
    this.qws = null;
  }
}
