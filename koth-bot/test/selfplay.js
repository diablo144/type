// Self-play harness: BattleAI (p1) vs random driver (p2) across formats.
// Usage: node test/selfplay.js [gamesPerFormat] [formatId...]
import {BattleStreams, Teams} from '@pkmn/sim';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BattleAI} from '../src/ai.js';
import {Tracker, slotMonFainted} from '../src/tracker.js';
import {formatMeta, getPackedTeam} from '../teams/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMS_DIR = path.join(__dirname, '..', 'teams');

const FORMATS = [
  {id: 'gen9ou'},
  {id: 'gen6vgc2015'},
  {id: 'gen9doublesou'},
  {id: 'gen1ou'},
  {id: 'gen4ou'},
  {id: 'gen9ubers'},
  {id: 'gen3ou'},
  {id: 'gen2ou'},
  {id: 'gen5ou'},
  {id: 'gen6ou'},
  {id: 'gen7ou'},
  {id: 'gen7doublesou'},
  {id: 'gen8ou'},
  {id: 'gen8doublesou'},
  {id: 'gen8nationaldex'},
  {id: 'gen9nationaldex'},
  {id: 'gen9uu'},
  {id: 'gen9lc'},
  {id: 'gen9anythinggoes'},
  {id: 'gen91v1'},
  {id: 'gen92v2doubles'},
];
const DEFAULT_GAMES = 2;

// --- random driver for p2 ---
function randomChoice(req, doubles) {
  if (!req || req.wait || req.requestType === 'wait') return null; // wait-request: send nothing
  if (doubles === undefined) doubles = (req.active || []).length > 1;
  if (req.teamPreview) {
    const n = (req.side.pokemon || []).length;
    const k = req.maxChosenTeamSize || (doubles ? n : 1);
    const idx = [...Array(n).keys()];
    // shuffle
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return `team ${idx.slice(0, k).map(i => i + 1).join(', ')}`;
  }
  const active = req.active || [];
  const hasActive = Array.isArray(req.active);
  const forceSwitch = Array.isArray(req.forceSwitch) ? req.forceSwitch : (req.forceSwitch ? [true] : []);
  const n = hasActive ? Math.max(active.length, forceSwitch.length, 1) : Math.max(forceSwitch.length, 1);
  const mons = (req.side && req.side.pokemon) || [];
  const usedBench = new Set();
  const freeBench = () => {
    const bench = [];
    mons.forEach((m, j) => {
      if (!usedBench.has(j) && !/0 fnt/.test(m.condition || '') && !m.active) bench.push(j);
    });
    return bench;
  };
  const parts = [];
  const omittable = [];
  for (let slot = 0; slot < n; slot++) {
    const a = active[slot];
    if (!hasActive && !forceSwitch[slot]) { parts.push('pass'); omittable.push(true); continue; }
    omittable.push(false);
    if (forceSwitch[slot] || !a || !a.moves) {
      const bench = freeBench();
      if (!bench.length) { parts.push('pass'); continue; }
      const pick = bench[Math.floor(Math.random() * bench.length)];
      usedBench.add(pick);
      parts.push(`switch ${pick + 1}`);
      continue;
    }
    if (!a.moves.length) { parts.push('pass'); continue; }
    if (slotMonFainted(req, slot)) { parts.push('pass'); continue; } // dead slot: actions illegal
    const usable = a.moves.map((m, i) => ({m, i})).filter(({m}) => !m.disabled && m.pp !== 0); // pp absent (gen1 Fight, locked moves) = must pick it
    // 12% random switch
    const bench = freeBench();
    if (bench.length && Math.random() < 0.12 && !a.trapped && !a.maybeTrapped) {
      const pick = bench[Math.floor(Math.random() * bench.length)];
      usedBench.add(pick);
      parts.push(`switch ${pick + 1}`);
      continue;
    }
    if (!usable.length) { parts.push('pass'); continue; }
    const {m, i} = usable[Math.floor(Math.random() * usable.length)];
    let s = `move ${i + 1}`;
    if (doubles) {
      const tk = m.target || '';
      if (tk === 'normal' || tk === 'any') s += Math.random() < 0.5 ? ' 1' : ' 2';
      else if (tk === 'adjacentAlly' || tk === 'adjacentAllyOrSelf') s += slot === 0 ? ' -2' : ' -1';
    }
    if (a.canMegaEvo && Math.random() < 0.8) s += ' mega';
    if (a.canTerastallize && Math.random() < 0.15) s += ' terastallize';
    if (a.canDynamax && Math.random() < 0.15) s += ' dynamax';
    if (Array.isArray(a.canZMove) && a.canZMove[i] && Math.random() < 0.3) s += ' zmove';
    parts.push(s);
  }
  while (parts.length > 1 && omittable[parts.length - 1]) { parts.pop(); omittable.pop(); }
  return parts.length ? (doubles ? parts.join(', ') : parts[0]) : 'pass';
}

