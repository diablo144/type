// KOTH bot client: HTTP lobby + battle socket + Showdown-protocol battle driver.
//
// REVERSED FROM THE SHIPPED WEB CLIENT (SolidJS bundle
// /assets/index-RInX2HYp.js, read in full on 2026-09-19). Every route, method,
// message shape and poll interval below is confirmed client behavior; the bot
// mirrors the browser exactly (same endpoints, same 1.5s lobby poll).
//
// Auth: session cookie from browser sign-in (rCTF OAuth) + an `Origin` header
// on every request (missing origin -> `invalid_origin`). All HTTP is JSON;
// errors are `{error: "snake_case", problems?: [...]}` with non-2xx status.
//
// Endpoints:
//   GET  /api/config            public. {devAuth, rctfEnabled, formatId,
//                               formatName, formats[], eloStart, acceptSeconds,
//                               reconnectSeconds, turnSeconds, nowMs,
//                               gameType?, minTeamSize?, maxTeamSize?}
//   GET  /api/me                {name, elo, occupancy, hasTeam, exportText,
//                               gamesPlayed, queue, admin, formatId,
//                               formatName, gameType?, minTeamSize?,
//                               maxTeamSize?, nowMs}
//   GET  /api/queue             authoritative lobby state: {occupancy:
//                               idle|queued|accepting|in_match, queueExpiresAt?,
//                               nowMs, match?: {id, status, you: p1|p2,
//                               opponent, accepted, opponentAccepted,
//                               acceptDeadlineMs}}
//   PUT  /api/team              {exportText} (Showdown export text; only while
//                               idle) -> {exportText}; rejects illegal rosters
//                               with {error, problems[]}
//   POST   /api/queue           join (needs a saved roster + idle)
//   DELETE /api/queue           leave
//   POST /api/matches/{id}/accept | POST .../reject  -> queue state
//   GET  /api/matches/{id}      full battle snapshot (also the re-sync
//                               primitive after a socket drop). 409 = the match
//                               was cancelled or still needs acceptance.
//   GET  /api/ladder            {teams: [{name, elo, gamesPlayed, occupancy,
//                               hidden}]}
//   POST /auth/logout
//
// Battle socket: WS /ws/battle/{id} (Cookie + Origin headers; the browser uses
// no subprotocols when devAuth is off, as on prod).
//   C->S: {type:"choose", choice, requestId} | {type:"forfeit"}
//   S->C: {type:"snapshot", you, opponent, status: pending_connect|active|done,
//          field, log[], logOffset, request|null, requestId, choiceSubmitted,
//          deadlineMs, nowMs, connections, disconnectDeadlines,
//          result?: {winner: p1|p2|draw, endReason, eloAfter}}
//        | {type:"error", error}
// `request` is a RAW @pkmn/sim request (side/active/forceSwitch/teamPreview/
// wait/maxChosenTeamSize); `log` lines are RAW Showdown protocol lines.
// Choice strings are Showdown-style with two canonicalizations the web client
// applies (see canonicalizeChoice):
//   - team preview: "team 123456" (digits only, no separators)
//   - doubles targets carry an explicit sign: "move 1 +2", "move 1 -1"
// Slots join with ", " exactly like a Showdown "/choose" payload (minus the
// "/choose" prefix). The web client only ever emits the "terastallize"
// gimmick; mega/ultra/zmove/dynamax suffixes are unproven against the server,
// so the bot tries them once (the AI genuinely wants them) and strips them on
// the first {type:"error"} for that request.
import WebSocket from 'ws';
import {BattleAI} from './ai.js';
import {Tracker} from './tracker.js';
import {formatMeta, getRosterExport} from '../teams/index.js';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Choice canonicalization (bot PS-style -> KOTH wire format)
// ---------------------------------------------------------------------------

