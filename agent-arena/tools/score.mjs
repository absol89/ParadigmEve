import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const slug = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,80}$/;

export function scoreRun(run) {
  if (!run || run.schema_version !== manifest.schema_version || !slug.test(run.run_id ?? ''))
    throw new Error('Invalid schema_version or run_id');
  for (const key of ['name', 'model', 'reasoning', 'harness', 'build', 'tools']) {
    if (typeof run.agent?.[key] !== 'string' || !run.agent[key].trim())
      throw new Error('Missing agent.' + key);
  }
  const status = run.review?.status;
  if (!['verified', 'self-reported'].includes(status)) throw new Error('Bad review.status');
  if (status === 'verified' && (!run.review.reviewer?.trim() || !run.review.reference?.trim()))
    throw new Error('Verified run needs reviewer and public reference');
  for (const key of ['elapsed_minutes', 'tool_calls', 'assistant_turns']) {
    const v = run.observations?.[key] ?? null;
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (key !== 'elapsed_minutes' && !Number.isInteger(v))))
      throw new Error('Invalid observation: ' + key);
  }
  const knownTasks = new Set(manifest.tasks.map(task => task.id));
  for (const id of Object.keys(run.tasks ?? {}))
    if (!knownTasks.has(id)) throw new Error('Unknown task: ' + id);

  const tracks = Object.fromEntries(manifest.tracks.map(t => [t.id, { score: 0, max: t.max_points }]));
  const tasks = {};
  let total = 0;
  for (const def of manifest.tasks) {
    const item = run.tasks?.[def.id] ?? { checks: {}, evidence: [] };
    const knownChecks = new Set(def.checks.map(c => c.id));
    for (const check of Object.keys(item.checks ?? {}))
      if (!knownChecks.has(check)) throw new Error('Unknown check: ' + def.id + '/' + check);
    const evidence = item.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.some(e => typeof e !== 'string' || !e.trim()))
      throw new Error('Invalid evidence for ' + def.id);
    const anyPassed = Object.values(item.checks ?? {}).some(Boolean);
    if (anyPassed && evidence.length === 0)
      throw new Error('Positive checks require evidence receipts: ' + def.id);
    let points = 0;
    for (const check of def.checks) {
      const v = item.checks?.[check.id] ?? false;
      if (typeof v !== 'boolean') throw new Error('Not boolean: ' + def.id + '/' + check.id);
      if (v) points += check.points;
    }
    if (points > def.max_points) throw new Error('Overweighted task: ' + def.id);
    tasks[def.id] = { score: points, max: def.max_points };
    tracks[def.track].score += points;
    total += points;
  }
  if (total > manifest.total_points) throw new Error('Overweight total');
  return {
    run_id: run.run_id,
    date: run.date,
    agent: run.agent,
    review: run.review,
    observations: run.observations ?? {},
    conditions: run.conditions ?? {},
    total,
    max: manifest.total_points,
    tracks,
    tasks
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node agent-arena/tools/score.mjs <run.json>');
    const s = scoreRun(JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8')));
    console.log(JSON.stringify(s, null, 2));
    if (s.review.status !== 'verified') console.error('SELF-REPORTED ONLY — NOT ELIGIBLE FOR LEADERBOARD');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
