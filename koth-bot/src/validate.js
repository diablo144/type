// Validate every team in teams/ against its format using @pkmn/sim's TeamValidator.
// Usage: node src/validate.js [formatId...]
import {TeamValidator, Teams, Dex} from '@pkmn/sim';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMS_DIR = path.join(__dirname, '..', 'teams');

export function validateTeamExport(formatId, exportText) {
  let format;
  try {
    format = Dex.formats.get(formatId);
  } catch (e) {
    return [`format lookup crashed: ${e.message}`];
  }
  if (!format || !format.exists) return [`unknown format: ${formatId}`];
  let sets;
  try {
    sets = Teams.import(exportText);
  } catch (e) {
    return [`import error: ${e.message}`];
  }
  if (!sets || !sets.length) return ['no sets parsed'];
  let validator;
  try {
    validator = TeamValidator.get(formatId);
  } catch (e) {
    return [`validator crash: ${e.message}`];
  }
  const res = validator.validateTeam(sets);
  if (!res) return null; // legal
  return Array.isArray(res) ? res : [String(res)];
}

function main() {
  const only = new Set(process.argv.slice(2));
  const files = fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith('.txt')).sort();
  let legal = 0, illegal = 0, unknown = 0;
  for (const f of files) {
    const formatId = path.basename(f, '.txt');
    if (only.size && !only.has(formatId)) continue;
    const text = fs.readFileSync(path.join(TEAMS_DIR, f), 'utf8');
    const errors = validateTeamExport(formatId, text);
    if (errors === null) {
      console.log(`LEGAL   ${formatId}`);
      legal++;
    } else if (errors.length === 1 && errors[0].startsWith('unknown format')) {
      console.log(`UNKNOWN ${formatId} :: ${errors[0]}`);
      unknown++;
    } else {
      console.log(`ILLEGAL ${formatId} ::`);
      for (const e of errors) console.log(`    - ${e}`);
      illegal++;
    }
  }
  console.log(`\n${legal} legal, ${illegal} illegal, ${unknown} unknown format`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
