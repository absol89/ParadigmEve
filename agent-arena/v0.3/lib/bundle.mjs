// One v0.3 challenge: the five new tasks generated from one seed under one public id. The contestant
// files never include a key; keys and private tests are regenerated from the seed at scoring time.
import { challengeId, PRACTICE_SEED } from './common.mjs';
import { swedishChallenge } from './swedish.mjs';
import { instructionsChallenge } from './instructions.mjs';
import { fixChallenge } from './fix.mjs';
import { pushbackChallenge } from './pushback.mjs';
import { calibrationChallenge } from './calibration.mjs';

export const TASKS = { swedish: swedishChallenge, instructions: instructionsChallenge, general_fix: fixChallenge, pushback: pushbackChallenge, calibration: calibrationChallenge };

const cache = new Map();
export function v03Challenge(seed) {
  if (typeof seed !== 'string' || seed.length < 16) throw new Error('A v0.3 seed is at least 16 characters of randomness.');
  if (cache.has(seed)) return cache.get(seed);
  const id = challengeId(seed, 'v03');
  const parts = Object.fromEntries(Object.entries(TASKS).map(([name, make]) => [name, make(seed)]));
  const files = {};
  for (const part of Object.values(parts)) {
    for (const [file, text] of Object.entries(part.files)) {
      if (file in files) throw new Error('two tasks write ' + file);
      files[file] = text.replaceAll('%ID%', id);
    }
  }
  const challenge = { id, practice: seed === PRACTICE_SEED, files, parts };
  cache.set(seed, challenge);
  return challenge;
}

export const challengeNote = id => [
  `# EVE-Al v0.3 challenge ${id}`, '',
  `This folder replaces the suite's practice files for the five v0.3 tasks (Swedish, instructions, general`,
  `fix, pushback, calibration). Read each task from \`tasks/\` here, not from the suite, and use the`,
  `\`corpus/\` and \`fixtures/\` folders here. Use \`"challenge": "${id}"\` wherever a task asks for it, and put`,
  `the same id in \`run.json\` as \`"challenge"\`.`, ''
].join('\n');
