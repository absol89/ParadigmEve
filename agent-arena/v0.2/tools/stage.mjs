// Operator stager: copies a pristine fixture into <root>/work and writes a stage record OUTSIDE the
// contestant's reach (--record). The record proves the run started from an untouched copy.
//
// usage: node stage.mjs <fixture-dir> <root> --record <file-outside-contestant-roots>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { walk, treeHash } from './score-code.mjs';

const [fixture, root] = process.argv.slice(2);
const i = process.argv.indexOf('--record');
const recordPath = i > 0 ? path.resolve(process.argv[i + 1]) : null;
if (!fixture || !root || !recordPath) {
  console.error('usage: node stage.mjs <fixture-dir> <root> --record <file-outside-contestant-roots>');
  process.exit(2);
}
const work = path.join(path.resolve(root), 'work');
if (fs.existsSync(work)) { console.error('Refusing to reuse ' + work + '; stage every run into a new root.'); process.exit(1); }
if (recordPath.startsWith(path.resolve(root) + path.sep)) { console.error('The record must live outside the stage root.'); process.exit(1); }
fs.cpSync(path.resolve(fixture), work, { recursive: true });
const name = path.basename(path.resolve(fixture));
if (fs.existsSync(path.join(work, 'setup.mjs'))) {
  const run = spawnSync(process.execPath, [path.join(work, 'setup.mjs'), '--record', recordPath], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
  fs.rmSync(path.join(work, 'setup.mjs'));
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.pristine_tree = treeHash(walk(path.resolve(fixture)));
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
} else {
  fs.writeFileSync(recordPath, JSON.stringify({
    schema: 'arena-stage-record/0.2', fixture: name, mode: 'operator', staged_at: new Date().toISOString(),
    pristine_tree: treeHash(walk(path.resolve(fixture))), work_tree_at_stage: treeHash(walk(work))
  }, null, 2) + '\n');
}
console.log(`Staged ${name} at ${work}. Give the agent that path. Record: ${recordPath}`);
