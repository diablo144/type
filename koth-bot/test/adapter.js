// KOTH adapter tests: wire canonicalization + snapshot driver vs live @pkmn/sim.
//
// The sim consumes our KOTH wire choices VERBATIM (verified against
// node_modules/@pkmn/sim side.choose(): signed +N/-N target locs, terastal,
// mega/zmove/dynamax/ultra suffixes all parse), so these drills are a
// full-fidelity proof of the bot's battle loop: snapshot in, wire out.
//
// Usage:
//   node test/adapter.js              # everything (~30s)
//   node test/adapter.js units        # canonicalizer + error-retry only
import assert from 'node:assert/strict';
import { BattleStreams } from '@pkmn/sim';
import {
  KothBattle,
  canonicalizeChoice,
  stripGimmicks,
} from '../src/koth-client.js';
import { getPackedTeam } from '../teams/index.js';

// ---------------------------------------------------------------------------
// 1. Canonicalizer units: AI strings -> KOTH wire format
// ---------------------------------------------------------------------------
function testUnits() {
  // team preview: comma list -> digit string
  assert.equal(canonicalizeChoice('team 1, 2, 3'), 'team 123');
  assert.equal(canonicalizeChoice('team 1,4, 2'), 'team 142');
  // enemy targets: bare loc -> signed +N (KOTH validator requires the sign)
  assert.equal(canonicalizeChoice('move 1 2'), 'move 1 +2');
  assert.equal(canonicalizeChoice('move 1 2, move 3 1'), 'move 1 +2, move 3 +1');
  // self/ally locs already signed -> untouched
  assert.equal(canonicalizeChoice('move 2 -1 terastallize'), 'move 2 -1 terastallize');
  assert.equal(canonicalizeChoice('move 1 +2 terastallize'), 'move 1 +2 terastallize');
  // no-loc moves, switches, pass, multi-slot joins
  assert.equal(canonicalizeChoice('move 1'), 'move 1');
  assert.equal(canonicalizeChoice('move 1 terastallize'), 'move 1 terastallize');
  assert.equal(canonicalizeChoice('switch 4'), 'switch 4');
  assert.equal(canonicalizeChoice('pass, switch 3'), 'pass, switch 3');
  assert.equal(canonicalizeChoice('pass'), 'pass');
  assert.equal(canonicalizeChoice('default'), 'default');
  assert.equal(canonicalizeChoice('move 2 mega'), 'move 2 mega');
  // gimmick stripping on server rejection
  assert.equal(stripGimmicks('move 1 +2 mega'), 'move 1 +2');
  assert.equal(stripGimmicks('move 1 +2 terastallize'), 'move 1 +2 terastallize');
  assert.equal(stripGimmicks('move 1 dynamax, pass'), 'move 1, pass');
  assert.equal(stripGimmicks('move 1 zmove, move 2 ultra'), 'move 1, move 2');
  assert.equal(stripGimmicks('switch 3'), 'switch 3');
  console.log('units: canonicalize/strip OK');
}

