// Lightweight Showdown protocol log tracker.
// Feeds on raw battle log lines and maintains everything request JSON lacks:
// foe team (species/level/hp/status/boosts), field (weather/terrain/trickroom),
// side conditions (hazards/screens/tailwind), revealed foe abilities.

export function toID(s) {
  return ('' + s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Parse "Species, L50, M" / "Species, L50" / "Species" details string.
export function parseDetails(details) {
  const parts = (details || '').split(',').map(s => s.trim());
  const species = parts[0] || '';
  let level = 0; // 0 = unknown (use format default)
  let gender = '';
  for (const p of parts.slice(1)) {
    if (/^L\d+/.test(p)) level = parseInt(p.slice(1), 10) || 0;
    else if (p === 'M' || p === 'F') gender = p;
  }
  return {species, level, gender};
}

// Parse "100/100", "50/120 par", "88/100", "48/48", "0 fnt".
// NOTE: foe HP may be exact, percentage (/100), or 48ths (/48) depending on view.
// We normalize to a fraction; exact numbers only for our own side.
export function parseCondition(condition) {
  if (!condition) return {hp: 0, maxhp: 0, frac: 0, status: '', fainted: true};
  const [hpPart, statusRaw] = condition.split(' ');
  let status = statusRaw || '';
  let fainted = false;
  if (status === 'fnt') {
    fainted = true;
    status = '';
  }
  if (hpPart === '0') return {hp: 0, maxhp: 0, frac: 0, status, fainted: true};
  const nums = hpPart.split('/').map(x => parseInt(x, 10));
  const hp = nums[0] || 0;
  const maxhp = nums[1] || 0;
  if (!maxhp) return {hp: 0, maxhp: 0, frac: 0, status, fainted: true};
  return {hp, maxhp, frac: maxhp > 0 ? hp / maxhp : 0, status, fainted: hp <= 0};
}

// Extract slot owner ("p1"/"p2") and position index from "p1a: Name" / "p1a".
export function parseSlotId(slotStr) {
  const m = /^(p[12])([abc])?/.exec(slotStr || '');
  if (!m) return null;
  return {side: m[1], pos: m[2] ? 'abc'.indexOf(m[2]) : 0};
}

const STAT_IDS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];

function newPoke(species, level, gender) {
  return {
    species, level: level || 0, gender,
    hp: 0, maxhp: 0, frac: 1, status: '', fainted: false, active: false,
    ability: '', item: '', itemConsumed: false, movesSeen: [],
    lastMove: '', activeTurns: 0, teraType: '',
    boosts: {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0},
  };
}

function blankBoosts() {
  return {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0};
}

export class Tracker {
  constructor(mySide = 'p1') {
    this.mySide = mySide; // 'p1' | 'p2'
    this.foeSide = mySide === 'p1' ? 'p2' : 'p1';
    this.reset();
  }

  reset() {
    this.turn = 0;
    this.team = {p1: [], p2: []}; // indexed by team order from |poke|
    this.active = {p1: [], p2: []}; // battle positions -> team index
    this.weather = '';
    this.terrain = '';
    this.trickroom = false;
    this.sides = {
      p1: {hazards: {}, screens: {}, tailwind: false},
      p2: {hazards: {}, screens: {}, tailwind: false},
    };
    this.winner = '';
    this.over = false;
  }

  setMySide(side) {
    this.mySide = side;
    this.foeSide = side === 'p1' ? 'p2' : 'p1';
  }

  myTeam() {
    return this.team[this.mySide];
  }

  foeTeam() {
    return this.team[this.foeSide];
  }

  sideActive(side) {
    const out = [];
    const idxs = this.active[side];
    for (let pos = 0; pos < idxs.length; pos++) {
      const i = idxs[pos];
      if (i !== undefined && i !== null && i >= 0 && this.team[side][i]) {
        out.push({poke: this.team[side][i], pos, index: i});
      }
    }
    return out;
  }

  foeActive() {
    return this.sideActive(this.foeSide);
  }

  // Feed one or more raw protocol lines.
  feed(text) {
    const lines = ('' + text).split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line || line[0] === '>') continue;
      if (line[0] !== '|') continue;
      if (line.startsWith('|request|')) continue;
      try {
        this.handleLine(line.slice(1).split('|'));
      } catch {
        // never crash on parse issues
      }
    }
  }

  findBySlot(slotStr) {
    const parsed = parseSlotId(slotStr);
    if (!parsed) return null;
    const idx = this.active[parsed.side][parsed.pos];
    if (idx === undefined || idx === null || idx < 0) return null;
    const poke = this.team[parsed.side][idx];
    return poke ? {poke, side: parsed.side, pos: parsed.pos, index: idx} : null;
  }

  static abilityFromParts(parts) {
    // find "[from] ability: X" / "ability: X" kwarg
    for (let i = 1; i < parts.length; i++) {
      const m = /ability:\s*([^|\]]+)/i.exec(parts[i] || '');
      if (m) return m[1].trim();
    }
    return '';
  }

  handleLine(parts) {
    const cmd = parts[0];
    switch (cmd) {
      case 'turn': {
        this.turn = parseInt(parts[1], 10) || 0;
        for (const side of ['p1', 'p2']) {
          for (const {poke} of this.sideActive(side)) poke.activeTurns++;
        }
        break;
      }
      case 'poke': {
        // |poke|p2|Species, L50, M|item?
        const side = parts[1];
        if (side !== 'p1' && side !== 'p2') break;
        const {species, level, gender} = parseDetails(parts[2] || '');
        if (species) this.team[side].push(newPoke(species, level, gender));
        break;
      }
      case 'teamsize': {
        break;
      }
      case 'switch':
      case 'drag': {
        // |switch|p1a: Name|Details|HP Status|
        const slot = this.slotTeamIndex(parts[1], parts[2]);
        if (!slot) break;
        const {side, index, pos} = slot;
        this.active[side][pos] = index;
        for (let i = 0; i < this.team[side].length; i++) {
          // only one active per position; recompute below
        }
        const poke = this.team[side][index];
        poke.activeTurns = 0;
        poke.lastMove = '';
        poke.teraType = '';
        const c = parseCondition(parts[3] || '');
        poke.hp = c.hp;
        poke.maxhp = c.maxhp;
        poke.frac = c.frac;
        poke.status = c.status;
        poke.fainted = c.fainted;
        poke.boosts = blankBoosts();
        // recompute active flags for the side
        for (const p of this.team[side]) p.active = false;
        for (const idx of this.active[side]) {
          if (idx !== undefined && idx !== null && this.team[side][idx]) {
            this.team[side][idx].active = true;
          }
        }
        break;
      }
      case 'faint': {
        const f = this.findBySlot(parts[1] || '');
        if (f) {
          f.poke.fainted = true;
          f.poke.hp = 0;
          f.poke.frac = 0;
          f.poke.active = false;
        }
        break;
      }
      case '-damage':
      case '-heal': {
        const f = this.findBySlot(parts[1] || '');
        if (f) {
          const c = parseCondition(parts[2] || '');
          f.poke.hp = c.hp;
          f.poke.maxhp = c.maxhp || f.poke.maxhp;
          f.poke.frac = c.frac;
          if (c.status) f.poke.status = c.status;
          f.poke.fainted = c.fainted;
          if (c.fainted) f.poke.active = false;
        }
        break;
      }
      case '-status': {
        // |-status|p2a|slp
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2]) f.poke.status = parts[2];
        break;
      }
      case '-curestatus': {
        const f = this.findBySlot(parts[1] || '');
        if (f && f.poke.status === parts[2]) f.poke.status = '';
        break;
      }
      case '-cureteam': {
        const side = parts[1];
        if (side === 'p1' || side === 'p2') {
          for (const p of this.team[side]) if (!p.fainted) p.status = '';
        }
        break;
      }
      case 'move': {
        // |move|p2a: Name|Move Name|[target]
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2]) {
          const mv = toID(parts[2]);
          f.poke.lastMove = mv;
          if (!f.poke.movesSeen.includes(mv)) f.poke.movesSeen.push(mv);
        }
        break;
      }
      case 'cant': {
        // |cant|p1a|flinch / slp / par / ... — record last "move" as failed? skip
        break;
      }
      case '-ability': {
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2]) f.poke.ability = parts[2];
        break;
      }
      case '-immune':
      case '-block': {
        // |-immune|p2a: Foo|[from] ability: Levitate|
        const f = this.findBySlot(parts[1] || '');
        if (f) {
          const ab = Tracker.abilityFromParts(parts);
          if (ab) f.poke.ability = ab;
        }
        break;
      }
      case '-boost':
      case '-unboost': {
        const f = this.findBySlot(parts[1] || '');
        const stat = parts[2];
        const amt = parseInt(parts[3], 10) || 0;
        if (f && STAT_IDS.includes(stat)) {
          f.poke.boosts[stat] += cmd === '-boost' ? amt : -amt;
          f.poke.boosts[stat] = Math.max(-6, Math.min(6, f.poke.boosts[stat]));
        }
        break;
      }
      case '-setboost': {
        const f = this.findBySlot(parts[1] || '');
        const stat = parts[2];
        const amt = parseInt(parts[3], 10) || 0;
        if (f && STAT_IDS.includes(stat)) f.poke.boosts[stat] = Math.max(-6, Math.min(6, amt));
        break;
      }
      case '-clearboost':
      case '-clearallboost':
      case 'clearallboost': {
        if (parts[1] && parseSlotId(parts[1])) {
          const f = this.findBySlot(parts[1]);
          if (f) f.poke.boosts = blankBoosts();
        } else {
          for (const side of ['p1', 'p2']) {
            for (const p of this.team[side]) p.boosts = blankBoosts();
          }
        }
        break;
      }
      case '-invertboost': {
        const f = this.findBySlot(parts[1] || '');
        if (f) {
          for (const s of STAT_IDS) f.poke.boosts[s] = -f.poke.boosts[s];
        }
        break;
      }
      case 'detailschange':
      case '-formechange': {
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2]) {
          const {species, level} = parseDetails(parts[2]);
          if (species) {
            f.poke.species = species;
            if (level) f.poke.level = level;
          }
        }
        break;
      }
      case '-mega':
      case '-primal':
      case '-burst': {
        // |-mega|p1a|Species|Stone| — ability may change; clear stale ability guess
        const f = this.findBySlot(parts[1] || '');
        if (f) f.poke.ability = '';
        break;
      }
      case '-terastallize': {
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2]) f.poke.teraType = parts[2];
        break;
      }
      case 'weather': {
        const w = toID((parts[1] || '').split('[')[0]);
        this.weather = w === 'none' ? '' : parts[1];
        break;
      }
      case '-weather': {
        const raw = parts[1] || '';
        if (toID(raw.split('[')[0]) === 'none') this.weather = '';
        else if (!parts[2] || !parts[2].includes('upkeep')) this.weather = raw;
        break;
      }
      case '-fieldstart':
      case 'fieldstart': {
        const raw = parts[1] || '';
        if (/trick room/i.test(raw)) this.trickroom = true;
        const m = /condition:\s*([\w ]+terrain)/i.exec(raw);
        if (m) this.terrain = m[1].trim();
        break;
      }
      case '-fieldend':
      case 'fieldend': {
        const raw = parts[1] || '';
        if (/trick room/i.test(raw)) this.trickroom = false;
        if (/terrain/i.test(raw)) this.terrain = '';
        break;
      }
      case '-sidestart':
      case 'sidestart': {
        const m = /^(p[12])/.exec(parts[1] || '');
        const cond = parts[2] || '';
        if (m) {
          const side = this.sides[m[1]];
          if (/spikes|stealth rock|toxic spikes|sticky web/i.test(cond)) {
            const key = toID(cond.replace(/^move:\s*/i, ''));
            side.hazards[key] = (side.hazards[key] || 0) + 1;
          } else if (/reflect|light screen|aurora veil/i.test(cond)) {
            side.screens[toID(cond.replace(/^move:\s*/i, ''))] = true;
          } else if (/tailwind/i.test(cond)) {
            side.tailwind = true;
          }
        }
        break;
      }
      case '-sideend':
      case 'sideend': {
        const m = /^(p[12])/.exec(parts[1] || '');
        const cond = parts[2] || '';
        if (m) {
          const side = this.sides[m[1]];
          const key = toID(cond.replace(/^move:\s*/i, ''));
          delete side.hazards[key];
          delete side.screens[key];
          if (/tailwind/i.test(cond)) side.tailwind = false;
        }
        break;
      }
      case '-item':
      case 'item': {
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2]) f.poke.item = parts[2];
        break;
      }
      case '-enditem': {
        const f = this.findBySlot(parts[1] || '');
        if (f && parts[2] && f.poke.item && toID(f.poke.item) === toID(parts[2])) {
          f.poke.itemConsumed = true;
        }
        break;
      }
      case 'win': {
        this.winner = parts[1] || '';
        this.over = true;
        break;
      }
      case 'tie': {
        this.winner = 'tie';
        this.over = true;
        break;
      }
      default:
        break;
    }
  }

  // Map a switch slot ("p1a: Nick") + details to a team index.
  slotTeamIndex(slotStr, details) {
    const parsed = parseSlotId(slotStr || '');
    if (!parsed) return null;
    const {species, level} = parseDetails(details || '');
    const team = this.team[parsed.side];
    for (let i = 0; i < team.length; i++) {
      if (team[i].species === species && (team[i].level === level || !level || !team[i].level) && !team[i].fainted) {
        const usedElsewhere = this.active[parsed.side].some((idx, p) => p !== parsed.pos && idx === i);
        if (!usedElsewhere) {
          if (level && !team[i].level) team[i].level = level;
          return {side: parsed.side, index: i, pos: parsed.pos};
        }
      }
    }
    for (let i = 0; i < team.length; i++) {
      if (team[i].species === species && !team[i].fainted) {
        const usedElsewhere = this.active[parsed.side].some((idx, p) => p !== parsed.pos && idx === i);
        if (!usedElsewhere) return {side: parsed.side, index: i, pos: parsed.pos};
      }
    }
    if (species) {
      team.push(newPoke(species, level || 0, ''));
      return {side: parsed.side, index: team.length - 1, pos: parsed.pos};
    }
    return null;
  }
}

