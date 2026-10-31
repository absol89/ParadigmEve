import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const tracks = Object.fromEntries(manifest.tracks.map(t => [t.id, 0]));
assert.equal(manifest.tracks.reduce((n, t) => n + t.max_points, 0), manifest.total_points, 'track weights');
for (const task of manifest.tasks) {
  assert.ok(task.track in tracks, task.id + ': unknown track');
  const sum = task.checks.reduce((n, check) => n + check.points, 0);
  assert.equal(sum, task.max_points, task.id + ': rubric weights');
  const checkIds = task.checks.map(c => c.id);
  assert.equal(new Set(checkIds).size, checkIds.length, task.id + ': duplicate check id');
  tracks[task.track] += sum;
  for (const relative of [task.prompt, task.fixture && task.fixture + '/package.json', task.fixture_archive].filter(Boolean)) {
    const p = path.resolve(root, relative);
    assert.ok(p.startsWith(root + path.sep), 'path escapes package');
    assert.ok(fs.statSync(p).isFile(), task.id + ': missing ' + relative);
  }
}
for (const track of manifest.tracks)
  assert.equal(tracks[track.id], track.max_points, track.id + ': task weights');
for (const p of ['AGENT.md','README.md','START-HERE.md','EVALUATION-INSPIRATIONS.md','capability-matrix.json',
  'tasks/lite-mission.md','tasks/final-submission.md','index.html','style.css','app.js','RESULTS.md','results.json',
  'lite-manifest.json','lite-results.json','LITE-RESULTS.md'])
  assert.ok(fs.statSync(path.join(root, p)).isFile(), 'Missing ' + p);
const template = JSON.parse(fs.readFileSync(path.join(root,'runs','SUBMISSION.template.json'),'utf8'));
for (const task of manifest.tasks) {
  const defined = new Set(task.checks.map(c=>c.id));
  assert.deepEqual(new Set(Object.keys(template.tasks[task.id]?.checks??{})), defined, 'template checks '+task.id);
}
const lite = JSON.parse(fs.readFileSync(path.join(root,'lite-manifest.json'),'utf8'));
assert.equal(lite.tasks.reduce((n,t)=>n+t.max_points,0),lite.max_points,'Lite task weights');
const liteTemplate = JSON.parse(fs.readFileSync(path.join(root,'lite-runs','SUBMISSION.template.json'),'utf8'));
for (const task of lite.tasks) {
  assert.equal(task.checks.reduce((n,c)=>n+c.points,0),task.max_points,'Lite check weights '+task.id);
  assert.deepEqual(new Set(Object.keys(liteTemplate.tasks[task.id]?.checks??{})),
    new Set(task.checks.map(c=>c.id)), 'Lite template '+task.id);
}
console.log('Agent Arena package verified: ' + manifest.tasks.length + ' full tasks; 5 tracks; all files and weights consistent.');