// ---------------------------------------------------------------------------
// 2. Error-retry path (synthetic request, no sim)
// ---------------------------------------------------------------------------
function testErrorRetry() {
  const sent = [];
  const battle = new KothBattle({
    formatId: 'gen7ou',
    mySide: 'p1',
    myName: 'P1',
    send: (choice, requestId) => sent.push([choice, requestId]),
    log: () => {},
  });
  const mon = (n, active, extra = {}) => ({
    ident: `p1: Mon${n}`,
    details: `${active ? 'Charizard' : 'Pidgey'}, L100`,
    condition: '100/100',
    active,
    stats: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
    moves: ['tackle'],
    ability: active ? 'blaze' : 'keeneye',
    item: active ? 'charizarditex' : '',
    ...extra,
  });
  const req = {
    teamPreview: false,
    foeMons: [],
    active: [{
      moves: [{ id: 'tackle', move: 'Tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false }],
      canMegaEvo: true,
    }],
    side: { pokemon: [mon(1, true), mon(2, false), mon(3, false), mon(4, false), mon(5, false), mon(6, false)] },
  };
  battle.onSnapshot({
    type: 'snapshot', you: 'p1', opponent: 'Foe', status: 'active', field: null,
    log: [], logOffset: 0, request: req, requestId: 1, choiceSubmitted: false,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /mega/, 'AI tries mega first');
  assert.equal(sent[0][1], 1);

  battle.onErrorMessage('There was an error with your choice');
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0], 'move 1', 'retry is gimmick-free');
  assert.equal(sent[1][1], 1, 'retry carries the same requestId');

  battle.onSnapshot({ // wait snapshot for the same request must NOT resend
    type: 'snapshot', you: 'p1', opponent: 'Foe', status: 'active', field: null,
    log: [], logOffset: 0,
    request: { wait: true, side: req.side, foeMons: [] },
    requestId: 1, choiceSubmitted: true,
  });
  assert.equal(sent.length, 2, 'no resend after submission');
  console.log('error-retry: mega -> strip -> same-id OK');
}

// ---------------------------------------------------------------------------
// 3. Result + log-dedup handling (synthetic snapshots, no sim)
// ---------------------------------------------------------------------------
async function testDone() {
  for (const [winner, expect] of [['p1', 'win'], ['p2', 'loss'], ['tie', 'tie']]) {
    const battle = new KothBattle({ formatId: 'gen7ou', mySide: 'p1', myName: 'P1', send: () => {}, log: () => {} });
    battle.onSnapshot({
      type: 'snapshot', you: 'p1', opponent: 'Foe', status: 'done', field: null,
      log: ['|win|P1'], logOffset: 5,
      request: null, requestId: 9,
      result: { winner, endReason: 'Test', eloAfter: 1500 },
    });
    const res = await battle.resultPromise;
    assert.equal(res, expect, `winner=${winner} -> ${expect}`);
  }
  // log dedup: overlapping windows feed each line exactly once
  const sess = [];
  const battle = new KothBattle({
    formatId: 'gen7ou', mySide: 'p1', myName: 'P1',
    send: () => {}, log: () => {},
  });
  battle.session.onChunk = (chunk) => sess.push(chunk);
  battle.feedLog({ log: ['|a|1', '|a|2'], logOffset: 5 });
  battle.feedLog({ log: ['|a|1', '|a|2', '|a|3'], logOffset: 5 });
  battle.feedLog({ log: ['|a|3', '|a|4'], logOffset: 7 });
  assert.deepEqual(sess, ['|a|1', '|a|2', '|a|3', '|a|4']);
  console.log('done/dedup: win/loss/tie + log windows OK');
}

// ---------------------------------------------------------------------------
// 4. Live drills: KothBattle drives p1 against sim p2 via KOTH-shaped snapshots
// ---------------------------------------------------------------------------
const WIRE_MOVE = /^move \d+( -?[123]| \+[123])?( (mega|megax|megay|ultra|zmove|dynamax|terastallize))?$/;
const WIRE = /^(team [0-9]+|move \d.*|switch \d+|pass|default|shift)(, (move \d.*|switch \d+|pass|default))?$/;

function assertWire(choice, formatId) {
  assert.match(choice, WIRE, `wire grammar: ${choice}`);
  if (formatId === 'gen6vgc2015' && choice.includes('move')) {
    for (const part of choice.split(', ')) {
      if (part.startsWith('move')) {
        assert.match(part, WIRE_MOVE, `signed loc: ${part}`);
        assert.doesNotMatch(part, /^move \d+ [123]( |$)/, `unsigned foe loc on the wire: ${part}`);
      }
    }
  }
  assert.doesNotMatch(choice, /^\//, 'no /commands on the wire');
}

async function liveDrill(formatId, { maxTurns = 40, wallMs = 45000 } = {}) {
  const team = getPackedTeam(formatId);
  const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
  streams.omniscient.write(`>start {"formatid": "${formatId}"}`);
  streams.omniscient.write(`>player p1 {"team": "${team}"}`);
  streams.omniscient.write(`>player p2 {"team": "${team}"}`);

  const sent = [];   // wire payloads the adapter emitted
  let p1errors = 0;  // sim |error| lines on p1 = wire rejected (must stay 0)
  const battle = new KothBattle({
    formatId,
    mySide: 'p1',
    myName: 'Player 1',
    send: (choice, requestId) => {
      sent.push({ choice, requestId });
      assertWire(choice, formatId);
      streams.p1.write(choice);
    },
    log: () => {},
  });

  const lines = [];  // all p1 log lines so far (absolute offsets)
  let requestId = 0;
  let turns = 0;
  let simWinner = '';
  const pend = { p1: streams.p1.read(), p2: streams.p2.read(), omni: streams.omniscient.read() };
  const NEXT = () => Promise.race([
    pend.p1.then((c) => ({ s: 'p1', c })),
    pend.p2.then((c) => ({ s: 'p2', c })),
    pend.omni.then((c) => ({ s: 'omni', c })),
  ]);
  let p1buf = '';
  let p2buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < wallMs) {
    const { s, c } = await NEXT();
    if (/\|win\|/.test(c)) {
      const name = c.match(/\|win\|([^\n]*)/)[1].trim();
      simWinner = name === 'Player 1' ? 'p1' : name === 'Player 2' ? 'p2' : name;
      break;
    }
    if (/\|tie\|/.test(c)) { simWinner = 'tie'; break; }
    if (s === 'p1') {
      pend.p1 = streams.p1.read();
      p1buf += c;
      const errIdx = p1buf.indexOf('|error|');
      const reqIdx = p1buf.indexOf('|request|');
      if (errIdx >= 0 && (reqIdx < 0 || errIdx < reqIdx)) {
        // The sim rejected our verbatim wire choice.
        p1errors++;
        const msg = p1buf.slice(errIdx).split('\n')[0];
        battle.onErrorMessage(msg.replace('|error|', '').trim());
      }
      if (reqIdx >= 0) {
        const logPart = p1buf.slice(0, reqIdx);
        const reqJson = p1buf.slice(reqIdx + '|request|'.length);
        p1buf = '';
        for (const ln of logPart.split('\n')) if (ln) lines.push(ln);
        let req;
        try { req = JSON.parse(reqJson); } catch { continue; }
        if (req.wait) continue; // wait snapshots carry no decision
        requestId++;
        battle.onSnapshot({
          type: 'snapshot', you: 'p1', opponent: 'Player 2',
          status: 'active', field: null,
          log: [...lines], logOffset: 0,
          request: req, requestId, choiceSubmitted: false,
        });
      }
    } else if (s === 'p2') {
      pend.p2 = streams.p2.read();
      p2buf += c;
      if (p2buf.includes('|request|')) {
        const reqJson = p2buf.slice(p2buf.indexOf('|request|') + '|request|'.length);
        p2buf = '';
        try { if (!JSON.parse(reqJson).wait) streams.p2.write('default'); } catch { /* partial */ }
      } else if (p2buf.includes('|error|')) {
        p2buf = '';
        streams.p2.write('default');
      }
    } else {
      pend.omni = streams.omniscient.read();
      const tm = c.match(/\|turn\|(\d+)/g);
      if (tm) turns = Math.max(turns, ...tm.map((m) => +m.split('|')[2]));
      if (turns >= maxTurns) break;
    }
  }

  // KOTH done snapshot; adapter must resolve from the result envelope.
  const expect = simWinner === 'p1' ? 'win' : simWinner === 'p2' ? 'loss' : simWinner === 'tie' ? 'tie' : null;
  if (expect) {
    battle.onSnapshot({
      type: 'snapshot', you: 'p1', opponent: 'Player 2',
      status: 'done', field: null, log: [...lines], logOffset: 0,
      request: null, requestId, result: { winner: simWinner, endReason: 'Test end', eloAfter: 1500 },
    });
    const res = await battle.resultPromise;
    assert.equal(res, expect, 'result envelope resolves the battle');
  }
  assert.ok(turns > 0 || expect, 'drill advanced the game');
  assert.ok(sent.length > 0, 'adapter sent wire choices');
  assert.equal(p1errors, 0, `sim rejected ${p1errors} wire choice(s)`);
  return { sent: sent.length, turns, result: expect ?? 'turncap' };
}

// ---------------------------------------------------------------------------
const mode = process.argv[2] ?? 'all';
testUnits();
testErrorRetry();
await testDone();
if (mode === 'all') {
  for (const fmt of ['gen9ou', 'gen6vgc2015', 'gen91v1', 'gen1ou']) {
    const r = await liveDrill(fmt);
    console.log(`drill ${fmt}: ${r.sent} wire choices, ${r.turns} turns, ${r.result}, sim-errors 0 OK`);
  }
}
console.log(mode === 'all' ? 'ADAPTER ALL OK' : 'ADAPTER UNITS OK');
