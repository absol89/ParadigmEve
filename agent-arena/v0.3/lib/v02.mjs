// Locates the v0.2 toolkit, which v0.3 builds on: its run scorer gives the first 40 points and its code
// scorer runs the general-fix tests. Set EVEAL_V02 (or pass --v02) to its folder; a sibling ../v0.2 is
// the default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function v02Root(explicit) {
  const candidates = [explicit, process.env.EVEAL_V02, path.join(here, '..', '..', 'v0.2')].filter(Boolean);
  const found = candidates.find(dir => fs.existsSync(path.join(dir, 'tools', 'score-run.mjs')) && fs.existsSync(path.join(dir, 'tools', 'score-code.mjs')));
  if (!found) throw new Error(`EVE-Al v0.2 toolkit not found (looked in ${candidates.join(', ')}). Set EVEAL_V02 to its agent-arena/v0.2 folder.`);
  return path.resolve(found);
}

export async function loadV02(explicit) {
  const root = v02Root(explicit);
  const load = rel => import(pathToFileURL(path.join(root, rel)).href);
  const [run, code, challenges] = await Promise.all([load('tools/score-run.mjs'), load('tools/score-code.mjs'), load('lib/challenges.mjs')]);
  return { root, scoreRun: run.scoreRun, scoreCode: code.scoreCode, challenges };
}
