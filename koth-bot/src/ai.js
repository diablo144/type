// Request-driven heuristic battle AI for singles + doubles, all gens.
// Input: Showdown `request` JSON + Tracker (fed with battle log).
// Output: structured decisions + Showdown choice string. Never throws.
import {Dex} from '@pkmn/sim';
import {toID, parseDetails, parseCondition, boostMultiplier, slotMonFainted} from './tracker.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

function zPower(basePower) {
  if (basePower <= 55) return 100;
  if (basePower <= 65) return 120;
  if (basePower <= 75) return 140;
  if (basePower <= 85) return 160;
  if (basePower <= 95) return 175;
  if (basePower <= 100) return 180;
  if (basePower <= 110) return 185;
  if (basePower <= 125) return 190;
  if (basePower <= 130) return 195;
  return 200;
}

const FIXED_DAMAGE = {
  dragonrage: () => 40,
  sonicboom: () => 20,
  seismictoss: (att) => att.level,
  nightshade: (att) => att.level,
};

const IMMUNITY_ABILITIES = {
  levitate: ['Ground'],
  flashfire: ['Fire'],
  voltabsorb: ['Electric'], motordrive: ['Electric'], lightningrod: ['Electric'],
  waterabsorb: ['Water'], stormdrain: ['Water'], dryskin: ['Water'],
  sapsipper: ['Grass'],
  soundproof: [], // handled via sound flag
};

const CONTACT_PUNISH_IGNORE = true;

// Moves that always crit (I = implement via willCrit from dex, fallback list)
const ALWAYS_CRIT = new Set(['frostbreath', 'stormthrow', 'surgingstrikes', 'wickedblow', 'flowertrick', 'zippyzap', 'floatyfall', 'sizzlyslide', 'baddybad', 'bouncybubble', 'buzzybuzz', 'glitzyglow']);

// Setup moves: moveId -> [boostStat, stages] (self)
const SETUP_MOVES = {
  swordsdance: [['atk', 2]], nastplot: [['spa', 2]], dragonance: [['atk', 1], ['spe', 1]],
  calmmind: [['spa', 1], ['spd', 1]], bulkup: [['atk', 1], ['def', 1]], coil: [['atk', 1], ['def', 1]],
  quiverdance: [['spa', 1], ['spd', 1], ['spe', 1]], tailglow: [['spa', 3]], shellsmash: [['atk', 2], ['spa', 2], ['spe', 2]],
  shiftgear: [['atk', 1], ['spe', 2]], agility: [['spe', 2]], rockpolish: [['spe', 2]], autotomize: [['spe', 2]],
  irondefense: [['def', 2]], acidarmor: [['def', 2]], barrier: [['def', 2]], amnesia: [['spd', 2]],
  cosmicpower: [['def', 1], ['spd', 1]], cottonguard: [['def', 3]], stockpile: [['def', 1], ['spd', 1]],
  curse: [['atk', 1], ['def', 1]], bellydrum: [['atk', 12]], honeclaws: [['atk', 1]],
  growth: [['spa', 1]], chargebeam: [['spa', 1]], fierydance: [['spa', 1]], poweruppunch: [['atk', 1]],
  flamecharge: [['spe', 1]], electroshot: [['spa', 1]], torchsong: [['spa', 1]], trailblaze: [['spe', 1]],
  metalsound: [], // (foe debuff, not setup)
};

// Recovery moves (heal fraction of max, weather-dependent noted)
const RECOVERY_MOVES = new Set(['recover', 'slackoff', 'roost', 'milkdrink', 'softboiled', 'shoreup', 'strengthsap', 'junglehealing', 'lifedew', 'moonlight', 'morningsun', 'synthesis', 'healorder', 'healpulse', 'floralhealing', 'swallow']);

