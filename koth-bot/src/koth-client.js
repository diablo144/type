// KOTH bot client: HTTP lobby layer + Showdown-protocol battle driver.
//
// WHAT IS KNOWN (verified against the live server):
//   GET {server}/api/config -> {formatId, acceptSeconds, reconnectSeconds, turnSeconds,
//                                eloStart, rctfEnabled, ...}   (public, no auth)
// WHAT IS GUESSED (marked TODO below): roster/queue/seat endpoints and WS auth.
//   Fill these in from one DevTools Network recording of the web client and the
//   bot runs end to end. Everything else (battle protocol, AI, teams) is done.
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
// PROTOCOL — every server-specific guess lives here. Fix these from DevTools.
// ---------------------------------------------------------------------------
export const PROTOCOL = {
  // Public config (KNOWN GOOD).
  configPath: '/api/config',
  // TODO(user): roster submit. Best guesses, tried in order until one is not 404:
  //   each entry: [method, path, body(formatId, packedTeam, exportText)]
  rosterAttempts: [
    ['POST', '/api/roster', (f, packed, exp) => ({formatId: f, team: packed})],
    ['POST', '/api/team', (f, packed, exp) => ({formatId: f, team: exp})],
    ['PUT', '/api/roster', (f, packed, exp) => ({formatId: f, team: packed})],
  ],
  // TODO(user): queue join/leave.
  queueJoinAttempts: [
    ['POST', '/api/queue/join', () => ({})],
    ['POST', '/api/queue', () => ({action: 'join'})],
  ],
  queueLeaveAttempts: [
    ['POST', '/api/queue/leave', () => ({})],
    ['POST', '/api/queue', () => ({action: 'leave'})],
  ],
  // TODO(user): seat offer accept (acceptSeconds clock). Tried in order.
  acceptAttempts: [
    ['POST', '/api/battle/accept', () => ({})],
    ['POST', '/api/accept', () => ({})],
  ],
  // TODO(user): battle socket. Assumed to be Showdown-protocol WS; the usual
  // paths are tried in order. First message that looks like a battle frame
  // (`>battle-...` or `|init|battle`) wins.
  wsPaths: ['/showdown/websocket', '/ws', '/socket'],
  // Auth: sent as `Authorization: Bearer <token>` on HTTP and as a Cookie on
  // WS. Get the token by signing in via browser, then copy it from DevTools
  // (Application -> Cookies/LocalStorage) into KOTH_TOKEN (or KOTH_COOKIE).
  authHeader: (token) => ({Authorization: `Bearer ${token}`}),
};
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class KothHttp {
  constructor(server, token) {
    this.server = server.replace(/\/$/, '');
    this.token = token;
  }
  async req(method, path, body) {
    const res = await fetch(this.server + path, {
      method,
      headers: {'Content-Type': 'application/json', ...PROTOCOL.authHeader(this.token)},
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
      if (last.status !== 404) return {path, ...last};
    }
    return {path: attempts[attempts.length - 1][1], ...last};
  }
  fetchConfig() { return this.req('GET', PROTOCOL.configPath); }
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
// High-level client: config -> roster -> queue -> battle loop.
// Seat delivery (TODO): polls `seatPoll` until overridden with the real channel.
// ---------------------------------------------------------------------------
export class KothClient {
  constructor({server, token, log = console.log}) {
    this.http = new KothHttp(server, token);
    this.server = server;
    this.token = token;
    this.log = log;
    this.formatId = null;
    this.config = null;
    this.myName = null;
    this.stopped = false;
  }

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

  async ensureRoster() {
    const {path, status, json, text} = await this.http.setRoster(this.formatId);
    if (status >= 200 && status < 300) {
      this.log(`roster accepted for ${this.formatId} via ${path}`);
      return true;
    }
    this.log(`roster submit failed (${path} -> http ${status}): ${(text || '').slice(0, 200)}`);
    if (json && json.error) this.log(`server says: ${JSON.stringify(json.error).slice(0, 300)}`);
    return false;
  }

  // TODO(user): replace with the real seat channel once known (WS lobby message
  // or HTTP poll). Default: poll config + join queue, then wait for `onSeat`.
  // `onSeat` receives {room, wsUrl, side?} — override via `client.findSeat`.
  async findSeat() {
    const jq = await this.http.joinQueue();
    this.log(`queue join: ${jq.path} -> http ${jq.status}`);
    // Default behavior: block forever; main.js overrides this in practice once
    // the seat channel is known. We poll config meanwhile to track wipes.
    for (;;) {
      if (this.stopped) return null;
      await sleep(5000);
      try { await this.refreshConfig(); } catch { /* offline, keep waiting */ }
    }
  }

  connectBattleWs(wsUrl) {
    const headers = {};
    if (this.token) headers.Cookie = `token=${this.token}`;
    if (process.env.KOTH_COOKIE) headers.Cookie = process.env.KOTH_COOKIE;
    return new WebSocket(wsUrl, {headers});
  }

  // Play one battle on an already-open WS. Resolves 'win'|'loss'|'tie'.
  playBattle(ws, roomHint = null) {
    const session = new BattleSession({
      formatId: this.formatId,
      log: (m) => this.log(`[battle] ${m}`),
    });
    if (this.myName) session.setIdentity(this.myName);
    if (roomHint) session.room = roomHint;
    session._emit = (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    };
    ws.on('message', (data) => {
      const frame = String(data);
      // Lobby-level noise we can safely ignore but should surface once.
      if (frame.startsWith('|popup|') || frame.startsWith('|updatechallenges|')) {
        this.log(`[lobby] ${frame.slice(0, 200)}`);
        return;
      }
      session.onServer(frame);
    });
    // Standard battle openers once the socket is live.
    ws.on('open', () => {
      if (roomHint) ws.send(`${roomHint}|/timer on`);
      else session.send('/timer on');
    });
    ws.on('close', () => session.finish('tie'));
    ws.on('error', (e) => this.log(`[battle] ws error: ${e.message}`));
    return session.resultPromise;
  }

  stop() {
    this.stopped = true;
  }
}