// Boost stage multiplier (gen 3+; accuracy/evasion use same table with different base).
// Which team member occupies request slot `slot`, and is it fainted?
// active[] order is POSITION order, side.pokemon is TEAM order, so match by move ids.
// Returns true only if every candidate match is fainted ('0 fnt').
export function slotMonFainted(request, slot) {
  try {
    const a = (request.active || [])[slot];
    const mons = (request.side && request.side.pokemon) || [];
    if (!a || !a.moves || !a.moves.length) return false;
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const ids = a.moves.map(m => norm(m.id)).filter(Boolean);
    if (!ids.length) return false;
    const matchId = (reqId, sideId) => sideId === reqId || sideId.startsWith(reqId) || reqId.startsWith(sideId);
    const cands = [];
    for (let j = 0; j < mons.length; j++) {
      const mm = (mons[j].moves || []).map(norm);
      if (ids.every(id => mm.some(sid => matchId(id, sid)))) cands.push(j);
    }
    if (!cands.length) return false; // e.g. transformed Ditto: treat as alive
    return cands.every(j => /0 fnt/.test(mons[j].condition || ''));
  } catch {
    return false;
  }
}

export function boostMultiplier(stage, isAccuracy = false) {
  if (isAccuracy) {
    if (stage >= 0) return (3 + stage) / 3;
    return 3 / (3 - stage);
  }
  if (stage >= 0) return (2 + stage) / 2;
  return 2 / (2 - stage);
}