// Priority-blocking: foe abilities that block our priority
const PRIORITY_BLOCKERS = new Set(['queenlymajesty', 'dazzling', 'armortail']);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export class BattleAI {
  constructor({formatId = 'gen9ou', gen = 9, gameType = 'singles', defaultLevel = 100} = {}) {
    this.formatId = formatId;
    this.gen = gen;
    this.gameType = gameType;
    this.doubles = gameType === 'doubles';
    this.defaultLevel = defaultLevel;
    try {
      this.dex = Dex.mod('gen' + gen);
    } catch {
      this.dex = Dex;
    }
    this.lastChoice = '';
    this.voluntarySwitchStreak = 0;
  }

  // -- main entry ------------------------------------------------------------
  decide(request, tracker, rejected = new Set()) {
    try {
      if (!request || request.wait || request.requestType === 'wait') {
        return {kind: 'wait', choiceString: null};
      }
      if (request.teamPreview) return this.decideTeamPreview(request, tracker);
      if (request.active || request.forceSwitch) return this.decideActions(request, tracker, rejected);
      return {kind: 'wait', choiceString: null};
    } catch (err) {
      return safeFallback(request, this.doubles, rejected, err);
    }
  }

  // -- type effectiveness ----------------------------------------------------
  effectiveness(moveType, targetTypes) {
    let mult = 1;
    for (const t of targetTypes) {
      const typeData = this.dex.types.get(t);
      if (!typeData || !typeData.exists) continue;
      const dt = typeData.damageTaken[moveType];
      if (dt === 1) mult *= 2;
      else if (dt === 2) mult *= 0.5;
      else if (dt === 3) mult *= 0;
    }
    return mult;
  }

  // -- state extraction ------------------------------------------------------
  ownMons(request, tracker) {
    const mons = [];
    const side = request.side || {};
    const list = side.pokemon || [];
    const tracked = tracker ? tracker.team[tracker.mySide] || [] : [];
    for (let j = 0; j < list.length; j++) {
      const p = list[j];
      const det = parseDetails(p.details || '');
      const c = parseCondition(p.condition || '');
      const tr = tracked[j] || {};
      mons.push({
        index: j,
        ident: p.ident || '',
        species: det.species || '',
        level: det.level || this.defaultLevel,
        gender: det.gender || '',
        hp: c.hp, maxhp: c.maxhp || 1,
        frac: c.maxhp ? c.hp / c.maxhp : 0,
        status: c.status || '',
        fainted: c.fainted,
        active: !!p.active,
        stats: p.stats || {atk: 100, def: 100, spa: 100, spd: 100, spe: 100},
        moves: p.moves || [],
        ability: toID(p.ability || p.baseAbility || ''),
        baseAbility: toID(p.baseAbility || ''),
        item: toID(p.item || ''),
        teraType: p.teraType || '',
        terastallized: p.terastallized || '',
        boosts: (tr.boosts) || {atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0},
        activeTurns: tr.activeTurns || 0,
        lastMove: tr.lastMove || '',
        tracked: tr,
      });
    }
    return mons;
  }

  foeMons(tracker) {
    const out = [];
    if (!tracker) return out;
    for (const {poke, pos} of tracker.foeActive()) {
      out.push(this.richFoe(poke, pos, tracker));
    }
    return out;
  }

  richFoe(poke, pos, tracker) {
    const species = this.dex.species.get(poke.species || 'Bulbasaur');
    const types = poke.teraType ? [poke.teraType] : (species.types || ['Normal']);
    const level = poke.level || this.defaultLevel;
    const base = species.baseStats || {hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80};
    // Conservative bulk assumption: 31 IV, 252 EV, neutral.
    const est = (b) => Math.floor((Math.floor(((2 * b + 31 + 63) * level) / 100) + 5));
    const estHP = base.hp === 1 ? 1 : Math.floor(((2 * base.hp + 31 + 63) * level) / 100) + level + 10;
    const minHP = base.hp === 1 ? 1 : Math.floor(((2 * base.hp + 31) * level) / 100) + level + 10;
    // foe maxhp may be exact (omniscient), percentage (/100) or 48ths (/48): detect scale
    let foeMax = estHP;
    if (poke.maxhp && poke.maxhp >= minHP * 0.9 && poke.maxhp <= estHP * 1.15) foeMax = poke.maxhp;
    return {
      pos,
      species: poke.species,
      level,
      gender: poke.gender || '',
      types: [...types],
      baseStats: {...base},
      weightkg: species.weightkg || 50,
      estStats: {atk: est(base.atk), def: est(base.def), spa: est(base.spa), spd: est(base.spd), spe: est(base.spe)},
      maxhp: foeMax,
      frac: poke.frac,
      hp: Math.round(poke.frac * foeMax),
      status: poke.status || '',
      fainted: !!poke.fainted,
      boosts: {...poke.boosts},
      ability: toID(poke.ability || ''),
      item: toID(poke.item || ''),
      itemConsumed: !!poke.itemConsumed,
      movesSeen: [...(poke.movesSeen || [])],
      lastMove: poke.lastMove || '',
      activeTurns: poke.activeTurns || 0,
      teraType: poke.teraType || '',
    };
  }

  // Effective speed (with boosts, paralysis, tailwind; choice scarf if known).
  effSpeed(mon, side, tracker, isFoe) {
    const raw = isFoe ? mon.estStats.spe : mon.stats.spe;
    let spe = raw * boostMultiplier(mon.boosts.spe || 0);
    const paraMod = this.gen >= 7 ? 0.5 : 0.25;
    if (mon.status === 'par') spe *= paraMod;
    if (!isFoe && mon.item === 'choicescarf') spe *= 1.5;
    if (isFoe && mon.item === 'choicescarf') spe *= 1.5;
    if (side && side.tailwind) spe *= 2;
    // Protosynthesis/Quark Drive speed boost
    if ((mon.ability === 'protosynthesis' || mon.ability === 'quarkdrive') && this.protoActive(mon, tracker)) {
      // only if Spe is highest... approximate: check
      const s = isFoe ? mon.estStats : mon.stats;
      if (s.spe >= Math.max(s.atk, s.def, s.spa, s.spd)) spe *= 1.5;
    }
    if (mon.ability === 'surgingsurfer' && tracker && /electricterrain/i.test(tracker.terrain || '')) spe *= 2;
    if (mon.ability === 'swiftswim' && tracker && /rain/i.test(tracker.weather || '')) spe *= 2;
    if (mon.ability === 'chlorophyll' && tracker && /sun/i.test(tracker.weather || '')) spe *= 2;
    if (mon.ability === 'sandrush' && tracker && /sand/i.test(tracker.weather || '')) spe *= 2;
    if (mon.ability === 'slushrush' && tracker && /hail|snow/i.test(tracker.weather || '')) spe *= 2;
    return spe;
  }

  protoActive(mon, tracker) {
    if (!tracker) return false;
    if (mon.ability === 'protosynthesis') return /sun/i.test(tracker.weather || '') || mon.item === 'boosterenergy';
    if (mon.ability === 'quarkdrive') return /electricterrain/i.test(tracker.terrain || '') || mon.item === 'boosterenergy';
    return false;
  }

  grounded(mon, tracker) {
    const types = mon.types || this.dex.species.get(mon.species).types || [];
    if (types.includes('Flying')) return false;
    if (mon.ability === 'levitate') return false;
    if (mon.item === 'airballoon') return false;
    return true;
  }

  // -- damage estimation -----------------------------------------------------
  // Returns {avg, min, max} as FRACTION of defender max HP.
  estimateDamage(att, def, moveId, tracker, opts = {}) {
    const zero = {avg: 0, min: 0, max: 0};
    const move = this.dex.moves.get(moveId);
    if (!move || !move.exists) return zero;
    const gen = this.gen;

    // Attacker/defender sides for hazards/screens/tailwind
    const attSide = opts.attSide || {};
    const defSide = opts.defSide || {};

    // ---- non-damaging ----
    const basePower0 = move.basePower;
    if (move.category === 'Status' || !basePower0) {
      // Fixed-damage status-category moves (seismic toss etc. are Physical though)
      if (FIXED_DAMAGE[move.id]) {
        const dmg = FIXED_DAMAGE[move.id](att);
        const frac = dmg / Math.max(1, def.maxhp);
        // effectiveness still applies (ghost immune fighting? seismic toss normal?/fighting?)
        const eff = this.effectiveness(move.type, def.types);
        if (eff === 0) return zero;
        return {avg: frac * eff, min: frac * eff, max: frac * eff};
      }
      return zero;
    }

    // ---- attacker ability: type changes ----
    let moveType = move.type;
    let power = basePower0;
    const attAbility = toID(att.ability || '');
    let stabBoost = 1;
    if (moveType === 'Normal' && ['pixilate', 'refrigerate', 'aerilate', 'galvanize'].includes(attAbility)) {
      moveType = {pixilate: 'Fairy', refrigerate: 'Ice', aerilate: 'Flying', galvanize: 'Electric'}[attAbility];
      power = Math.floor(power * (gen >= 7 ? 1.2 : 1.3));
    } else if (attAbility === 'normalize' && move.id !== 'weatherball' && move.id !== 'naturalgift' && move.id !== 'judgment' && move.id !== 'revelationdance' && move.id !== 'terrainpulse' && move.id !== 'aurawheel' && move.id !== 'dynamaxcannon') {
      moveType = 'Normal';
      power = Math.floor(power * (gen >= 7 ? 1.2 : 1.3));
    }
    if (move.flags && move.flags.sound && attAbility === 'liquidvoice') moveType = 'Water';

    // ---- special power handling ----
    let hits = 1;
    let alwaysCrit = !!(move.willCrit || ALWAYS_CRIT.has(move.id));
    const foeMaxHP = Math.max(1, def.maxhp);

    // Variable power moves
    switch (move.id) {
      case 'flail':
      case 'reversal': {
        const f = att.frac !== undefined ? att.frac : (att.hp / Math.max(1, att.maxhp));
        power = f > 0.6875 ? 20 : f > 0.3542 ? 40 : f > 0.2083 ? 80 : f > 0.1042 ? 100 : f > 0.0417 ? 150 : 200;
        break;
      }
      case 'lowkick':
      case 'grassknot': {
        const w = def.weightkg || 50;
        power = w >= 200 ? 120 : w >= 100 ? 100 : w >= 50 ? 80 : w >= 25 ? 60 : w >= 10 ? 40 : 20;
        break;
      }
      case 'gyroball': {
        const aSpe = Math.max(1, att.effSpe || 100);
        const dSpe = Math.max(1, def.effSpe || 100);
        power = clamp(Math.floor((25 * dSpe) / aSpe) + 1, 1, 150);
        break;
      }
      case 'electroball': {
        const aSpe = Math.max(1, att.effSpe || 100);
        const dSpe = Math.max(1, def.effSpe || 100);
        const r = aSpe / dSpe;
        power = r >= 4 ? 150 : r >= 3 ? 120 : r >= 2 ? 80 : r >= 1 ? 60 : 40;
        break;
      }
      case 'storedpower':
      case 'powertrip': {
        let boosts = 0;
        for (const s of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']) {
          if ((att.boosts[s] || 0) > 0) boosts += att.boosts[s];
        }
        power = move.id === 'storedpower' ? 20 + 20 * boosts : 20 + 20 * boosts;
        break;
      }
      case 'punishment': {
        let boosts = 0;
        for (const s of ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']) {
          if ((def.boosts[s] || 0) > 0) boosts += def.boosts[s];
        }
        power = Math.min(200, 60 + 20 * boosts);
        break;
      }
      case 'waterspout':
      case 'eruption':
      case 'dragonenergy': {
        const f = att.frac !== undefined ? att.frac : 1;
        power = Math.max(1, Math.floor(150 * f));
        break;
      }
      case 'crushgrip':
      case 'wringout': {
        const f = def.frac !== undefined ? def.frac : 1;
        power = Math.max(1, Math.floor(120 * f));
        break;
      }
      case 'fling': {
        power = 60; // rough average
        break;
      }
      case 'naturalgift': {
        return zero; // berry-dependent; assume unusable/weak
      }
      case 'trumpcard': {
        const pp = (opts.movePP !== undefined ? opts.movePP : 5);
        power = pp >= 5 ? 40 : pp === 4 ? 50 : pp === 3 ? 60 : pp === 2 ? 80 : 200;
        break;
      }
      case 'tripleaxel': power = 120; break;
      case 'triplekick': power = 30; break;
      case 'surgingstrikes': power = 75; hits = 1; break; // 25x3 modeled as 75
      case 'populationbomb': power = 20; hits = 6; break;
      case 'dragondarts': {
        // 50 x2 split across foes if 2 foes, else 100
        if (opts.twoFoes) { power = 50; hits = 1; }
        else { power = 100; hits = 1; }
        break;
      }
      case 'beatup': power = 40; break;
      case 'present': power = 60; break;
      case 'magnitude': power = 71; break;
      case 'psywave': {
        const f = att.level / foeMaxHP;
        return {avg: f, min: f * 0.5, max: f * 1.5};
      }
      case 'superfang': {
        const cur = def.frac !== undefined ? def.frac : 0.5;
        return {avg: cur / 2, min: cur / 2, max: cur / 2};
      }
      case 'endeavor': {
        const aF = att.frac !== undefined ? att.frac : 0.5;
        const dF = def.frac !== undefined ? def.frac : 0.5;
        if (aF >= dF) return zero;
        // sets foe to our HP: damage frac = dF - aF*(ourMax/foeMax)? approx dF - aF
        return {avg: Math.max(0, dF - aF), min: Math.max(0, dF - aF), max: Math.max(0, dF - aF)};
      }
      case 'finalgambit': {
        const aHP = att.hp !== undefined ? att.hp : 100;
        return {avg: aHP / foeMaxHP, min: aHP / foeMaxHP, max: aHP / foeMaxHP};
      }
      case 'counter':
      case 'mirrorcoat':
      case 'metalburst':
        return zero; // reactive; can't estimate
      case 'fissure':
      case 'guillotine':
      case 'horndrill':
      case 'sheercold': {
        // OHKO: acc 30 (minus?/gen1: speed-based). Expected value model.
        const acc = move.id === 'sheercold' && gen === 1 ? 30 : 30;
        const p = (move.accuracy === true ? 30 : (move.accuracy || 30)) / 100;
        // only if level >= target level
        if (att.level < def.level) return zero;
        if (this.effectiveness(moveType, def.types) === 0) return zero;
        return {avg: p * 1.0, min: 0, max: 1.0};
      }
      case 'seismictoss':
      case 'nightshade':
      case 'dragonrage':
      case 'sonicboom': {
        const dmg = FIXED_DAMAGE[move.id](att);
        const eff = this.effectiveness(moveType, def.types);
        const f = (dmg / foeMaxHP) * eff;
        return {avg: f, min: f, max: f};
      }
      case 'dreameater':
      case 'nightmare': {
        if (def.status !== 'slp') return zero;
        break;
      }
      default:
        break;
    }

    // Multihit
    if (move.multihit && move.id !== 'populationbomb' && move.id !== 'surgingstrikes' && move.id !== 'tripleaxel' && move.id !== 'triplekick') {
      const mh = move.multihit;
      if (Array.isArray(mh)) {
        if (attAbility === 'skilllink' || att.item === 'loadeddice') hits = mh[1] === 5 ? 5 : (mh[0] + mh[1]) / 2;
        else if (att.item === 'loadeddice') hits = 4;
        else hits = (mh[0] + mh[1]) / 2; // ~3 for 2-5
        if (mh[0] === 2 && mh[1] === 5) hits = (attAbility === 'skilllink') ? 5 : 3.17;
      } else {
        hits = mh;
      }
    }

    // ---- category & stats ----
    let category = move.category;
    // Gen 1-3: category from type (dex data already reflects? ensure)
    const isPhysical = category === 'Physical';
    let atkStat, defStat;
    const aStats = att.stats || att.estStats || {};
    const dStats = def.stats || def.estStats || {};
    if (move.id === 'psyshock' || move.id === 'psystrike' || move.id === 'secretsword') {
      atkStat = aStats.spa; defStat = dStats.def;
    } else if (move.id === 'bodypress') {
      atkStat = aStats.def; defStat = dStats.def;
    } else if (move.id === 'foulplay') {
      atkStat = dStats.atk; defStat = dStats.def;
    } else if (isPhysical) {
      atkStat = aStats.atk; defStat = dStats.def;
    } else {
      atkStat = aStats.spa; defStat = dStats.spd;
    }
    atkStat = atkStat || 100; defStat = defStat || 100;

    // Boosts (ignore on crit? gen dependent — simplify: apply)
    const atkBoostKey = (move.id === 'bodypress') ? 'def' : isPhysical ? 'atk' : 'spa';
    const defBoostKey = (move.id === 'psyshock' || move.id === 'psystrike' || move.id === 'secretsword' || move.id === 'bodypress' || move.id === 'foulplay') ? 'def' : isPhysical ? 'def' : 'spd';
    let A = atkStat * boostMultiplier((att.boosts && att.boosts[atkBoostKey]) || 0);
    let D = defStat * boostMultiplier((def.boosts && def.boosts[defBoostKey]) || 0);

    // Burn halves physical (except Guts)
    if (isPhysical && att.status === 'brn' && attAbility !== 'guts') A *= 0.5;

    // Attacker item
    const attItem = toID(att.item || '');
    if (attItem === 'choiceband' && isPhysical) A *= 1.5;
    if (attItem === 'choicespecs' && !isPhysical) A *= 1.5;
    if (attItem === 'lifeorb') A *= 1.3;
    if (attItem === 'muscleband' && isPhysical) A *= 1.1;
    if (attItem === 'wiseglasses' && !isPhysical) A *= 1.1;
    if (attItem === 'silkscarf' && moveType === 'Normal') power *= 1.2;
    if (attItem === 'thickclub' && (att.species === 'Marowak' || att.species === 'Marowak-Alola' || att.species === 'Cubone') && isPhysical) A *= 2;
    if (attItem === 'lightball' && att.species === 'Pikachu') A *= 2;
    if (attItem === 'deepseatooth' && att.species === 'Clamperl' && !isPhysical) A *= 2;
    if (attItem === 'souldew' && (att.species === 'Latias' || att.species === 'Latios') && gen >= 7 && !isPhysical) A *= 1.2;
    if (attItem === 'metronome') A *= 1.1;

    // Defender item
    const defItem = toID(def.item || '');
    if (defItem === 'eviolite' || defItem === 'assaultvest' && !isPhysical) { /* AV below */ }
    if (defItem === 'eviolite') D *= 1.5;
    if (defItem === 'assaultvest' && !isPhysical) D *= 1.5;
    if (defItem === 'deepseascale' && def.species === 'Clamperl' && !isPhysical) D *= 2;
    if (defItem === 'metalpowder' && def.species === 'Ditto' && this.gen <= 4) D *= 1.5;
    if (defItem === 'souldew' && (def.species === 'Latias' || def.species === 'Latios') && gen <= 6) D *= 1.5;

    // Attacker ability (offense)
    if (attAbility === 'hugepower' || attAbility === 'purepower') {
      if (move.id === 'bodypress') D = D; else if (isPhysical || move.id === 'foulplay') A *= 2;
    }
    if (attAbility === 'hustle' && isPhysical) A *= 1.5;
    if (attAbility === 'guts' && att.status && isPhysical) A *= 1.5;
    if (attAbility === 'toxicboost' && (att.status === 'psn' || att.status === 'tox') && isPhysical) A *= 1.5;
    if (attAbility === 'flareboost' && att.status === 'brn' && !isPhysical) A *= 1.5;
    if (attAbility === 'megalauncher' && move.flags && move.flags.pulse) power *= 1.5;
    if (attAbility === 'strongjaw' && move.flags && (move.flags.bite || move.flags.jaw)) power *= 1.5;
    if (attAbility === 'ironfist' && move.flags && move.flags.punch) power *= 1.2;
    if (attAbility === 'reckless' && move.flags && (move.flags.recoil || move.flags.crash)) power *= 1.2;
    if (attAbility === 'toughclaws' && move.flags && move.flags.contact) power *= 1.3;
    if (attAbility === 'sheerforce' && move.secondary) power *= 1.3;
    if (attAbility === 'technician' && power <= 60) power *= 1.5;
    if (attAbility === 'analytic' && opts.moveLast) power *= 1.3;
    if (attAbility === 'sandforce' && tracker && /sand/i.test(tracker.weather || '') && ['Rock', 'Ground', 'Steel'].includes(moveType)) power *= 1.3;
    if (attAbility === 'solarpower' && tracker && /sun/i.test(tracker.weather || '') && !isPhysical) A *= 1.5;
    if (attAbility === 'flowergift' && tracker && /sun/i.test(tracker.weather || '') && isPhysical) A *= 1.5;
    if (attAbility === 'darkaura' && moveType === 'Dark') power *= 1.333;
    if (attAbility === 'fairyaura' && moveType === 'Fairy') power *= 1.333;
    if (attAbility === 'steelworker' || attAbility === 'steelyspirit') { if (moveType === 'Steel') power *= 1.5; }
    if (attAbility === 'gorillatactics' && isPhysical) A *= 1.5;
    if (attAbility === 'waterbubble' && moveType === 'Water') A *= 2;
    if (attAbility === 'orichalcumpulse' && tracker && /sun/i.test(tracker.weather || '') && isPhysical) A *= 1.333;
    if (attAbility === 'hadronengine' && tracker && /electricterrain/i.test(tracker.terrain || '') && !isPhysical) A *= 1.333;
    if (attAbility === 'supremeoverlord' && opts.faintedAllies) A *= 1 + 0.1 * Math.min(5, opts.faintedAllies);
    if (attAbility === 'defeatist' && (att.frac || 1) < 0.5) A *= 0.5;
    if (attAbility === 'slowstart' && (att.activeTurns || 0) < 5) A *= 0.5;
    if (attAbility === 'stakeout' && def.switchedIn) A *= 2;
    if (attAbility === 'rivalry' && att.gender && def.gender) {
      if (att.gender === def.gender) A *= 1.25; else A *= 0.75;
    }
    if ((attAbility === 'protosynthesis' || attAbility === 'quarkdrive') && this.protoActive(att, tracker)) {
      const s = att.stats || att.estStats || {};
      const best = Math.max(s.atk || 0, s.def || 0, s.spa || 0, s.spd || 0);
      const key = isPhysical ? (s.atk || 0) : (s.spa || 0);
      if (key >= best) A *= 1.3;
    }
    // Ruin auras on the FIELD (either side's active)
    if (opts.fieldAbilities) {
      if (opts.fieldAbilities.has('swordofruin') && isPhysical) D *= 0.75;
      if (opts.fieldAbilities.has('vesselofruin') && !isPhysical) A *= 0.75;
      if (opts.fieldAbilities.has('tabletsofruin') && isPhysical) A *= 0.75;
      if (opts.fieldAbilities.has('beadsofruin') && !isPhysical) D *= 0.75;
    }

    // Defender ability (defense)
    const defAbility = toID(def.ability || '');
    if ((defAbility === 'multiscale' || defAbility === 'shadowshield') && (def.frac === undefined || def.frac >= 1)) power *= 0.5;
    if ((defAbility === 'filter' || defAbility === 'solidrock' || defAbility === 'prismarmor') && this.effectiveness(moveType, def.types) > 1) power *= 0.75;
    if (defAbility === 'fluffy' && move.flags && move.flags.contact) D *= 2;
    if (defAbility === 'fluffy' && moveType === 'Fire') power *= 2;
    if (defAbility === 'punkrock' && move.flags && move.flags.sound) power *= 0.5;
    if (attAbility === 'punkrock' && move.flags && move.flags.sound) power *= 1.3;
    if (defAbility === 'thickfat' && (moveType === 'Fire' || moveType === 'Ice')) power *= 0.5;
    if (defAbility === 'heatproof' && moveType === 'Fire') power *= 0.5;
    if (defAbility === 'waterbubble' && moveType === 'Fire') power *= 0.5;
    if (defAbility === 'dryskin' && moveType === 'Fire') power *= 1.25;
    if (defAbility === 'icescales' && !isPhysical) D *= 2;
    if (defAbility === 'furcoat' && isPhysical) D *= 2;
    if (defAbility === 'grasspelt' && tracker && /grassyterrain/i.test(tracker.terrain || '') && isPhysical) D *= 1.5;
    if (defAbility === 'marvelscale' && def.status && isPhysical) D *= 1.5;
    if (defAbility === 'flowergift' && tracker && /sun/i.test(tracker.weather || '') && !isPhysical) D *= 1.5;
    if (defAbility === 'furcoat' && isPhysical) D *= 1; // (already above)

    // Screens
    const screens = (defSide.screens) || {};
    if (isPhysical && (screens.reflect || screens.auroraveil)) power *= this.doubles ? 2 / 3 : 0.5;
    if (!isPhysical && (screens.lightscreen || screens.auroraveil)) power *= this.doubles ? 2 / 3 : 0.5;
    if (defAbility === 'infiltrator') { /* attacker-side; handled below */ }
    if (attAbility === 'infiltrator') {
      // undo screens
      if (isPhysical && (screens.reflect || screens.auroraveil)) power /= this.doubles ? 2 / 3 : 0.5;
      if (!isPhysical && (screens.lightscreen || screens.auroraveil)) power /= this.doubles ? 2 / 3 : 0.5;
    }

    // Weather
    const weather = tracker ? tracker.weather || '' : '';
    if (/sun/i.test(weather)) {
      if (moveType === 'Fire') power *= 1.5;
      if (moveType === 'Water') power *= 0.5;
    } else if (/rain/i.test(weather)) {
      if (moveType === 'Water') power *= 1.5;
      if (moveType === 'Fire') power *= 0.5;
    }
    // Terrain
    const terrain = tracker ? tracker.terrain || '' : '';
    const attGrounded = this.grounded(att, tracker);
    const defGrounded = this.grounded(def, tracker);
    if (/electricterrain/i.test(terrain) && moveType === 'Electric' && attGrounded) power *= 1.3;
    if (/grassyterrain/i.test(terrain) && moveType === 'Grass' && attGrounded) power *= 1.3;
    if (/grassyterrain/i.test(terrain) && (move.id === 'earthquake' || move.id === 'bulldoze' || move.id === 'magnitude')) power *= 0.5;
    if (/psychicterrain/i.test(terrain) && moveType === 'Psychic' && attGrounded) power *= 1.3;
    if (/mistyterrain/i.test(terrain) && moveType === 'Dragon' && defGrounded) power *= 0.5;

    // Helping Hand planned by ally
    if (opts.helpingHand) power *= 1.5;
    // Charge (electric next)
    if (opts.charged && moveType === 'Electric') power *= 2;

    // STAB (with tera)
    const attTypes = att.teraType && (att.terastallized || opts.teraActive) ? [att.teraType] : (att.types || this.dex.species.get(att.species).types || []);
    const origTypes = att.types || this.dex.species.get(att.species).types || [];
    let stab = 1;
    const teraActive = !!(att.teraType && (att.terastallized || opts.teraActive));
    if (teraActive) {
      if (moveType === att.teraType) stab = origTypes.includes(moveType) ? 2 : 1.5;
      else if (origTypes.includes(moveType)) stab = 1.5;
    } else {
      if (origTypes.includes(moveType)) stab = 1.5;
    }
    if (attAbility === 'adaptability' && stab > 1) stab = 2;

    // Effectiveness
    let eff = this.effectiveness(moveType, def.types);
    // Freeze Dry vs Water
    if (move.id === 'freezedry' && def.types.includes('Water')) eff *= 2;
    // Flying Press: fighting + flying
    if (move.id === 'flyingpress') eff = this.effectiveness('Fighting', def.types) * this.effectiveness('Flying', def.types);
    // Thousand Arrows grounds flying
    if (move.id === 'thousandarrows' && def.types.includes('Flying')) {
      eff = this.effectiveness('Ground', def.types.filter(t => t !== 'Flying')) || 1;
    }
    // Ability immunities
    const imm = IMMUNITY_ABILITIES[defAbility];
    if (imm && imm.includes(moveType)) eff = 0;
    if (defAbility === 'soundproof' && move.flags && move.flags.sound) eff = 0;
    if (defAbility === 'wonderguard' && eff <= 1) eff = 0;
    if (defAbility === 'sapsipper' && moveType === 'Grass') eff = 0;
    // Scrappy / Mind's Eye
    if ((attAbility === 'scrappy' || attAbility === 'mindseye') && (moveType === 'Normal' || moveType === 'Fighting') && def.types.includes('Ghost') && eff === 0) {
      eff = this.effectiveness(moveType, def.types.filter(t => t !== 'Ghost')) || 1;
    }
    // Levitate vs Thousand Arrows: still immune
    if (move.id === 'thousandarrows' && defAbility === 'levitate') eff = 0;
    if (eff === 0) return zero;

    // Conditional power doublers
    if ((move.id === 'facade') && att.status) power *= 2;
    if ((move.id === 'brine') && (def.frac || 1) <= 0.5) power *= 2;
    if ((move.id === 'venoshock') && (def.status === 'psn' || def.status === 'tox')) power *= 2;
    if ((move.id === 'hex' || move.id === 'infernalparade') && def.status) power *= move.id === 'hex' ? 2 : 2;
    if ((move.id === 'barbbarrage') && (def.status === 'psn' || def.status === 'tox')) power *= 2;
    if ((move.id === 'wakeupslap') && def.status === 'slp') power *= 2;
    if ((move.id === 'smellingsalts') && def.status === 'par') power *= 2;
    if ((move.id === 'payback') && opts.moveLast) power *= 2;
    if ((move.id === 'assurance') && opts.foeDamaged) power *= 2;
    if ((move.id === 'retaliate') && opts.allyFaintedLastTurn) power *= 2;
    if ((move.id === 'lashout') && Object.values(att.boosts || {}).some(v => v < 0)) power *= 2;
    if ((move.id === 'poltergeist') && !def.item) power *= 0; // fails without item (assume foe has item? no—unknown; treat as usable? set 0 only if known no-item)
    if ((move.id === 'grassyglide' || move.id === 'surge') && false) { /* priority handled elsewhere */ }
    // Acrobatics (no item)
    if (move.id === 'acrobatics' && !att.item) power *= 2;
    // Knock Off (foe has item)
    if (move.id === 'knockoff' && def.item && !def.itemConsumed) power *= 1.5;
    // Aura Wheel / terrain pulse / weather ball type changes
    if (move.id === 'weatherball' && weather && !/none/i.test(weather)) {
      if (/sun/i.test(weather)) moveType = 'Fire';
      else if (/rain/i.test(weather)) moveType = 'Water';
      else if (/sand/i.test(weather)) moveType = 'Rock';
      else if (/hail|snow/i.test(weather)) moveType = 'Ice';
      power *= 2;
      eff = this.effectiveness(moveType, def.types);
      if (eff === 0) return zero;
    }
    // Body Press uses Def (handled), Foul Play uses foe Atk (handled)
    // Gen 1 Explosion: halve defense
    if (gen === 1 && (move.id === 'explosion' || move.id === 'selfdestruct')) D *= 0.5;

    // ---- base damage ----
    const level = att.level || 100;
    const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * A / Math.max(1, D)) / 50) + 2;

    // ---- crit ----
    let critMult = 1;
    if (alwaysCrit) critMult = gen >= 6 ? 1.5 : 2;

    // ---- spread reduction (doubles, hits multiple foes) ----
    let spreadMult = 1;
    if (opts.spread && this.doubles && gen >= 4) spreadMult = 0.75;

    // ---- accuracy (expected value) ----
    let acc = 1;
    if (move.accuracy !== true) {
      acc = (move.accuracy || 100) / 100;
      acc *= boostMultiplier((att.boosts && att.boosts.accuracy) || 0, true);
      acc /= boostMultiplier((def.boosts && def.boosts.evasion) || 0, true);
      if (attAbility === 'hustle' && isPhysical) acc *= 0.8;
      if (attAbility === 'compoundeyes') acc *= 1.3;
      if (attItem === 'widelens') acc *= 1.1;
      if (attItem === 'zoomlens' && opts.moveLast) acc *= 1.2;
      if (attAbility === 'noguard' || defAbility === 'noguard') acc = 1;
      if (attAbility === 'victorystar' || (opts.fieldAbilities && opts.fieldAbilities.has('victorystar'))) acc *= 1.1;
      if (/sand/i.test(weather) && defAbility === 'sandveil') acc *= 0.8;
      if (/hail|snow/i.test(weather) && defAbility === 'snowcloak') acc *= 0.8;
      acc = clamp(acc, 0, 1);
      // Thunder/Hurricane in rain/sun, Blizzard in hail/snow
      if ((move.id === 'thunder' || move.id === 'hurricane') && /rain/i.test(weather)) acc = 1;
      if ((move.id === 'thunder' || move.id === 'hurricane') && /sun/i.test(weather)) acc = 0.5;
      if (move.id === 'blizzard' && /hail|snow/i.test(weather)) acc = 1;
    }

    let mod = stab * eff * critMult * spreadMult;
    // Parental Bond
    if (attAbility === 'parentalbond' && !move.multihit && !['fling', 'iceball', 'rollout'].includes(move.id)) {
      mod *= gen >= 7 ? 1.25 : 1.5;
    }
    // Multihit total
    mod *= hits;
    // Burn already in A; Guts etc in A.

    const avgBase = base * mod;
    const avg = (avgBase * 0.925 * acc) / foeMaxHP;
    const min = (avgBase * 0.85 * (acc >= 1 ? 1 : acc)) / foeMaxHP;
    const max = (avgBase * 1.0) / foeMaxHP;
    return {avg, min, max};
  }

  // Estimated best threat from foe -> our mon (for defense/switch logic).
  // Uses revealed moves + STAB assumption.
  foeThreat(foe, mine, tracker) {
    let best = 0;
    const tried = new Set();
    for (const mv of foe.movesSeen || []) {
      tried.add(mv);
      const d = this.estimateDamage(
        {...foe, stats: foe.estStats, ability: foe.ability, item: foe.item, effSpe: foe.estStats.spe},
        {...mine, types: this.dex.species.get(mine.species).types || ['Normal'], maxhp: mine.maxhp},
        mv, tracker, {}
      );
      best = Math.max(best, d.avg);
    }
    // STAB assumption: 80-power STAB of each type
    for (const t of foe.types) {
      const fakeId = '__stab_' + toID(t);
      // emulate via struggle-like physical/special? use tackle-ish proxy per type with power 80:
      const proxy = t === 'Fighting' || t === 'Ground' || t === 'Rock' || t === 'Bug' || t === 'Ghost' || t === 'Flying' || t === 'Steel' || t === 'Normal' || t === 'Poison' ? 'tackleproxy' : 'tackleproxy';
      void proxy;
      const d = this.estimateDamageWithPower(foe, mine, t, 80, t, tracker);
      best = Math.max(best, d);
    }
    return best;
  }

  estimateDamageWithPower(foe, mine, moveType, power, stabType, tracker) {
    // quick proxy: physical if foe atk>spa else special
    const phys = foe.estStats.atk >= foe.estStats.spa;
    const A = (phys ? foe.estStats.atk : foe.estStats.spa) * boostMultiplier((foe.boosts[phys ? 'atk' : 'spa']) || 0);
    const D = phys ? mine.stats.def * boostMultiplier(mine.boosts.def || 0) : mine.stats.spd * boostMultiplier(mine.boosts.spd || 0);
    const level = foe.level || 100;
    const base = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * A / Math.max(1, D)) / 50) + 2;
    const stab = foe.types.includes(moveType) ? 1.5 : 1;
    const mineTypes = this.dex.species.get(mine.species).types || ['Normal'];
    const eff = this.effectiveness(moveType, mineTypes);
    return (base * stab * eff * 0.925) / Math.max(1, mine.maxhp);
  }

  // Move order: do we act before foe? (priority, then speed, trick room)
  movePriority(moveId, ability, item, hpFrac, activeTurns) {
    const move = this.dex.moves.get(moveId);
    let pri = (move && move.priority) || 0;
    const ab = toID(ability || '');
    if (ab === 'prankster' && move && move.category === 'Status') pri += 1;
    if (ab === 'galewings' && move && move.type === 'Flying' && (hpFrac === undefined || hpFrac >= 1)) pri += 1;
    if (ab === 'triage' && move && (move.flags && move.flags.heal)) pri += 3;
    if (ab === 'stall' || ab === 'myceliummight' && move && move.category === 'Status') pri -= 0; // stall: always last handled via flag
    if (ab === 'quickdraw') pri += 0.1; // random; slight edge
    return pri;
  }

  actsFirst(mine, mineSpe, moveId, foe, foeSpe, tracker) {
    const myPri = this.movePriority(moveId, mine.ability, mine.item, mine.frac, mine.activeTurns);
    // estimate foe priority: max of seen moves (assume they attack with best)
    let foePri = 0;
    for (const mv of foe.movesSeen || []) {
      foePri = Math.max(foePri, this.movePriority(mv, foe.ability, foe.item, foe.frac, foe.activeTurns));
    }
    if (myPri !== foePri) return myPri > foePri;
    const tr = tracker && tracker.trickroom;
    if (tr) return mineSpe < foeSpe;
    return mineSpe > foeSpe;
  }

  // Priority move blocked? (psychic terrain / queenly majesty etc.)
  priorityBlocked(moveId, att, def, tracker) {
    const move = this.dex.moves.get(moveId);
    if (!move || (move.priority || 0) <= 0) return false;
    if (toID(att.ability || '') === 'stall') return false;
    if (PRIORITY_BLOCKERS.has(toID(def.ability || ''))) return true;
    if (tracker && /psychicterrain/i.test(tracker.terrain || '') && this.grounded(def, tracker)) return true;
    return false;
  }

  // -- action decision -------------------------------------------------------
  decideActions(request, tracker, rejected) {
    const activeReq = request.active || [];
    const hasActive = Array.isArray(request.active);
    const forceSwitch = Array.isArray(request.forceSwitch) ? request.forceSwitch : (request.forceSwitch ? [true] : []);
    const n = hasActive ? Math.max(activeReq.length, forceSwitch.length, 1) : Math.max(forceSwitch.length, 1);
    const mons = this.ownMons(request, tracker);
    const alive = mons.filter(m => !m.fainted);
    // map active slots -> team mon (order of appearance)
    const actives = mons.filter(m => m.active);
    const foes = this.foeMons(tracker);
    const foeSides = tracker ? tracker.sides[tracker.foeSide] : {hazards: {}, screens: {}, tailwind: false};
    const mySideCond = tracker ? tracker.sides[tracker.mySide] : {hazards: {}, screens: {}, tailwind: false};

    const decisions = [];
    const planned = new Map(); // foePos -> planned frac damage
    const allyPlans = new Map(); // slot -> plan summary (for HH/spread-dodge)
    const claimedSwitch = new Set(); // bench indices targeted this turn (dup switch = illegal)

    // Pass 1: forced switches first (mandatory; they claim bench targets).
    for (let slot = 0; slot < n; slot++) {
      if (!forceSwitch[slot]) continue;
      const posIdx = tracker && tracker.active && tracker.active[tracker.mySide] ? tracker.active[tracker.mySide][slot] : undefined;
      const mine = (posIdx !== undefined && mons[posIdx]) || actives[slot] || actives[0];
      const to = this.bestSwitch(mine, mons, foes, tracker, mySideCond, null, claimedSwitch);
      if (to && to.index >= 0) {
        claimedSwitch.add(to.index);
        decisions.push({slot, action: 'switch', switchTo: to.index, forced: true});
      } else {
        // No legal bench (e.g. double faint, one reserve): pass is accepted.
        decisions.push({slot, action: 'pass', forced: true});
      }
      allyPlans.set(slot, {switching: true});
    }

    for (let slot = 0; slot < n; slot++) {
      if (forceSwitch[slot]) continue; // handled in pass 1
      const aReq = activeReq[slot];
      if (!hasActive) {
        // Mid-turn pure-force request: slots without force flag are locked — omit them.
        decisions.push({slot, action: 'omit'});
        continue;
      }
      if (!aReq || !aReq.moves) {
        // Locked slot in a full request (already chose): positional pass.
        decisions.push({slot, action: 'pass'});
        continue;
      }
      if (slotMonFainted(request, slot)) {
        // Fainted mon with moves offered (no bench to switch to): pass, else
        // "more choices than unfainted" — actions for dead slots are illegal.
        decisions.push({slot, action: 'pass'});
        continue;
      }
      const posIdx = tracker && tracker.active && tracker.active[tracker.mySide] ? tracker.active[tracker.mySide][slot] : undefined;
      const mine = (posIdx !== undefined && mons[posIdx]) || actives[slot] || actives[0];
      const dec = this.decideSlot(slot, aReq, mine, mons, foes, tracker, mySideCond, foeSides, planned, allyPlans, alive, claimedSwitch);
      if (dec.action === 'switch' && dec.switchTo >= 0) claimedSwitch.add(dec.switchTo);
      decisions.push(dec);
      // record plan
      if (dec.action === 'move' && dec.planInfo) {
        if (dec.planInfo.targetFoePos !== undefined && dec.planInfo.targetFoePos !== null) {
          const k = dec.planInfo.targetFoePos;
          planned.set(k, (planned.get(k) || 0) + (dec.planInfo.frac || 0));
        }
        allyPlans.set(slot, dec.planInfo);
      } else if (dec.action === 'switch') {
        allyPlans.set(slot, {switching: true});
      }
    }

    const choiceString = this.serialize(decisions, request, n);
    if (rejected.has(choiceString)) {
      // try safe alternative
      return safeFallback(request, this.doubles, rejected);
    }
    this.lastChoice = choiceString;
    return {kind: 'actions', decisions, choiceString};
  }

  decideSlot(slot, aReq, mine, mons, foes, tracker, mySideCond, foeSides, planned, allyPlans, alive, excludeSwitch) {
    if (!mine) {
      return {slot, action: 'pass'};
    }
    if (!aReq.moves || !aReq.moves.length) return {slot, action: 'pass'};
    const trapped = !!(aReq.trapped || aReq.maybeTrapped);
    // usable moves
    const moves = (aReq.moves || []).map((m, i) => ({...m, index: i})).filter(m => !m.disabled && m.pp !== 0); // pp absent (gen1 Fight, locked) = must pick it
    const foeList = foes.filter(f => !f.fainted);
    const noFoeInfo = foeList.length === 0;

    // If no moves usable -> must switch (or struggle via move 1)
    if (!moves.length) {
      if (!trapped) {
        const to = this.bestSwitch(mine, mons, foes, tracker, mySideCond, null, excludeSwitch);
        if (to && to.index >= 0) return {slot, action: 'switch', switchTo: to.index};
      }
      return {slot, action: 'move', moveIndex: 0, target: null, gimmick: null}; // struggle
    }

    let best = null;
    // alle ally slot (doubles)
    const allySlot = this.doubles ? (slot === 0 ? 1 : 0) : -1;
    const allyPlan = allySlot >= 0 ? allyPlans.get(allySlot) : null;

    for (const mv of moves) {
      const cands = this.scoreMoveTargets(slot, mv, mine, mons, foeList, tracker, mySideCond, foeSides, planned, allyPlan, noFoeInfo, aReq);
      for (const c of cands) {
        if (!best || c.score > best.score) best = c;
      }
    }

    // Consider switching (voluntary)
    if (!trapped) {
      const stayScore = best ? best.score : 0;
      const to = this.bestSwitch(mine, mons, foes, tracker, mySideCond, stayScore, excludeSwitch);
      const margin = this.voluntarySwitchStreak > 0 ? 1.7 : 1.35;
      const need = stayScore * margin + 8;
      // also allow switch when staying is useless and a good switch exists
      const panicSwitch = stayScore < 15 && to && to.score > 45 && this.voluntarySwitchStreak < 2;
      if (to !== null && to !== undefined && (to.score > need || panicSwitch)) {
        this.voluntarySwitchStreak++;
        return {slot, action: 'switch', switchTo: to.index, score: to.score};
      }
    } else {
      // trapped: pivot moves already bonused in scoring
    }

    if (!best) {
      // fallback: first move, default target
      const mv = moves[0];
      this.voluntarySwitchStreak = 0;
      return {slot, action: 'move', moveIndex: mv.index, target: this.defaultTarget(mv, slot, foeList), gimmick: this.defaultGimmick(aReq, mv)};
    }
    best.isVoluntarySwitch = false;
    this.voluntarySwitchStreak = 0;
    return best;
  }

  scoreMoveTargets(slot, mv, mine, mons, foeList, tracker, mySideCond, foeSides, planned, allyPlan, noFoeInfo, aReq) {
    const out = [];
    const move = this.dex.moves.get(mv.id);
    const targetKind = (mv.target || (move && move.target) || 'self'); // unknown: attach nothing
    const allySlot = this.doubles ? (slot === 0 ? 1 : 0) : -1;
    let allyMon = null;
    if (allySlot >= 0) {
      const aIdx = tracker && tracker.active && tracker.active[tracker.mySide] ? tracker.active[tracker.mySide][allySlot] : undefined;
      allyMon = (aIdx !== undefined && mons[aIdx]) || mons.filter(m => m.active)[allySlot] || null;
      if (allyMon === mine) allyMon = mons.filter(m => m.active).find(m => m !== mine) || null;
    }

    const pushTarget = (target, foe, allyTarget) => {
      const s = this.scoreMove(slot, mv, move, mine, foe, allyMon, tracker, mySideCond, foeSides, planned, allyPlan, noFoeInfo, aReq, targetKind);
      out.push({slot, action: 'move', moveIndex: mv.index, target, gimmick: s.gimmick || null, score: s.score, planInfo: s.planInfo});
    };

    if (targetKind === 'normal' || targetKind === 'any') {
      if (!foeList.length) {
        pushTarget(this.doubles ? 1 : null, null, null);
      } else {
        for (const foe of foeList) pushTarget(foe.pos + 1, foe, null);
        // 'any' moves usable on ally? (e.g., acupressure) — skip ally targeting except helping-hand-like
      }
    } else if (targetKind === 'adjacentAlly' || targetKind === 'adjacentAllyOrSelf') {
      pushTarget(allyMon ? -(allySlot + 1) : null, null, allyMon);
    } else if (targetKind === 'allAdjacentFoes' || targetKind === 'allAdjacent' || targetKind === 'all' || targetKind === 'foes') {
      pushTarget(null, null, null); // spread; scoring sums over foes
    } else {
      // self, allySide, foeSide, allyTeam, field, randomNormal, scripted...
      pushTarget(null, null, null);
    }
    return out;
  }

  scoreMove(slot, mv, move, mine, foe, allyMon, tracker, mySideCond, foeSides, planned, allyPlan, noFoeInfo, aReq, targetKind) {
    const gen = this.gen;
    const moveId = mv.id;
    const planInfo = {};
    let gimmick = null;

    if (!move || !move.exists) return {score: -1000, gimmick, planInfo};

    // Priority blocked?
    if (foe && this.priorityBlocked(moveId, mine, foe, tracker)) {
      return {score: -500, gimmick, planInfo};
    }

    // Fake Out only turn 1
    if (moveId === 'fakeout' && mine.activeTurns > 0) return {score: -500, gimmick, planInfo};
    // Dodge ally spread (Earthquake etc.)
    if (allyPlan && allyPlan.hitsAlly > 0.12 && /^(protect|detect|endure|obstruct|silktrap|banefulbunker|burningbulwark|matblock)$/.test(moveId)) {
      return {score: 95, gimmick, planInfo: {dodge: true}};
    }

    const myEffSpe = this.effSpeed(mine, mySideCond, tracker, false);
    const foeEffSpe = foe ? this.effSpeed(foe, foeSides, tracker, true) : 0;

    // Attach effSpe for damage calc
    const att = {...mine, types: this.dex.species.get(mine.species).types || ['Normal'], effSpe: myEffSpe};
    const fieldAbilities = new Set();
    for (const m of [mine, allyMon]) if (m && m.ability) fieldAbilities.add(toID(m.ability));
    if (tracker) for (const {poke} of tracker.foeActive()) if (poke.ability) fieldAbilities.add(toID(poke.ability));

    // ---- damaging moves ----
    const isDamaging = move.category !== 'Status' && (move.basePower || FIXED_DAMAGE[move.id] || move.ohko || move.id === 'superfang' || move.id === 'endeavor' || move.id === 'finalgambit' || move.id === 'psywave' || move.id === 'seismictoss' || move.id === 'nightshade' || move.id === 'dragonrage' || move.id === 'sonicboom');
    if (isDamaging) {
      // Spread handling
      const isSpreadFoes = targetKind === 'allAdjacentFoes' || targetKind === 'all' || (move.id === 'dragondarts' && (foe === null));
      const hitsAlly = targetKind === 'allAdjacent';
      const targets = [];
      if (isSpreadFoes || hitsAlly) {
        // all adjacent foes (+ ally for allAdjacent)
        if (tracker) {
          for (const {poke, pos} of tracker.foeActive()) {
            if (!poke.fainted) targets.push(this.richFoe(poke, pos, tracker));
          }
        }
      } else if (foe) {
        targets.push(foe);
      }
      if (!targets.length && noFoeInfo) {
        // blind: score by power + STAB guess
        const stabGuess = (this.dex.species.get(mine.species).types || []).includes(move.type) ? 1.5 : 1;
        let score = (move.basePower || 60) * stabGuess * (move.accuracy === true ? 1 : (move.accuracy || 90) / 100);
        if (move.priority > 0) score += 10;
        const g = this.chooseGimmick(aReq, mv, mine, null, 1, tracker);
        return {score, gimmick: g, planInfo: {blind: true, frac: 0.3}};
      }
      if (!targets.length) return {score: -1000, gimmick, planInfo};

      let total = 0;
      let bestTargetFrac = 0;
      let targetFoePos = null;
      const spread = targets.length > 1;
      for (const t of targets) {
        const tWithSpe = {...t, effSpe: this.effSpeed(t, foeSides, tracker, true)};
        const d = this.estimateDamage(att, tWithSpe, moveId, tracker, {
          attSide: mySideCond, defSide: foeSides, spread,
          movePP: mv.pp, moveLast: !(myEffSpe > tWithSpe.effSpe),
          fieldAbilities,
          foeDamaged: (planned.get(t.pos) || 0) > 0,
          faintedAllies: 0,
          twoFoes: targets.length > 1,
        });
        let remaining = (t.frac || 1) - (planned.get(t.pos) || 0);
        remaining = Math.max(0, remaining);
        let s = d.avg * 100;
        if (d.min >= remaining && remaining > 0) s += 120; // guaranteed KO
        else if (d.avg >= remaining && remaining > 0) s += 90; // likely KO
        else if (d.max >= remaining && remaining > 0) s += 30; // possible KO
        // move-order discount: if foe KOs us first, our damage may not happen
        const threat = this.estimateDamageWithPower(t, mine, t.types[0], 80, t.types[0], tracker);
        const first = this.actsFirst(mine, myEffSpe, moveId, t, tWithSpe.effSpe, tracker);
        if (!first && threat >= (mine.frac || 1) && !(mine.item === 'focussash' && (mine.frac || 1) >= 1)) {
          s *= 0.25;
        }
        // Sucker Punch: needs foe to attack
        if (moveId === 'suckerpunch') {
          const foeAttacks = !t.lastMove || this.dex.moves.get(t.lastMove).category !== 'Status';
          s *= foe.lastMove ? (foeAttacks ? 0.9 : 0.35) : 0.7;
        }
        // secondary effects
        if (move.secondary) {
          const sec = move.secondary;
          const chance = (sec.chance || 100) / 100;
          if (sec.volatileStatus === 'flinch' && first) s += 12 * chance;
          if (sec.status) s += 8 * chance;
          if (sec.boosts) {
            const drops = Object.values(sec.boosts).filter(v => v < 0).length;
            const ups = Object.values(sec.boosts).filter(v => v > 0).length;
            s += (drops * 6 + ups * 8) * chance;
            if ((sec.boosts.spe || 0) < 0 && tWithSpe.effSpe > myEffSpe) s += 18 * chance; // speed control
          }
          if (sec.self && sec.self.boosts) s += 10 * chance;
        }
        if (move.self && move.self.boosts) s += 12;
        // draining
        if (move.drain) {
          const heal = d.avg * (move.drain[0] / move.drain[1]);
          s += heal * 60;
        }
        // recoil
        if (move.recoil && move.recoil !== true) {
          const rec = d.avg * (move.recoil[0] / move.recoil[1]);
          s -= rec * 50;
          if (rec >= (mine.frac || 1) && d.avg < (t.frac || 1)) s -= 80; // suicide without KO
        }
        if (move.mindBlownRecoil || move.id === 'steelbeam') {
          const rec = 0.5;
          s -= rec * 40;
        }
        // crash
        if (move.crash) {
          const acc = move.accuracy === true ? 1 : (move.accuracy || 90) / 100;
          s -= (1 - acc) * 60 + 5;
        }
        // charging / recharge
        if (move.flags && move.flags.charge && mine.item !== 'powerherb') {
          const noCharge = (move.id === 'solarbeam' || move.id === 'solarblade') && tracker && /sun/i.test(tracker.weather || '');
          if (!noCharge) s *= 0.6;
          if ((move.id === 'solarbeam' || move.id === 'solarblade') && tracker && /rain|sand|hail|snow/i.test(tracker.weather || '')) s *= 0.5;
        }
        if (move.flags && move.flags.recharge && !(d.avg >= (t.frac || 1))) s *= 0.75;
        if (gen === 1 && (move.id === 'hyperbeam') && !(d.avg >= (t.frac || 1))) s *= 0.7;
        // pivot bonus
        if (move.selfSwitch || move.id === 'uturn' || move.id === 'voltswitch' || move.id === 'flipturn' || move.id === 'partingshot' || move.id === 'chillyreception' || move.id === 'shedtail') {
          if (threat > 0.45 || this.badMatchup(mine, t)) s += 18;
          else s += 6;
        }
        // trapping
        if (move.volatileStatus && /partiallytrapped|trapped|meanlook|octolock|noretreat|jawlock/i.test(move.volatileStatus)) s += 8;
        // phazing damage
        if (move.forceSwitch && (Object.values(t.boosts).some(v => v > 0) || Object.keys(foeSides.hazards || {}).length)) s += 15;
        // knock off
        if (move.id === 'knockoff') s += t.item && !t.itemConsumed ? 15 : 8;
        // rapid spin / mortal spin / defog removal
        if ((move.id === 'rapidspin' || move.id === 'mortalspin' || move.id === 'tidyup' || move.id === 'courtchange') && Object.keys(mySideCond.hazards || {}).length) s += 20;
        if (move.id === 'defog' && (Object.keys(mySideCond.hazards || {}).length || Object.keys(foeSides.screens || {}).length)) s += 15;
        // Ally hit (Earthquake etc.)
        total += s;
        if (s > bestTargetFrac) { bestTargetFrac = s; targetFoePos = t.pos; }
      }
      if (hitsAlly && allyMon && !allyMon.fainted) {
        // subtract ally damage
        const allyTypes = this.dex.species.get(allyMon.species).types || ['Normal'];
        const allyDef = {...allyMon, types: allyTypes, maxhp: allyMon.maxhp, estStats: allyMon.stats, effSpe: this.effSpeed(allyMon, mySideCond, tracker, false)};
        const d = this.estimateDamage(att, allyDef, moveId, tracker, {attSide: mySideCond, defSide: mySideCond, spread: true, fieldAbilities});
        const allyPlan = planned; // ally may protect?
        total -= d.avg * 150;
        if (d.avg >= (allyMon.frac || 1)) total -= 120; // kills ally!
        planInfo.hitsAlly = d.avg;
      }
      // Gimmick choice (based on best target)
      const mainT = targets.find(t => t.pos === targetFoePos) || targets[0];
      const mainD = this.estimateDamage(att, {...mainT, effSpe: this.effSpeed(mainT, foeSides, tracker, true)}, moveId, tracker, {attSide: mySideCond, defSide: foeSides, spread, movePP: mv.pp, fieldAbilities, twoFoes: targets.length > 1});
      gimmick = this.chooseGimmick(aReq, mv, mine, mainT, mainD, tracker);
      if (gimmick === 'zmove') total += 25;
      if (gimmick === 'terastallize') total += 20;
      if (gimmick === 'dynamax') total += 20;
      planInfo.frac = mainD.avg;
      planInfo.targetFoePos = targetFoePos;
      return {score: total, gimmick, planInfo};
    }

    // ---- status / support moves ----
    const score = this.scoreStatusMove(slot, mv, move, mine, foe, allyMon, tracker, mySideCond, foeSides, myEffSpe, foeEffSpe, mons => mons);
    return {score, gimmick, planInfo};
  }

  badMatchup(mine, foe) {
    if (!foe) return false;
    const threat = this.estimateDamageWithPower(foe, mine, foe.types[0], 80, foe.types[0], null);
    return threat > 0.5 && (mine.frac || 1) < 0.7;
  }

  chooseGimmick(aReq, mv, mine, foe, mainD, tracker) {
    // mainD: {avg,min,max} fractions (or number for blind)
    if (aReq.canMegaEvo || aReq.canUltraBurst) return aReq.canMegaEvo ? 'mega' : 'ultra';
    const avgFrac = typeof mainD === 'number' ? mainD : (mainD ? mainD.avg : 0);
    const minFrac = typeof mainD === 'number' ? mainD : (mainD ? mainD.min : 0);
    const foeFrac = foe ? (foe.frac || 1) : 1;
    // Z
    if (Array.isArray(aReq.canZMove) && aReq.canZMove[mv.index]) {
      const move = this.dex.moves.get(mv.id);
      if (move.category !== 'Status' && foe) {
        // Z if it bridges to KO
        const zEst = avgFrac * (zPower(move.basePower || 100) / Math.max(1, move.basePower || 100));
        if (avgFrac < foeFrac && zEst >= foeFrac * 0.95) return 'zmove';
      }
    }
    // Dynamax
    if (aReq.canDynamax && foe && (mine.frac || 1) > 0.5 && avgFrac >= 0.45) return 'dynamax';
    // Tera
    if (aReq.canTerastallize && foe) {
      const teraType = typeof aReq.canTerastallize === 'string' ? aReq.canTerastallize : mine.teraType;
      const move = this.dex.moves.get(mv.id);
      // offensive: tera STAB bridges to KO
      if (move.category !== 'Status' && move.type === teraType && avgFrac < foeFrac && avgFrac * 1.5 >= foeFrac * 0.9) {
        return 'terastallize';
      }
      // defensive: foe STAB threatens, tera resists
      const threat = this.estimateDamageWithPower(foe, mine, foe.types[0], 90, foe.types[0], tracker);
      if (threat >= (mine.frac || 1) * 0.85) {
        const effBefore = this.effectiveness(foe.types[0], this.dex.species.get(mine.species).types || ['Normal']);
        const effAfter = this.effectiveness(foe.types[0], [teraType]);
        if (effAfter < effBefore && effAfter <= 0.5) return 'terastallize';
      }
    }
    return null;
  }

  defaultGimmick(aReq, mv) {
    if (aReq.canMegaEvo) return 'mega';
    if (aReq.canUltraBurst) return 'ultra';
    return null;
  }

  defaultTarget(mv, slot, foeList) {
    const move = this.dex.moves.get(mv.id);
    const tk = mv.target || (move && move.target) || 'self'; // unknown: attach nothing
    if (!this.doubles) return null;
    if (tk === 'normal' || tk === 'any') {
      const f = (foeList || []).find(f => !f.fainted) || (foeList || [])[0];
      return f ? f.pos + 1 : 1;
    }
    if (tk === 'adjacentAlly' || tk === 'adjacentAllyOrSelf') return -(slot === 0 ? 2 : 1);
    return null;
  }

  // ---- status move scoring ----
  scoreStatusMove(slot, mv, move, mine, foe, allyMon, tracker, mySideCond, foeSides, myEffSpe, foeEffSpe) {
    const moveId = mv.id;
    const gen = this.gen;
    // self-targeting ally moves (Helping Hand etc.)
    if (foe === null || foe === undefined) {
      // could be self/side/field/ally move
    }
    const foeGrounded = foe ? this.grounded(foe, tracker) : true;

    switch (true) {
      // --- protection ---
      case /^(protect|detect|endure|obstruct|silktrap|banefulbunker|burningbulwark)$/.test(moveId): {
        if (moveId === 'endure' && (mine.frac || 1) > 0.3) return 5;
        // dodge ally spread
        // (allyPlan passed separately; approximate via allyMon? skip here, handled by caller? no—simple)
        if (foe) {
          const threat = this.estimateDamageWithPower(foe, mine, foe.types[0], 90, foe.types[0], tracker);
          const first = foeEffSpe > myEffSpe;
          if (threat >= (mine.frac || 1) && first) return 55; // scout/survive? (protect doesn't help vs KO unless ally KOs)
          if ((mine.frac || 1) < 0.35 && threat > 0.2 && this.doubles) return 45;
          if (foe.lastMove === 'fakeout' && this.doubles) return 30;
          if (mine.status === 'tox') return 25; // stall toxic
        }
        return this.doubles ? 12 : 6;
      }
      case moveId === 'matblock': return mine.activeTurns === 0 && this.doubles ? 18 : 2;
      case moveId === 'wideguard': {
        if (!this.doubles) return 2;
        const foeSpread = foe && (foe.movesSeen || []).some(m => {
          const md = this.dex.moves.get(m);
          return md && (md.target === 'allAdjacentFoes' || md.target === 'allAdjacent');
        });
        return foeSpread ? 35 : 6;
      }
      case moveId === 'quickguard': {
        const foePri = foe && (foe.movesSeen || []).some(m => (this.dex.moves.get(m).priority || 0) > 0);
        return foePri ? 30 : 4;
      }
      case moveId === 'craftyshield': return this.doubles ? 10 : 2;
      // --- redirection ---
      case moveId === 'followme' || moveId === 'ragepowder': {
        if (!this.doubles || !allyMon || allyMon.fainted) return 0;
        if (!this.grounded(mine, tracker) && moveId === 'ragepowder') { /* powder still works? holder grounded irrelevant */ }
        if (foe && foe.ability === 'propellertail' || foe && foe.ability === 'stalwart') return 5;
        let s = 20;
        if ((allyMon.frac || 1) < 0.45) s += 20; // protect weak ally
        // if ally is a setupper/sweeper at high HP, still decent
        if ((mine.frac || 1) > 0.6) s += 8; else s -= 15;
        return s;
      }
      case moveId === 'spotlight': return this.doubles ? 25 : 0;
      case moveId === 'allyswitch': return 6;
      // --- helping hand ---
      case moveId === 'helpinghand': {
        // ally planned attack? (caller passes allyPlan? we don't have it here—approximate)
        if (!allyMon || allyMon.fainted) return 0;
        return 28; // usually good in doubles when partner attacks
      }
      case moveId === 'afteryou' || moveId === 'quash': return 8;
      // --- fake out handled in damage (damaging). ---
      // --- recovery ---
      case RECOVERY_MOVES.has(moveId): {
        if (moveId === 'healpulse' || moveId === 'floralhealing') {
          if (allyMon && !allyMon.fainted && (allyMon.frac || 1) < 0.55) return 45;
          return 5;
        }
        if (moveId === 'lifedew' || moveId === 'junglehealing') {
          return (mine.frac || 1) < 0.6 ? 40 : 10;
        }
        if (moveId === 'rest') {
          if ((mine.frac || 1) > 0.55) return 4;
          if (mine.status === 'slp') return 2;
          const threat = foe ? this.estimateDamageWithPower(foe, mine, foe.types[0], 80, foe.types[0], tracker) : 0;
          if (threat > 0.55) return 8; // will die sleeping?/still heals... risky
          return 38;
        }
        if (moveId === 'strengthsap') {
          if (!foe) return 10;
          return (mine.frac || 1) < 0.75 ? 42 : 12;
        }
        if (moveId === 'moonlight' || moveId === 'morningsun' || moveId === 'synthesis') {
          const w = tracker ? tracker.weather || '' : '';
          let heal = 0.5;
          if (/sun/i.test(w)) heal = 0.667; else if (/rain|sand|hail|snow/i.test(w)) heal = 0.25;
          if ((mine.frac || 1) > 1 - heal) return 4;
          return heal >= 0.5 ? 40 : 22;
        }
        if (moveId === 'shoreup' && tracker && /sand/i.test(tracker.weather || '')) {
          return (mine.frac || 1) < 0.6 ? 45 : 6;
        }
        if ((mine.frac || 1) > 0.72) return 3;
        return 42;
      }
      // --- status infliction ---
      case moveId === 'thunderwave' || moveId === 'glare' || moveId === 'stunspore' || moveId === 'nuzzle': {
        if (!foe || foe.status) return 2;
        if ((moveId === 'thunderwave' || moveId === 'nuzzle') && gen >= 6 && foe.types.includes('Electric')) return 0;
        if (moveId === 'glare' && foe.types.includes('Ghost')) return 0;
        if (moveId === 'stunspore' && gen >= 6 && foe.types.includes('Grass')) return 0;
        if (foe.ability === 'limber' || foe.ability === 'leafguard' && tracker && /sun/i.test(tracker.weather || '')) return 2;
        let s = 26;
        if (foeEffSpe > myEffSpe) s += 14;
        if (foe.ability === 'guts' || foe.ability === 'marvelscale' || foe.ability === 'quickfeet') s -= 12;
        return s;
      }
      case moveId === 'toxic' || moveId === 'poisonpowder' || moveId === 'poisonfang' || moveId === 'toxicthread': {
        if (!foe || foe.status) return 2;
        if (foe.types.includes('Poison') || foe.types.includes('Steel')) return 0;
        if (moveId === 'poisonpowder' && gen >= 6 && foe.types.includes('Grass')) return 0;
        if (foe.ability === 'immunity' || foe.ability === 'leafguard' && tracker && /sun/i.test(tracker.weather || '')) return 2;
        if (foe.ability === 'guts' || foe.ability === 'marvelscale' || foe.ability === 'quickfeet' || foe.ability === 'toxicboost') return 6;
        return (foe.maxhp || 300) > 300 ? 34 : 26;
      }
      case moveId === 'willowisp' || moveId === 'inferno' || moveId === 'blueflare' || moveId === 'sizzlyslide': {
        if (!foe || foe.status) return 2;
        if (foe.types.includes('Fire')) return 0;
        if (foe.ability === 'waterveil' || foe.ability === 'flamebody' || foe.ability === 'flashfire' || foe.ability === 'thermalexchange') return 2;
        if (foe.ability === 'guts' || foe.ability === 'marvelscale' || foe.ability === 'quickfeet' || foe.ability === 'flareboost') return 4;
        let s = 26;
        if ((foe.estStats.atk || 100) >= (foe.estStats.spa || 100)) s += 8;
        return s;
      }
      case /^(spore|sleeppowder|hypnosis|lovelykiss|sing|grasswhistle|yawn|darkvoid)$/.test(moveId): {
        if (!foe || foe.status) return 2;
        if ((moveId === 'spore' || moveId === 'sleeppowder') && gen >= 6 && foe.types.includes('Grass')) return 0;
        if (foe.ability === 'insomnia' || foe.ability === 'vitalspirit' || foe.ability === 'sweetveil' || foe.ability === 'leafguard' && tracker && /sun/i.test(tracker.weather || '')) return 2;
        if (tracker && /electricterrain|mistyterrain/i.test(tracker.terrain || '') && this.grounded(foe, tracker)) return 2;
        // sleep clause: another foe asleep?
        if (tracker) {
          const sleeping = tracker.foeTeam().filter(p => !p.fainted && p.status === 'slp').length;
          if (sleeping > 0) return 3;
        }
        if (moveId === 'yawn') return 18;
        return moveId === 'spore' ? 38 : 26;
      }
      // --- hazards ---
      case moveId === 'stealthrock': {
        const foeTeam = tracker ? tracker.foeTeam().filter(p => !p.fainted) : [];
        if (foeSides.hazards && foeSides.hazards.stealthrock) return 2;
        if (foeTeam.length <= 1) return 8;
        let weak = 0;
        for (const p of foeTeam) {
          const sp = this.dex.species.get(p.species);
          weak += this.effectiveness('Rock', sp.types || ['Normal']);
        }
        return 14 + weak * 4;
      }
      case /^(spikes|toxicspikes|stickyweb)$/.test(moveId): {
        const key = moveId.replace('toxicspikes', 'toxicspikes');
        const cur = (foeSides.hazards && (foeSides.hazards.spikes || foeSides.hazards.toxicspikes || foeSides.hazards.stickyweb)) || 0;
        if (cur >= (moveId === 'stickyweb' ? 1 : moveId === 'spikes' ? 3 : 2)) return 2;
        if (moveId === 'stickyweb') return 16;
        return 14;
      }
      case moveId === 'ceaselessedge' || moveId === 'stoneaxe': {
        return 10; // damaging hazards handled in damage + bonus? (these are damaging; here for safety)
      }
      // --- removal ---
      case /^(rapidspin|mortalspin|defog|tidyup|courtchange)$/.test(moveId): {
        let s = 4;
        if (Object.keys(mySideCond.hazards || {}).length) s += 22;
        if (moveId === 'defog' && Object.keys(foeSides.screens || {}).length) s += 10;
        if (moveId === 'courtchange' && Object.keys(foeSides.hazards || {}).length) s += 18;
        return s;
      }
      // --- setup ---
      case !!SETUP_MOVES[moveId]: {
        if (moveId === 'bellydrum' && (mine.frac || 1) < 0.6) return 2;
        if (!foe) return 12;
        const threat = this.estimateDamageWithPower(foe, mine, foe.types[0], 90, foe.types[0], tracker);
        if (threat >= (mine.frac || 1)) return 4; // dies setting up
        if (threat >= (mine.frac || 1) * 0.6 && foeEffSpe > myEffSpe) return 8;
        let s = 22;
        if (threat < 0.25) s += 10;
        if (foe.status === 'slp' || foe.status === 'frz') s += 12;
        if (moveId === 'shellsmash' || moveId === 'bellydrum' || moveId === 'tailglow' || moveId === 'shiftgear') s += 6;
        // already boosted a lot? diminishing
        const tot = Object.values(mine.boosts || {}).reduce((a, b) => a + Math.max(0, b), 0);
        if (tot >= 6) s -= 15;
        return s;
      }
      case moveId === 'swordsdance' || moveId === 'howl' || moveId === 'meditate' || moveId === 'sharpen' || moveId === 'powertrick': {
        return 18;
      }
      // --- screens ---
      case moveId === 'reflect' || moveId === 'lightscreen': {
        if (mySideCond.screens && (mySideCond.screens.reflect || mySideCond.screens.lightscreen || mySideCond.screens.auroraveil)) return 3;
        return 16;
      }
      case moveId === 'auroraveil': {
        const w = tracker ? tracker.weather || '' : '';
        if (!/hail|snow/i.test(w)) return 0;
        if (mySideCond.screens && (mySideCond.screens.reflect || mySideCond.screens.auroraveil)) return 3;
        return 20;
      }
      // --- weather / terrain ---
      case /^(raindance|sunnyday|sandstorm|hail|snowscape|chillyreception)$/.test(moveId): {
        const w = tracker ? tracker.weather || '' : '';
        if (moveId === 'raindance' && /rain/i.test(w)) return 2;
        if (moveId === 'sunnyday' && /sun/i.test(w)) return 2;
        if ((moveId === 'hail' || moveId === 'snowscape') && /hail|snow/i.test(w)) return 2;
        if (moveId === 'sandstorm' && /sand/i.test(w)) return 2;
        // does our team benefit?
        let s = 10;
        const ab = toID(mine.ability || '');
        if ((moveId === 'raindance' && ['swiftswim', 'hydration', 'raindish', 'dryskin'].includes(ab)) ||
            (moveId === 'sunnyday' && ['chlorophyll', 'flowergift', 'leafguard', 'solarpower', 'protosynthesis'].includes(ab)) ||
            (moveId === 'sandstorm' && ['sandrush', 'sandforce', 'sandveil'].includes(ab))) s += 14;
        if (moveId === 'chillyreception') s += 12; // pivots too
        return s;
      }
      case /^(electricterrain|grassyterrain|psychicterrain|mistyterrain)$/.test(moveId): {
        const t = tracker ? tracker.terrain || '' : '';
        if (t && toID(t).includes(toID(moveId).replace('terrain', ''))) return 2;
        return 12;
      }
      case moveId === 'trickroom': {
        if (tracker && tracker.trickroom) return 2;
        // are we slower?
        if (foe && myEffSpe < foeEffSpe) return 30;
        return 8;
      }
      case moveId === 'tailwind': {
        if (mySideCond.tailwind) return 2;
        if (foe && myEffSpe < foeEffSpe && myEffSpe * 2 > foeEffSpe) return 34;
        return 14;
      }
      // --- disruption ---
      case moveId === 'taunt': {
        if (!foe) return 6;
        const foePassive = (foe.movesSeen || []).every(m => this.dex.moves.get(m).category === 'Status');
        if (foePassive && (foe.movesSeen || []).length) return 32;
        return 14;
      }
      case moveId === 'encore': {
        if (!foe || !foe.lastMove) return 6;
        const lm = this.dex.moves.get(foe.lastMove);
        if (lm && lm.category === 'Status') return 30;
        return 12;
      }
      case moveId === 'disable' || moveId === 'torment' || moveId === 'spite' || moveId === 'grudge': {
        return 10;
      }
      case moveId === 'trick' || moveId === 'switcheroo': {
        if (!foe) return 4;
        if (/choice|flameorb|toxicorb|stingorb|ironball|laggingtail/i.test(mine.item || '')) return 26;
        return 8;
      }
      case moveId === 'thunderwave' || moveId === 'supersonic' || moveId === 'confuseray' || moveId === 'sweetkiss' || moveId === 'teeterdance' || moveId === 'flatter' || moveId === 'swagger': {
        if (!foe) return 4;
        if (foe.ability === 'owntempo' || foe.ability === 'oblivious' && (moveId === 'captivate')) return 2;
        if ((moveId === 'swagger' || moveId === 'flatter') && foe.ability === 'contrary') return 2;
        return 14;
      }
      // --- phazing ---
      case moveId === 'roar' || moveId === 'whirlwind' || moveId === 'dragontail' || moveId === 'circleepunch' || moveId === 'circlethrow': {
        if (!foe) return 4;
        let s = 6;
        if (Object.values(foe.boosts).some(v => v > 0)) s += 22;
        if (Object.keys(foeSides.hazards || {}).length) s += 10;
        if (foe.ability === 'suctioncups' || foe.ability === 'soundproof' && (moveId === 'roar')) return 2;
        return s;
      }
      case moveId === 'haze' || moveId === 'clearsmog' || moveId === 'topsyturvy' || moveId === 'heartswap' || moveId === 'spectralthief' || moveId === 'psychup': {
        if (!foe) return 4;
        const foeBoosts = Object.values(foe.boosts).reduce((a, b) => a + Math.max(0, b), 0);
        if (foeBoosts >= 2) return 34;
        if (foeBoosts >= 1) return 20;
        return 4;
      }
      // --- sub / seed ---
      case moveId === 'substitute': {
        if ((mine.frac || 1) < 0.3) return 2;
        if (!foe) return 10;
        const threat = this.estimateDamageWithPower(foe, mine, foe.types[0], 80, foe.types[0], tracker);
        if (threat > 0.3) return 6;
        return 16;
      }
      case moveId === 'leechseed': {
        if (!foe || foe.types.includes('Grass')) return 2;
        return 18;
      }
      case moveId === 'curse': {
        const types = this.dex.species.get(mine.species).types || [];
        if (types.includes('Ghost')) {
          if (!foe) return 4;
          return (mine.frac || 1) > 0.6 ? 22 : 6;
        }
        return 18; // non-ghost curse = setup
      }
      case moveId === 'painsplit': {
        if (!foe) return 4;
        if ((foe.frac || 1) > (mine.frac || 1) + 0.35) return 30;
        return 6;
      }
      case moveId === 'wish': return 10;
      case moveId === 'healbell' || moveId === 'aromatherapy': return 6;
      case moveId === 'perishsong': return 12;
      case moveId === 'destinybond': {
        if (!foe) return 4;
        const threat = this.estimateDamageWithPower(foe, mine, foe.types[0], 90, foe.types[0], tracker);
        if (threat >= (mine.frac || 1) && myEffSpe < foeEffSpe) return 30;
        return 6;
      }
      case moveId === 'memento' || moveId === 'partingshot': {
        return 14;
      }
      case moveId === 'batonpass': {
        const tot = Object.values(mine.boosts || {}).reduce((a, b) => a + Math.max(0, b), 0);
        return tot > 0 ? 30 : 8;
      }
      case moveId === 'teleport' || moveId === 'shedtail': {
        return this.badMatchup(mine, foe) ? 30 : 12;
      }
      case moveId === 'transform' || moveId === 'imposter': return 5;
      case moveId === 'splash' || moveId === 'celebrate' || moveId === 'holdhands' || moveId === 'happyhour': return 0;
      case moveId === 'metronome': return 5;
      case moveId === 'naturepower' || moveId === 'secretpower' || moveId === 'camouflage' || moveId === 'conversion' || moveId === 'conversion2' || moveId === 'reflecttype': return 4;
      case moveId === 'lockon' || moveId === 'mindreader' || moveId === 'miracleeye' || moveId === 'foresight' || moveId === 'odorsleuth': return 6;
      case moveId === 'gravity' || moveId === 'iondeluge' || moveId === 'electrify' || moveId === 'plasmapowder': return 6;
      case moveId === 'snatch' || moveId === 'magiccoat' || moveId === 'imprison': return 6;
      case moveId === 'healblock' || moveId === 'embargo' || moveId === 'gastroacid' || moveId === 'worryseed' || moveId === 'simplebeam' || moveId === 'entrainment' || moveId === 'skillswap' || moveId === 'roleplay': {
        return 8;
      }
      case moveId === 'powder' || moveId === 'rage' || moveId === 'bide': return 4;
      case moveId === 'focusenergy' || moveId === 'laserfocus': return 8;
      case moveId === 'stockpile' || moveId === 'swallow' || moveId === 'spitup': return 10;
      case moveId === 'aquaring' || moveId === 'ingrain' || moveId === 'magicguard': return 8;
      case moveId === 'defensecurl' || moveId === 'minimize': {
        return moveId === 'minimize' ? 4 : 8; // evasion often banned; minimize scores low anyway
      }
      case moveId === 'acupressure': return 8;
      case moveId === 'coaching' || moveId === 'decorate' || moveId === 'aromaticmist': {
        return allyMon && !allyMon.fainted ? 16 : 0;
      }
      case moveId === 'gearup' || moveId === 'magneticflux': return 8;
      case moveId === 'rototiller' || moveId === 'flowershield': return 6;
      case moveId === 'fairylock' || moveId === 'octolock' || moveId === 'noretreat' || moveId === 'jawlock' || moveId === 'meanlook' || moveId === 'block' || moveId === 'spiderweb': {
        return foe ? 14 : 4;
      }
      case moveId === 'soak' || moveId === 'forestscurse' || moveId === 'trickortreat': return 8;
      default: {
        // Unknown status move: small score (better than nothing)
        return 6;
      }
    }
  }

  // -- switching ---------------------------------------------------------------
  firstAliveBench(mons) {
    for (const m of mons) {
      if (!m.fainted && !m.active) return m.index;
    }
    for (const m of mons) {
      if (!m.fainted) return m.index;
    }
    return 0;
  }

  hazardDamage(mine, mySideCond) {
    const types = this.dex.species.get(mine.species).types || ['Normal'];
    let dmg = 0;
    const hz = mySideCond.hazards || {};
    if (hz.stealthrock && mine.item !== 'heavy-duty-boots' && mine.item !== 'heavy-dutyboots' && mine.item !== 'heavy duty boots') {
      dmg += this.effectiveness('Rock', types) * 0.125;
    }
    if (hz.spikes) {
      const grounded = this.grounded({...mine, types}, null);
      if (grounded) dmg += [0, 0.125, 0.1875, 0.25][Math.min(3, hz.spikes)] || 0;
    }
    // toxic spikes: status, approximate as 0.06
    if (hz.toxicspikes && !types.includes('Poison') && !types.includes('Steel') && this.grounded({...mine, types}, null)) dmg += 0.06;
    return dmg;
  }

  switchMatchup(cand, foes, tracker) {
    // How good is cand vs current foes: threat dealt minus threat taken.
    let score = 0;
    const candTypes = this.dex.species.get(cand.species).types || ['Normal'];
    for (const foe of foes) {
      if (foe.fainted) continue;
      // our threat to foe: best STAB proxy
      let bestDealt = 0;
      for (const t of candTypes) {
        // use strongest move of that type if known? approximate with 85 power
        const A = Math.max(cand.stats.atk, cand.stats.spa);
        const defStat = cand.stats.atk >= cand.stats.spa ? foe.estStats.def : foe.estStats.spd;
        const base = Math.floor(Math.floor(Math.floor((2 * cand.level) / 5 + 2) * 85 * A / Math.max(1, defStat)) / 50) + 2;
        const eff = this.effectiveness(t, foe.types);
        bestDealt = Math.max(bestDealt, (base * 1.5 * eff * 0.925) / Math.max(1, foe.maxhp));
      }
      const taken = this.estimateDamageWithPower(foe, cand, foe.types[0], 85, foe.types[0], tracker);
      score += bestDealt * 90 - taken * 70;
      if (bestDealt >= (foe.frac || 1)) score += 40;
      if (taken >= (cand.frac || 1)) score -= 40;
    }
    return score;
  }

  bestSwitch(mine, mons, foes, tracker, mySideCond, stayScore, exclude) {
    const foeList = foes.filter(f => !f.fainted);
    let best = null;
    for (const cand of mons) {
      if (cand.fainted || cand.active) continue;
      if (exclude && exclude.has(cand.index)) continue;
      let s = this.switchMatchup(cand, foeList, tracker);
      s += (cand.frac || 0) * 20; // prefer healthy
      s -= this.hazardDamage(cand, mySideCond) * 80;
      if (cand.status === 'tox' || cand.status === 'brn' || cand.status === 'psn') s -= 8;
      if (cand.status === 'par' || cand.status === 'slp' || cand.status === 'frz') s -= 12;
      if (toID(cand.ability) === 'regenerator' && (cand.frac || 1) < 1) s += 10;
      if (toID(cand.ability) === 'naturalcure' && cand.status) s += 10;
      // don't switch into trap?/arena? (can't know) — fine
      if (!best || s > best.score) best = {index: cand.index, score: s};
    }
    return best;
  }

  // -- team preview ------------------------------------------------------------
  decideTeamPreview(request, tracker) {
    const mons = this.ownMons(request, tracker);
    const foePreview = tracker ? tracker.foeTeam().filter(p => p.species) : [];
    const n = mons.length;
    const maxPick = request.maxChosenTeamSize || (this.doubles ? n : 1);

    // Score each of our mons
    const scored = mons.map((m, i) => ({i, m, v: this.previewValue(m, foePreview, tracker)}));
    scored.sort((a, b) => b.v - a.v);

    let order;
    if (!this.doubles && maxPick <= 1) {
      // singles: lead only
      order = [scored[0].i];
    } else if (maxPick >= n) {
      // full order (doubles OU etc.): leads first
      const leads = this.pickLeads(scored.map(s => s.i), mons);
      const rest = scored.map(s => s.i).filter(i => !leads.includes(i));
      order = [...leads, ...rest];
    } else {
      // pick K (VGC/BSS/1v1/2v2)
      const picked = this.pickK(scored, mons, foePreview, maxPick);
      const leads = this.pickLeads(picked, mons);
      const rest = picked.filter(i => !leads.includes(i));
      order = [...leads, ...rest];
    }
    const choiceString = `team ${order.map(i => i + 1).join(', ')}`;
    return {kind: 'team', order, choiceString};
  }

  previewValue(m, foePreview, tracker) {
    const sp = this.dex.species.get(m.species);
    const types = sp.types || ['Normal'];
    const stats = m.stats || {atk: 80, def: 80, spa: 80, spd: 80, spe: 80};
    const off = Math.max(stats.atk, stats.spa);
    let v = off * 0.25 + stats.spe * 0.45 + (stats.hp || 80) * 0.05 + stats.def * 0.08 + stats.spd * 0.08;
    // support bonus
    const moves = (m.moves || []).map(toID);
    if (moves.includes('fakeout')) v += 25;
    if (moves.includes('followme') || moves.includes('ragepowder')) v += 18;
    if (moves.includes('tailwind') || moves.includes('trickroom')) v += 12;
    if (moves.includes('spore') || moves.includes('sleeppowder')) v += 10;
    if (moves.includes('stealthrock') || moves.includes('spikes')) v += 8;
    if (moves.includes('uturn') || moves.includes('voltswitch') || moves.includes('flipturn') || moves.includes('partingshot')) v += 8;
    if (moves.includes('protect')) v += 4;
    if (!foePreview.length) return v;
    // matchup vs foe preview
    let mu = 0;
    for (const f of foePreview) {
      const fsp = this.dex.species.get(f.species);
      const ftypes = fsp.types || ['Normal'];
      let dealt = 0, taken = 0;
      for (const t of types) {
        dealt = Math.max(dealt, this.effectiveness(t, ftypes));
      }
      for (const t of ftypes) {
        taken = Math.max(taken, this.effectiveness(t, types));
      }
      mu += dealt * 12 - taken * 10;
      // speed edge
      const fbase = fsp.baseStats || {spe: 80};
      if (stats.spe > (fbase.spe || 80) * (m.level || 100) / 100 * 1.1 + 20) mu += 6;
    }
    return v + mu / Math.max(1, foePreview.length);
  }

  pickK(scored, mons, foePreview, k) {
    // Greedy: value + diversity (avoid stacking shared weaknesses, prefer 1-2 support)
    const picked = [];
    let supports = 0;
    const typeCount = {};
    const pool = [...scored];
    while (picked.length < k && pool.length) {
      let bi = 0, bv = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const {i: idx, v} = pool[i];
        const m = mons[idx];
        const sp = this.dex.species.get(m.species);
        const t0 = (sp.types || ['Normal'])[0];
        let val = v;
        if ((typeCount[t0] || 0) > 0) val -= 12 * typeCount[t0];
        const moves = (m.moves || []).map(toID);
        const isSupport = moves.includes('fakeout') || moves.includes('followme') || moves.includes('ragepowder') || moves.includes('tailwind') || moves.includes('trickroom') || moves.includes('spore');
        if (isSupport && supports >= 2) val -= 20;
        if (!isSupport && picked.length >= k - 1 && supports === 0 && this.doubles) val -= 15; // want a support in doubles
        if (val > bv) { bv = val; bi = i; }
      }
      const [sel] = pool.splice(bi, 1);
      picked.push(sel.i);
      const m = mons[sel.i];
      const sp = this.dex.species.get(m.species);
      const t0 = (sp.types || ['Normal'])[0];
      typeCount[t0] = (typeCount[t0] || 0) + 1;
      const moves = (m.moves || []).map(toID);
      if (moves.includes('fakeout') || moves.includes('followme') || moves.includes('ragepowder') || moves.includes('tailwind') || moves.includes('trickroom') || moves.includes('spore')) supports++;
    }
    return picked;
  }

  pickLeads(indices, mons) {
    if (!indices.length) return [];
    if (!this.doubles) return [indices[0]];
    // doubles: [support-or-fast, fast attacker]
    const scored = indices.map(i => {
      const m = mons[i];
      const moves = (m.moves || []).map(toID);
      let support = 0;
      if (moves.includes('fakeout')) support += 30;
      if (moves.includes('followme') || moves.includes('ragepowder')) support += 25;
      if (moves.includes('tailwind')) support += 12;
      if (moves.includes('taunt')) support += 8;
      const spe = (m.stats && m.stats.spe) || 80;
      return {i, support, spe};
    });
    scored.sort((a, b) => (b.support - a.support) || (b.spe - a.spe));
    const lead1 = scored[0].i;
    const rest = scored.filter(s => s.i !== lead1).sort((a, b) => b.spe - a.spe);
    const lead2 = rest.length ? rest[0].i : lead1;
    return [lead1, lead2];
  }

  // -- serialization -------------------------------------------------------------
  serialize(decisions, request, n) {
    const parts = [];
    const omittable = [];
    for (let slot = 0; slot < n; slot++) {
      const d = decisions.find(x => x.slot === slot);
      if (!d || d.action === 'omit') {
        parts.push('pass');
        omittable.push(true); // locked slot: may drop if trailing
        continue;
      }
      omittable.push(false);
      if (d.action === 'pass') {
        parts.push('pass');
        continue;
      }
      if (d.action === 'switch') {
        parts.push(`switch ${d.switchTo + 1}`);
        continue;
      }
      if (d.action === 'move') {
        let s = `move ${d.moveIndex + 1}`;
        if (this.doubles && d.target !== null && d.target !== undefined) s += ` ${d.target}`;
        if (d.gimmick === 'mega') s += ' mega';
        else if (d.gimmick === 'ultra') s += ' ultra';
        else if (d.gimmick === 'zmove') s += ' zmove';
        else if (d.gimmick === 'dynamax') s += ' dynamax';
        else if (d.gimmick === 'terastallize') s += ' terastallize';
        parts.push(s);
        continue;
      }
      parts.push('pass');
    }
    // Drop trailing locked-slot passes (mid-turn single-slot prompts take one action).
    while (parts.length > 1 && omittable[parts.length - 1]) {
      parts.pop();
      omittable.pop();
    }
    if (!parts.length) return 'pass';
    // singles: single part, no trailing pass joins
    if (!this.doubles && parts.length === 1) return parts[0];
    return parts.join(', ');
  }
}