function splitRequest(chunk) {
  const idx = chunk.indexOf('|request|');
  if (idx < 0) return {log: chunk, req: null};
  return {log: chunk.slice(0, idx), req: JSON.parse(chunk.slice(idx + '|request|'.length))};
}

async function playGame(formatId, gameNum, verbose) {
  const meta = formatMeta(formatId);
  const team = getPackedTeam(formatId);
  const gen = meta.gen;
  const gameType = meta.gameType;
  const defaultLevel = meta.defaultLevel;
  const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
  const ai = new BattleAI({formatId, gen, gameType, defaultLevel});
  const tracker = new Tracker('p1');

  streams.omniscient.write(`>start {"formatid": "${formatId}"}`);
  streams.omniscient.write(`>player p1 {"team": "${team.replace(/"/g, '\\"')}"}`);
  streams.omniscient.write(`>player p2 {"team": "${team.replace(/"/g, '\\"')}"}`);

  let buf1 = '', buf2 = '', bufO = '';
  let turns = 0, aiErrors = 0, aiExceptions = 0, randErrors = 0;
  let lastReq1 = null, lastReq2 = null;
  let winner = '';
  const rejected1 = new Set();
  const t0 = Date.now();
  const TIMEOUT_MS = 120000;

  // prime reads
  const pending = {p1: streams.p1.read(), p2: streams.p2.read(), omni: streams.omniscient.read()};
  const NEVER = new Promise(() => {});
  const dead = {p1: false, p2: false, omni: false};
  const parseWin = (chunk) => {
    const m = /\|win\|([^\n]*)/.exec(chunk) || /\|tie\|([^\n]*)/.exec(chunk);
    if (!m) return null;
    const who = m[1].trim().toLowerCase();
    return who.includes('1') ? 'Player 1' : who.includes('2') ? 'Player 2' : 'tie';
  };
  let iters = 0;
  const lastChunk = {p1: '', p2: '', omni: ''};
  const spinCount = {p1: 0, p2: 0, omni: 0};
  while (Date.now() - t0 < TIMEOUT_MS) {
    if (++iters > 30000) {
      winner = winner || 'iter-cap';
      if (verbose) console.log(`  [${formatId} g${gameNum}] SPIN p1x${spinCount.p1} p2x${spinCount.p2} omnIx${spinCount.omni} lastP1=${JSON.stringify(lastChunk.p1.slice(0, 120))} lastP2=${JSON.stringify(lastChunk.p2.slice(0, 120))} lastOmni=${JSON.stringify(lastChunk.omni.slice(0, 120))}\n  OMNI-TAIL: ${JSON.stringify(bufO.slice(-1800))}`);
      break;
    }
    if (dead.p1 && dead.p2 && dead.omni) { winner = winner || 'streams-ended'; break; }
    const raced = await Promise.race([
      dead.p1 ? NEVER : pending.p1.then(c => ({s: 'p1', c})),
      dead.p2 ? NEVER : pending.p2.then(c => ({s: 'p2', c})),
      dead.omni ? NEVER : pending.omni.then(c => ({s: 'omni', c})),
    ]);
    spinCount[raced.s]++;
    lastChunk[raced.s] = typeof raced.c === 'string' ? raced.c : String(raced.c);
    if (raced.c === '') { // ended stream: read() resolves immediately; exclude or it starves the race
      dead[raced.s] = true;
      continue;
    }
    const w = parseWin(raced.c);
    if (w) { winner = w; break; }
    if (raced.s === 'p1') {
      pending.p1 = streams.p1.read();
      buf1 += raced.c;
      // choice errors?
      if (buf1.includes('|error|')) {
        // an error chunk may also carry a fresh request — don't drop it
        if (buf1.includes('|request|')) {
          const both = splitRequest(buf1);
          tracker.feed(both.log);
          lastReq1 = both.req;
          buf1 = '|error|';
        }
        aiErrors++;
        const m = /\[Invalid choice\][^\n]*/.exec(buf1);
        if (verbose) console.log(`  [${formatId} g${gameNum}] AI choice error: ${m ? m[0] : '(unknown)'}`);
        rejected1.add(ai.lastChoice);
        if (process.env.REQ) console.log(`  [${formatId} g${gameNum}] REJ '${ai.lastChoice}' size=${rejected1.size}`);
        buf1 = '';
        // re-decide with last request
        try {
          const dec = ai.decide(lastReq1, tracker, rejected1);
          if (dec.choiceString) streams.p1.write(dec.choiceString);
        } catch (e) {
          aiExceptions++;
          streams.p1.write('default');
        }
        continue;
      }
      if (buf1.includes('|request|')) {
        const {log, req} = splitRequest(buf1);
        buf1 = '';
        tracker.feed(log);
        lastReq1 = req;
        rejected1.clear();
        if (process.env.REQ) {
          const side = (req.side.pokemon || []).map(m => `${m.ident.split(': ')[1]}:${m.condition}${m.active ? '*' : ''}`).join(' ');
          const acts = req.teamPreview ? 'PREVIEW' : req.wait ? 'WAIT' : (req.active || []).map(a => (a.moves || []).map(m => `${m.id}(${m.target || '?'})`).join('/') || '?').join(' | ');
          console.log(`  [${formatId} g${gameNum}] P1REQ act=[${acts}] force=${JSON.stringify(req.forceSwitch)} side={${side}}`);
        }
        try {
          const t = Date.now();
          const dec = ai.decide(req, tracker, rejected1);
          const ms = Date.now() - t;
          if (verbose && ms > 500) console.log(`  [${formatId} g${gameNum}] slow decide: ${ms}ms`);
          if (dec.choiceString) {
            if (verbose) console.log(`  [${formatId} g${gameNum}] AI: ${dec.choiceString}`);
            ai.lastChoice = dec.choiceString;
            streams.p1.write(dec.choiceString);
          }
        } catch (e) {
          aiExceptions++;
          console.log(`  [${formatId} g${gameNum}] AI EXCEPTION: ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
          streams.p1.write('default');
        }
      }
    } else if (raced.s === 'p2') {
      pending.p2 = streams.p2.read();
      buf2 += raced.c;
      if (buf2.includes('|error|')) {
        randErrors++;
        if (verbose && randErrors < 4) {
          const m = /\[Invalid choice\][^\n]*/.exec(buf2);
          console.log(`  [${formatId} g${gameNum}] P2 error: ${m ? m[0] : '(unknown)'} lastReq=${lastReq2 ? JSON.stringify(lastReq2).slice(0, 2000) : 'null'}`);
        }
        if (buf2.includes('|request|')) {
          const both = splitRequest(buf2);
          lastReq2 = both.req;
          buf2 = '|error|';
        }
        buf2 = '';
        try {
          const c = randomChoice(lastReq2, gameType === 'doubles');
          if (verbose) console.log(`  [${formatId} g${gameNum}] P2(rec): ${c}`);
          if (c) streams.p2.write(c);
        } catch { streams.p2.write('default'); }
        continue;
      }
      if (buf2.includes('|request|')) {
        const {log, req} = splitRequest(buf2);
        buf2 = '';
        lastReq2 = req;
        if (process.env.REQ) {
          const side = (req.side.pokemon || []).map(m => `${m.ident.split(': ')[1]}:${m.condition}${m.active ? '*' : ''}`).join(' ');
          const acts = (req.active || []).map(a => (a.moves || []).map(m => m.id).join('/') || '?').join(' | ');
          console.log(`  [${formatId} g${gameNum}] P2REQ act=[${acts}] force=${JSON.stringify(req.forceSwitch)} wait=${!!req.wait} side={${side}}`);
        }
        try {
          const c = randomChoice(req, gameType === 'doubles');
          if (verbose) console.log(`  [${formatId} g${gameNum}] P2: ${c}`);
          if (c) streams.p2.write(c);
        } catch { streams.p2.write('default'); }
      }
    } else {
      pending.omni = streams.omniscient.read();
      bufO += raced.c;
      const tm = /\|turn\|(\d+)/g;
      let m;
      while ((m = tm.exec(raced.c))) turns = Math.max(turns, parseInt(m[1], 10));
      if (/\|win\|/.test(raced.c)) {
        const w = /\|win\|([^\n|]*)/.exec(raced.c);
        winner = (w && w[1].trim()) || 'unknown';
        break;
      }
      if (/\|tie\|/.test(raced.c)) {
        winner = 'tie';
        break;
      }
      if (turns >= 150) {
        winner = 'turncap-draw';
        break;
      }
      if (bufO.length > 200000) bufO = bufO.slice(-50000);
    }
  }

  try { streams.omniscient.write('>forfeit p1'); } catch { /* ignore */ }
  // destroy streams to free
  try { streams.p1.destroy(); streams.p2.destroy(); streams.omniscient.destroy(); } catch { /* ignore */ }
  return {formatId, gameNum, winner, turns, aiErrors, aiExceptions, randErrors, ms: Date.now() - t0};
}

async function main() {
  const args = process.argv.slice(2);
  let gamesOverride = 0;
  const only = new Set();
  for (const a of args) {
    if (/^\d+$/.test(a)) gamesOverride = parseInt(a, 10);
    else only.add(a);
  }
  const verbose = !!process.env.VERBOSE;
  const results = {};
  for (const f of FORMATS) {
    if (only.size && ![...only].some(o => f.id.includes(o))) continue;
    const games = gamesOverride || f.games || DEFAULT_GAMES;
    results[f.id] = {w: 0, l: 0, d: 0, aiErrors: 0, aiExceptions: 0, turns: 0, ms: 0};
    for (let g = 1; g <= games; g++) {
      const r = await playGame(f.id, g, verbose);
      const R = results[f.id];
      if (r.winner === 'Player 1') R.w++;
      else if (r.winner === 'Player 2') R.l++;
      else R.d++;
      R.aiErrors += r.aiErrors;
      R.aiExceptions += r.aiExceptions;
      R.turns += r.turns;
      R.ms += r.ms;
      console.log(`${f.id} game ${g}: ${r.winner} (${r.turns} turns, aiErrors=${r.aiErrors}, randErrors=${r.randErrors}, aiExceptions=${r.aiExceptions}, ${r.ms}ms)`);
    }
  }
  console.log('\n=== SUMMARY (AI = Player 1) ===');
  for (const [id, R] of Object.entries(results)) {
    console.log(`${id}: ${R.w}W-${R.l}L-${R.d}D  aiErrors=${R.aiErrors} aiExceptions=${R.aiExceptions} avgTurns=${(R.turns / Math.max(1, R.w + R.l + R.d)).toFixed(0)}`);
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