// "team 1, 2, 3" -> "team 123"; "move 1 2" -> "move 1 +2"; everything else
// (switch/pass/tera suffixes) passes through untouched.
export function canonicalizeChoice(s) {
  const team = /^\s*team\s+([\d,\s]+)\s*$/.exec(s);
  if (team) return `team ${team[1].replace(/\D/g, '')}`;
  return String(s).split(',').map(part => {
    const p = part.trim();
    const m = /^move (\d+)\s+([+-]?\d+)(.*)$/.exec(p);
    if (m) {
      const loc = parseInt(m[2], 10);
      return `move ${m[1]} ${loc > 0 ? `+${loc}` : loc}${m[3]}`;
    }
    return p;
  }).join(', ');
}

// Strip unproven gimmick suffixes after a server {type:"error"}.
// "terastallize" is proven (the web client sends it) and is kept by default.
export function stripGimmicks(s, keep = ['terastallize']) {
  return String(s).split(',').map(part => {
    let p = part.trim();
    for (const g of ['mega', 'ultra', 'zmove', 'dynamax', 'terastallize']) {
      if (keep.includes(g)) continue;
      p = p.replace(new RegExp(`\\s+${g}$`), '');
    }
    return p;
  }).join(', ');
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class KothError extends Error {
  constructor(status, error, problems = []) {
    super(`${error} (http ${status})`);
    this.status = status;
    this.error = error;
    this.problems = problems;
  }
}

export class KothHttp {
  constructor(server, cookie) {
    this.server = server.replace(/\/$/, '');
    this.cookie = cookie;
  }
  headers() {
    return {
      'Content-Type': 'application/json',
      Origin: this.server, // required: the server gates on Origin
      Cookie: this.cookie,
    };
  }
  async req(method, path, body, {signal} = {}) {
    const res = await fetch(this.server + path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    if (!res.ok) {
      const err = (json && typeof json.error === 'string') ? json.error : `request_failed`;
      const problems = (json && Array.isArray(json.problems))
        ? json.problems.filter(p => typeof p === 'string') : [];
      throw new KothError(res.status, err, problems);
    }
    return json;
  }
  config() { return this.req('GET', '/api/config'); }
  me() { return this.req('GET', '/api/me'); }
  queueState() { return this.req('GET', '/api/queue'); }
  saveTeam(exportText) { return this.req('PUT', '/api/team', {exportText}); }
  joinQueue() { return this.req('POST', '/api/queue'); }
  leaveQueue() { return this.req('DELETE', '/api/queue'); }
  acceptMatch(id) { return this.req('POST', `/api/matches/${encodeURIComponent(id)}/accept`); }
  rejectMatch(id) { return this.req('POST', `/api/matches/${encodeURIComponent(id)}/reject`); }
  matchSnapshot(id, opts) { return this.req('GET', `/api/matches/${encodeURIComponent(id)}`, undefined, opts); }
  ladder() { return this.req('GET', '/api/ladder'); }
  logout() { return this.req('POST', '/auth/logout'); }
}

// ---------------------------------------------------------------------------
// Showdown-protocol battle session (transport-agnostic).
// Server frames are fed to `onServer()` as full strings; choices leave via
// `emit()` (wired by the owner). Resolves with 'win' | 'loss' | 'tie'.
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

  onServer(frame) {
    if (this.done) return;
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
    const win = /\|win\|([^\n|]*)/.exec(chunk) || /\|tie\|([^\n]*)/.exec(chunk);
    if (win) {
      const who = (win[1] || '').trim().toLowerCase();
      let result = 'tie';
      if (/\|win\|/.test(chunk)) {
        const myName = (this.myName || '').trim().toLowerCase();
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

    const pl = /\|player\|(p[12])\|([^\n|]*)/.exec(chunk);
    if (pl && this.myName && pl[2].trim() === this.myName) {
      this.mySide = pl[1];
      if (!this.tracker) this.tracker = new Tracker(this.mySide);
    }

    if (chunk.startsWith('|error|')) {
      this.errors++;
      const m = /\[Invalid choice\][^\n]*/.exec(chunk);
      this.log(`choice error (${this.errors}): ${m ? m[0] : chunk.slice(0, 120)}`);
      this.rejected.add(this.ai.lastChoice);
      this.answer(this.lastReq, true);
      return;
    }

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

    if (this.tracker && chunk.startsWith('|')) this.tracker.feed(chunk + '\n');
  }

  setIdentity(name) {
    this.myName = name;
  }

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
    this.ai.lastChoice = dec.choiceString;
    this.send(`/choose ${dec.choiceString}`);
  }

  send(text) {
    if (this.done) return;
    if (this.room) this.emit(`${this.room}|${text}`);
    else this.emit(text);
  }

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
// KOTH battle adapter: snapshots in, {type:"choose"} out.
// `send(choice, requestId)` is wired by the owner to the socket. It must
// return false ONLY when the payload definitely did not go out (dead socket);
// any other return value (including undefined) counts the request as answered,
// which is what lets a re-delivered snapshot re-trigger a lost send.
// ---------------------------------------------------------------------------
export class KothBattle {
  constructor({formatId, mySide, myName, send, log = () => {}}) {
    this.session = new BattleSession({formatId, mySide, log});
    this.session.setIdentity(myName);
    this.log = log;
    this._send = send;
    this.session._emit = (text) => {
      const m = /\/choose (.+)$/s.exec(text);
      if (!m) return; // drop non-choices (e.g. /timer)
      this.sendChoice(m[1]);
    };
    this.fedLines = 0;        // absolute log lines fed to the session so far
    this.lastRequestId = null;
    this.lastReqWasWait = false;
    this.answeredRequestId = null;
    this.strippedFor = new Set(); // requestIds already retried gimmick-free
    this.done = false;
    this.result = null;
    this._resolve = null;
    this.resultPromise = new Promise(r => { this._resolve = r; });
  }

  sendChoice(choice) {
    if (this.done || this.lastRequestId === null) return;
    this.session.ai.lastChoice = choice;
    if (this._send(canonicalizeChoice(choice), this.lastRequestId) !== false) {
      this.answeredRequestId = this.lastRequestId;
    }
  }

  // Feed one {type:"snapshot"}. Returns 'done' | 'new-request' | 'waiting'.
  onSnapshot(snap) {
    if (this.done) return 'done';
    if (snap.status === 'done') {
      // Drain any trailing log first (turn counts, tracker state).
      this.feedLog(snap);
      let result = 'tie';
      if (snap.result && snap.result.winner) {
        const w = snap.result.winner;
        // Envelope authority wins over the log. Anything that is neither our
        // side nor a concrete p1/p2 ('draw', 'tie', ...) counts as a tie.
        result = w === snap.you ? 'win' : (w === 'p1' || w === 'p2') ? 'loss' : 'tie';
      }
      if (snap.result) {
        this.log(`result: winner=${snap.result.winner} reason=${snap.result.endReason} eloAfter=${snap.result.eloAfter}`);
      }
      this.finish(result);
      return 'done';
    }
    this.feedLog(snap);
    if (this.session.done) {
      // The log already contained |win|/|tie| (belt and braces).
      this.finish('tie');
      return 'done';
    }
    const req = snap.request;
    // New decision point: unseen requestId; OR a wait->real transition reusing
    // the same id; OR a re-delivered pre-submission snapshot for a request we
    // never managed to answer (a socket drop between snapshots can lose our
    // send while the server keeps waiting on us — answering again is the only
    // way out).
    const isNew = req && snap.requestId !== this.lastRequestId;
    const waitToReal = req && !req.wait && snap.requestId === this.lastRequestId && this.lastReqWasWait;
    const unanswered = req && !req.wait && snap.requestId !== this.answeredRequestId;
    if (req && !snap.choiceSubmitted && (isNew || waitToReal || unanswered)) {
      this.lastRequestId = snap.requestId;
      this.lastReqWasWait = !!req.wait;
      this.session.onChunk(`|request|${JSON.stringify(req)}`);
      return 'new-request';
    }
    if (req) this.lastReqWasWait = !!req.wait;
    return 'waiting';
  }

  feedLog(snap) {
    const start = snap.logOffset || 0;
    const lines = snap.log || [];
    const fresh = lines.slice(Math.max(0, this.fedLines - start));
    for (const line of fresh) {
      if (!line || line.includes('|request|')) continue;
      this.session.onChunk(line);
      if (this.session.done) break;
    }
    this.fedLines = start + lines.length;
  }

  // Feed one {type:"error", error} from the socket.
  onErrorMessage(msg) {
    if (this.done) return;
    const last = this.session.ai.lastChoice || '';
    // First error for this request with an unproven gimmick: strip and resend
    // the same request immediately (the AI genuinely wants mega/z/dyna, but
    // the server may only speak the web client's vocabulary).
    if (/ (mega|ultra|zmove|dynamax)(,|$)/.test(` ${last}`) && !this.strippedFor.has(this.lastRequestId)) {
      this.strippedFor.add(this.lastRequestId);
      const stripped = stripGimmicks(last);
      this.log(`stripping gimmick after server error, resending: ${stripped}`);
      this.sendChoice(stripped);
      return;
    }
    this.session.onChunk(`|error|[Invalid choice] ${msg}`);
  }

  finish(result) {
    if (this.done) return;
    this.done = true;
    this.result = result;
    this.session.finish(result);
    if (this._resolve) this._resolve(result);
  }
}

// ---------------------------------------------------------------------------
// High-level client: config -> roster -> queue -> accept -> battle -> requeue.
// Mirrors the web client's lobby loop (Le): GET /api/me + GET /api/queue in
// parallel every 1.5s, queue state authoritative for occupancy/match.
// ---------------------------------------------------------------------------
export class KothClient {
  constructor({server, cookie, log = console.log}) {
    this.server = server.replace(/\/$/, '');
    this.http = new KothHttp(this.server, cookie);
    this.log = log;
    this.config = null;
    this.me = null;
    this.queue = null;
    this.sessionFormat = null; // format locked in for the current queue/battle
    this.stopped = false;
  }

  get match() {
    return (this.queue && this.queue.match) || null;
  }

  get occupancy() {
    return (this.queue && this.queue.occupancy) || (this.me && this.me.occupancy) || 'idle';
  }

  async boot() {
    this.config = await this.http.config();
    this.log(`config: format=${this.config.formatId} (${this.config.formatName}) ` +
      `accept=${this.config.acceptSeconds}s turn=${this.config.turnSeconds}s ` +
      `reconnect=${this.config.reconnectSeconds}s eloStart=${this.config.eloStart}`);
    await this.refresh();
    return this.config;
  }

  // Mirror of the web client's Le(): parallel me+queue refresh; detects
  // operator format switches (roster wipe) via me.formatId.
  async refresh() {
    const [me, q] = await Promise.all([this.http.me(), this.http.queueState()]);
    me.occupancy = q.occupancy;
    me.queue = q;
    const prevFormat = this.me ? this.me.formatId : null;
    this.me = me;
    this.queue = q;
    if (this.config && me.formatId && me.formatId !== this.config.formatId) {
      this.log(`FORMAT SWITCH: ${this.config.formatId} -> ${me.formatId} (${me.formatName}); rosters wiped`);
      this.config = {...this.config, formatId: me.formatId, formatName: me.formatName};
    } else if (prevFormat && me.formatId !== prevFormat) {
      this.log(`format now ${me.formatId} (was ${prevFormat})`);
    }
    return me;
  }

  // Ensure a legal roster is saved for the current format. Leaves queue/match
  // first if needed (roster is locked unless idle). Returns true on success.
  async ensureRoster() {
    await this.refresh();
    const fmt = this.config.formatId;
    if (this.me.hasTeam && this.me.formatId === fmt) {
      this.sessionFormat = fmt;
      return true;
    }
    if (this.occupancy !== 'idle') {
      this.log(`leaving ${this.occupancy} to (re)submit roster`);
      await this.http.leaveQueue().catch(() => {});
      await this.refresh();
    }
    const maxSize = this.me.maxTeamSize ?? this.config.maxTeamSize ?? 6;
    const want = Math.max(1, Math.min(6, maxSize));
    const text = getRosterExport(fmt, want);
    this.log(`saving roster for ${fmt} (${want} mons)`);
    try {
      const res = await this.http.saveTeam(text);
      this.log(`roster saved (${(res.exportText || '').length} chars echoed)`);
    } catch (e) {
      this.log(`roster rejected: ${e.error} (http ${e.status})`);
      for (const p of e.problems || []) this.log(`  - ${p}`);
      // If the server complains about size, retry once at its maxTeamSize.
      if (/team.*size|too many|too few/i.test([e.error, ...(e.problems || [])].join(' ')) && want !== maxSize) {
        const retry = getRosterExport(fmt, Math.max(1, Math.min(6, maxSize)));
        this.log(`retrying roster at server maxTeamSize=${maxSize}`);
        try {
          await this.http.saveTeam(retry);
          this.log('roster saved on retry');
        } catch (e2) {
          this.log(`roster rejected again: ${e2.error}`);
          for (const p of e2.problems || []) this.log(`  - ${p}`);
          return false;
        }
      } else {
        return false;
      }
    }
    await this.refresh();
    if (!this.me.hasTeam || this.me.formatId !== fmt) {
      this.log('roster save did not stick (hasTeam/format mismatch)');
      return false;
    }
    this.sessionFormat = fmt;
    return true;
  }

  // Join the queue if idle, then poll until a match reaches pending_connect /
  // active, accepting instantly while it is accepting. Resolves with the
  // match {id, you, ...}. Returns null when stopped.
  async joinAndAccept({pollMs = 1500} = {}) {
    for (;;) {
      if (this.stopped) return null;
      try {
        await this.refresh();
      } catch (e) {
        this.checkAuth(e);
        this.log(`lobby poll failed: ${e.message}; retrying`);
        await sleep(pollMs);
        continue;
      }
      // Format switch or wiped roster mid-queue: resubmit first.
      if (!this.me.hasTeam || this.me.formatId !== this.config.formatId) {
        this.log('roster missing/stale in queue loop; resubmitting');
        if (!await this.ensureRoster()) {
          await sleep(pollMs);
          continue;
        }
      }
      const m = this.match;
      if (!m) {
        if (this.occupancy === 'idle') {
          this.log('joining queue');
          try {
            await this.http.joinQueue();
          } catch (e) {
            this.checkAuth(e);
            this.log(`queue join failed: ${e.message}`);
          }
        } else {
          this.log(`in queue (${this.occupancy})`);
        }
        await sleep(pollMs);
        continue;
      }
      if (m.status === 'accepting') {
        if (!m.accepted) {
          this.log(`match ${m.id} vs ${m.opponent}: accepting`);
          try {
            await this.http.acceptMatch(m.id);
          } catch (e) {
            this.checkAuth(e);
            this.log(`accept failed: ${e.message}`);
          }
        } else {
          this.log(`accepted; waiting on ${m.opponent} (opponentAccepted=${m.opponentAccepted})`);
        }
        await sleep(500); // tight loop inside the accept window
        continue;
      }
      if (m.status === 'pending_connect' || m.status === 'active') {
        this.log(`match ${m.id} ${m.status} vs ${m.opponent} (we are ${m.you})`);
        return m;
      }
      // done/cancelled/expired: loop around (refresh will show idle/queued).
      this.log(`match ${m.id} went ${m.status}; requeueing`);
      await sleep(pollMs);
    }
  }

  // Play one match to completion. Mirrors the web battle screen (Mu):
  // snapshot GET, then WS; on socket drop, re-GET and reconnect with backoff.
  // Resolves 'win' | 'loss' | 'tie' | 'cancelled'.
  async playMatch(match) {
    const id = match.id;
    let snap;
    try {
      snap = await this.http.matchSnapshot(id);
    } catch (e) {
      if (e.status === 409) {
        this.log('match snapshot 409 (cancelled or needs acceptance); requeueing');
        return 'cancelled';
      }
      throw e;
    }
    const formatId = this.sessionFormat || this.config.formatId;
    const wsUrl = `${this.server.replace(/^http/, 'ws')}/ws/battle/${encodeURIComponent(id)}`;
    this.log(`opening battle socket ${wsUrl} as ${snap.you || match.you}`);

    return new Promise((resolve, reject) => {
      let ws = null;
      let closed = false;
      let backoffFails = 0;
      const battle = new KothBattle({
        formatId,
        mySide: snap.you || match.you,
        myName: this.me.name,
        send: (choice, requestId) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({type: 'choose', choice, requestId}));
            return true;
          }
          this.log('choice dropped: socket not open');
          return false;
        },
        log: (m) => this.log(`[battle] ${m}`),
      });
      battle.resultPromise.then((r) => {
        closed = true;
        try { if (ws) ws.close(); } catch { /* ignore */ }
        resolve(r);
      });

      const onSnapshotMsg = (s) => {
        backoffFails = 0;
        const st = battle.onSnapshot(s);
        if (st === 'new-request') this.log(`[battle] answered request ${s.requestId}`);
      };

      const openSocket = () => {
        if (closed || this.stopped) return;
        this.log('[battle] connecting socket');
        ws = new WebSocket(wsUrl, {
          headers: {Origin: this.server, Cookie: this.http.cookie},
        });
        ws.on('open', () => this.log('[battle] socket open'));
        ws.on('message', (data) => {
          let msg;
          try {
            msg = JSON.parse(String(data));
          } catch (e) {
            this.log(`[battle] bad socket JSON: ${e.message}`);
            return;
          }
          if (msg && msg.type === 'error') {
            this.log(`[battle] server error: ${msg.error}`);
            battle.onErrorMessage(msg.error);
            return;
          }
          onSnapshotMsg(msg);
        });
        ws.on('error', (e) => this.log(`[battle] socket error: ${e.message}`));
        ws.on('close', () => {
          ws = null;
          if (closed || battle.done) return;
          this.resync(openSocket, battle, onSnapshotMsg, id, () => closed)
            .catch((e) => {
              if (!closed) {
                closed = true;
                reject(e);
              }
            });
        });
      };

      // Prime from the HTTP snapshot, then connect (browser order: GET, then WS).
      onSnapshotMsg(snap);
      if (battle.done) return; // already decided (e.g. walkover)
      openSocket();
    });
  }

  // Re-sync after a socket drop: re-GET the snapshot (source of truth), then
  // reconnect with 500ms * 2^fails backoff capped at 5s (browser behavior).
  // Gives up after 10 consecutive failures (~35s, past the 30s grace).
  async resync(reopen, battle, onSnapshotMsg, id, isClosed) {
    for (;;) {
      if (isClosed() || battle.done || this.stopped) return;
      try {
        const snap = await this.http.matchSnapshot(id);
        onSnapshotMsg(snap);
        if (battle.done) return;
        reopen();
        return;
      } catch (e) {
        this.checkAuth(e);
        this.log(`[battle] resync failed: ${e.message}`);
      }
      battle._resyncFails = (battle._resyncFails || 0) + 1;
      if (battle._resyncFails >= 10) throw new Error('resync gave up after 10 failures');
      const wait = Math.min(500 * 2 ** Math.min(battle._resyncFails, 4), 5000);
      this.log(`[battle] reconnecting in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  checkAuth(e) {
    if (e && (e.status === 401 || e.error === 'invalid_session' || e.error === 'banned')) {
      throw new KothError(e.status || 401, e.error || 'invalid_session', ['auth lost; re-sign-in and refresh KOTH_COOKIE']);
    }
  }

  stop() {
    this.stopped = true;
  }
}
