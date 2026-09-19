// Team roster index: config formatId -> teams/*.txt export.
// Filenames match KOTH config format IDs 1:1 (54/54 coverage).
// Special cases (resolved at runtime):
//   gen91v1        bring <=3 (file ships 6 for the shared roster; trim to 3)
//   gen92v2doubles bring <=4 (file ships 6; trim to 4)
import {Teams} from '@pkmn/sim';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Max team size the SIM accepts for these formats (smaller than the 6-mon roster).
const BRING_LIMIT = {
  gen91v1: 3,
  gen92v2doubles: 4,
};

export function teamFileFor(formatId) {
  return path.join(__dirname, `${formatId}.txt`);
}

export function hasTeam(formatId) {
  return fs.existsSync(teamFileFor(formatId));
}

export function listFormats() {
  return fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.txt'))
    .map(f => f.slice(0, -4))
    .sort();
}

// Raw export text (6 mons, as shipped).
export function getTeamExport(formatId) {
  const file = teamFileFor(formatId);
  if (!fs.existsSync(file)) throw new Error(`no team file for format: ${formatId}`);
  return fs.readFileSync(file, 'utf8');
}

// Roster export for PUT /api/team: trimmed to the server's maxTeamSize.
// Files ship 6 sets ordered best-first, so slicing keeps the best leads.
export function getRosterExport(formatId, maxSize = 6) {
  const text = getTeamExport(formatId);
  const sets = Teams.import(text);
  if (!sets || sets.length <= maxSize) return text;
  return Teams.export(sets.slice(0, maxSize));
}

// Battle-ready export: trimmed to the format's bring limit when smaller than 6.
// Keeps the FIRST N sets (files are ordered with the best leads first).
export function getBattleExport(formatId) {
  const text = getTeamExport(formatId);
  const limit = BRING_LIMIT[formatId];
  if (!limit) return text;
  const sets = Teams.import(text);
  if (!sets || sets.length <= limit) return text;
  return Teams.export(sets.slice(0, limit));
}

// Packed team string for `>player` / Showdown `TeamValidator.packTeam`.
export function getPackedTeam(formatId) {
  return Teams.pack(Teams.import(getBattleExport(formatId)));
}

// Format metadata the bot needs at runtime.
export function formatMeta(formatId) {
  const id = String(formatId || '').toLowerCase();
  const gen = parseInt((id.match(/^gen(\d)/) || [])[1], 10) || 9;
  const doubles = /doubles|vgc|2v2|bss/.test(id);
  const defaultLevel = /vgc|bss/.test(id) ? 50 : /lc$/.test(id) ? 5 : (/vgc2026|championsvgc/.test(id) ? 50 : 100);
  return {
    formatId,
    gen,
    gameType: doubles ? 'doubles' : 'singles',
    defaultLevel,
    bringLimit: BRING_LIMIT[id] || 6,
  };
}