// ---------------------------------------------------------------------------
// Safe fallback (never throws, avoids rejected choices)
// ---------------------------------------------------------------------------
export function safeFallback(request, doubles, rejected = new Set(), err = null) {
  try {
    if (err) console.error('[ai] decide failed:', err && err.message);
    if (!request) return {kind: 'wait', choiceString: null};
    if (request.teamPreview) {
      const n = (request.side.pokemon || []).length || 6;
      const k = request.maxChosenTeamSize || (doubles ? n : 1);
      const order = [];
      for (let i = 0; i < Math.min(k, n); i++) order.push(i + 1);
      const s = `team ${order.join(', ')}`;
      if (!rejected.has(s)) return {kind: 'team', order: order.map(o => o - 1), choiceString: s};
      // try reversed
      const s2 = `team ${order.reverse().join(', ')}`;
      return {kind: 'team', order: order.map(o => o - 1), choiceString: s2};
    }
    const activeReq = request.active || [];
    const hasActive = Array.isArray(request.active);
    const forceSwitch = Array.isArray(request.forceSwitch) ? request.forceSwitch : (request.forceSwitch ? [true] : []);
    const n = hasActive ? Math.max(activeReq.length, forceSwitch.length, 1) : Math.max(forceSwitch.length, 1);
    const mons = (request.side && request.side.pokemon) || [];
    const usedBench = new Set();
    const findBench = () => mons.findIndex((m) => {
      if (usedBench.has(mons.indexOf(m))) return false;
      const c = parseCondition(m.condition || '');
      return !c.fainted && !m.active;
    });
    const parts = [];
    const omittable = [];
    for (let slot = 0; slot < n; slot++) {
      const aReq = activeReq[slot];
      const forced = !!forceSwitch[slot];
      if (!hasActive && !forced) {
        parts.push('pass'); // locked mid-turn slot: omitted below if trailing
        omittable.push(true);
        continue;
      }
      omittable.push(false);
      if (forced) {
        const bench = findBench();
        if (bench >= 0) {
          usedBench.add(bench);
          parts.push(`switch ${bench + 1}`);
        } else {
          parts.push('pass'); // no legal bench: accepted for extra forced slots
        }
        continue;
      }
      if (!aReq || !aReq.moves) {
        parts.push('pass'); // locked slot in a full request
        continue;
      }
      if (slotMonFainted(request, slot)) {
        parts.push('pass'); // fainted mon with moves offered: actions illegal
        continue;
      }
      const usable = (aReq.moves || []).map((m, i) => ({m, i})).filter(({m}) => !m.disabled && m.pp !== 0); // pp absent (gen1 Fight, locked) = must pick it
      if (!usable.length) {
        const bench = findBench();
        if (bench >= 0 && !aReq.trapped && !aReq.maybeTrapped) {
          usedBench.add(bench);
          parts.push(`switch ${bench + 1}`);
          continue;
        }
        parts.push('move 1');
        continue;
      }
      // prefer damaging moves
      let pick = usable[0];
      try {
        const dex = Dex;
        for (const u of usable) {
          const md = dex.moves.get(u.m.id);
          if (md && md.category !== 'Status' && (md.basePower || 0) >= 40) { pick = u; break; }
        }
      } catch { /* ignore */ }
      let s = `move ${pick.i + 1}`;
      if (doubles) {
        const tk = pick.m.target || '';
        if (tk === 'normal' || tk === 'any') s += ' 1';
        else if (tk === 'adjacentAlly' || tk === 'adjacentAllyOrSelf') s += slot === 0 ? ' -2' : ' -1';
      }
      if (aReq.canMegaEvo) s += ' mega';
      parts.push(s);
    }
    while (parts.length > 1 && omittable[parts.length - 1]) {
      parts.pop();
      omittable.pop();
    }
    let choiceString = parts.length ? (doubles ? parts.join(', ') : parts[0]) : 'pass';
    if (rejected.has(choiceString)) choiceString = 'default';
    return {kind: 'actions', choiceString};
  } catch (e2) {
    return {kind: 'actions', choiceString: 'default'};
  }
}
