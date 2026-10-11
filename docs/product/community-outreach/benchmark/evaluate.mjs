import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deterministic editorial scoreboard for *already-authored* copy.
// It does not generate candidates or infer scores with an LLM.
// A high editorial score never bypasses missing demonstration or approval.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brief = JSON.parse(await readFile(resolve(root, 'benchmark/brief.json'), 'utf8'));
const candidates = JSON.parse(await readFile(resolve(root, 'benchmark/scores.json'), 'utf8'));
const criteria = Object.entries(brief.criteria);
const gates = brief.gates;
if (criteria.reduce((a, [, weight]) => a + weight, 0) !== 100) throw new Error('Weights must sum to 100');
if (new Set(brief.tieBreak).size !== brief.tieBreak.length || brief.tieBreak.some(k => !(k in brief.criteria))) throw new Error('Invalid tieBreak');

const seen = new Set();
const score = (ratings) => +criteria.reduce((s, [key, weight]) => s + ratings[key] * weight / 4, 0).toFixed(2);
const defaultGates = Object.fromEntries(gates.map(name => [name, false]));
const rows = [];
for (const c of candidates) {
  if (!c.id || seen.has(c.id)) throw new Error('IDs must be unique and nonempty');
  seen.add(c.id);
  if (!(c.group in brief.groups)) throw new Error(`Unknown group: ${c.group}`);
  if (!/^posts\/[0-9]{2}-[a-z0-9-]+\.md$/i.test(c.file)) throw new Error(`Unsafe draft path: ${c.file}`);
  const actual = await readFile(resolve(root, c.file), 'utf8');
  if (!actual.startsWith(`# ${c.id} `) || !actual.includes('## Copy') || !actual.includes('## Editor note')) {
    throw new Error(`Missing or mislabeled draft: ${c.file}`);
  }
  if (typeof c.notes !== 'string' || c.notes.length < 20) throw new Error(`Editorial reason required: ${c.id}`);
  for (const [key] of criteria) {
    if (!Number.isInteger(c.ratings?.[key]) || c.ratings[key] < 0 || c.ratings[key] > 4) {
      throw new Error(`Invalid 0–4 rating for ${c.id}.${key}`);
    }
  }
  // The initial draft phase has no production validation or authorization, so
  // every missing gate remains false. Recheck each item with real evidence later.
  const evidence = {...defaultGates, objectiveMatches: c.objectiveMatches !== false};
  const blockers = gates.filter(gate => evidence[gate] !== true);
  rows.push({id:c.id,group:c.group,file:c.file,ratings:c.ratings,score:score(c.ratings),comparable:evidence.objectiveMatches,
    publishReady:blockers.length === 0,blockers,notes:c.notes});
}
if (rows.length !== 12) throw new Error(`Expected 12 candidate drafts, found ${rows.length}`);
const faq = await readFile(resolve(root, 'replies.md'), 'utf8');
const replyCount = (faq.match(/^## \d\d — /gm) ?? []).length;
if (replyCount !== 17) throw new Error(`Expected 17 Q&A drafts, found ${replyCount}`);
const replyVariants = JSON.parse(await readFile(resolve(root, 'benchmark/reply-variants.json'), 'utf8'));
const replyCriteria = {directness:25, accuracy:30, empathy:15, actionability:20, brevity:10};
const replyResults = [];
const seenReplyIds = new Set();
for (const q of replyVariants) {
  if (typeof q.question !== 'string' || q.question.length < 10 || !Array.isArray(q.variants) || q.variants.length !== 2) {
    throw new Error('Each reply trial needs one real question and exactly two answers');
  }
  const variantRows = [];
  for (const v of q.variants) {
    if (!v.id || seenReplyIds.has(v.id) || typeof v.text !== 'string' || v.text.length < 40 ||
        typeof v.notes !== 'string' || v.notes.length < 20) throw new Error(`Malformed reply: ${v.id}`);
    seenReplyIds.add(v.id);
    for (const key of Object.keys(replyCriteria)) {
      if (!Number.isInteger(v.ratings?.[key]) || v.ratings[key] < 0 || v.ratings[key] > 4) {
        throw new Error(`Invalid reply rating: ${v.id}.${key}`);
      }
    }
    variantRows.push({...v, score:+Object.entries(replyCriteria).reduce((s,[k,w])=>s+v.ratings[k]*w/4,0).toFixed(2)});
  }
  variantRows.sort((a,b)=>b.score-a.score || b.ratings.accuracy-a.ratings.accuracy || b.ratings.actionability-a.ratings.actionability);
  replyResults.push({questionId:q.questionId,question:q.question,variants:variantRows,editorialLeader:variantRows[0].id});
}
const cmp = (a, b) => b.score - a.score || brief.tieBreak.map(k => b.ratings[k] - a.ratings[k]).find(diff => diff !== 0) || a.id.localeCompare(b.id);
const fmt = v => v.toFixed(2);
const lines = [
  '# Eve organic draft benchmark — first editorial pass',
  '',
  `**Dated:** ${brief.date}. **Method:** human/model editorial judgments recorded in scores.json, 0–4 per criterion, frozen weighted rubric. **Not:** real-world A/B test, engagement data, or a validated skill selection engine.`,
  '',
  'The original visual-design recipe was adapted for *copy*, replacing visual polish with distinctiveness and accessible layout with short scannable language. We keep the high weights on newcomer relevance, clear outcome and usable next action. A verified demonstration and current publication permission are **hard gates**, not score bonuses.',
  '',
  '## Criteria',
  '',
  '| Dimension | Weight |',
  '| --- | ---: |',
  ...criteria.map(([k,w]) => `| ${k} | ${w} | `),
  '',
  '## Matched comparison results',
  '',
  '| Scenario | A score | B score | Draft leader | Interpretation |',
  '| --- | ---: | ---: | --- | --- |'
];
for (const [group, intent] of Object.entries(brief.groups)) {
  const pair = rows.filter(row => row.group === group);
  if (pair.length !== 2) throw new Error(`Expected A/B pair: ${group}`);
  const sorted = pair.filter(x => x.comparable).sort(cmp);
  const leader = sorted[0]?.id ?? '—';
  const interpretation = pair.some(x => !x.comparable)
    ? 'Different intent: helpful noncommercial B is not a comparable promo variant.'
    : 'Provisional editorial preference; no publication authorization.';
  lines.push(`| ${group} | ${fmt(pair[0].score)} | ${fmt(pair[1].score)} | ${leader} | ${interpretation} |`);
}
lines.push('', '## Individual evidence and adjustments', '');
for (const row of rows) {
  lines.push(`### ${row.id} — ${fmt(row.score)} / 100`, '', `- File: [${row.file}](../${row.file})`,
    `- Editorial reason: ${row.notes}`,
    `- Publication: **HOLD**; ${row.comparable ? 'matching audience objective' : 'different noncommercial objective'}.`,
    `- Missing: ${row.blockers.join(', ')}.`, '');
}
lines.push('## Matched reply comparison', '',
  'Each mini-comparison freezes **one paraphrased question**; the replies are scored on directness (25), accuracy (30), empathy (15), actionability (20) and brevity (10). This is an editorial critique, not evidence of public performance.',
  '',
  '| Question | A score | B score | Editorial preference |',
  '| --- | ---: | ---: | --- |');
for (const group of replyResults) {
  const a=group.variants.find(v=>v.id.endsWith('-A'));
  const b=group.variants.find(v=>v.id.endsWith('-B'));
  lines.push(`| ${group.questionId} | ${fmt(a.score)} | ${fmt(b.score)} | ${group.editorialLeader} |`);
}
lines.push('', '### Reply decisions', '');
for (const group of replyResults) {
  lines.push(`**${group.questionId}:** ${group.question}`, '');
  for (const r of group.variants) lines.push(`- **${r.id} — ${fmt(r.score)}:** ${r.notes}`);
  lines.push('');
}
lines.push('## Reply bank audit', '', `- **${replyCount}** common-question drafts found, each with specific verification caveats (privacy, cost, autonomy, limits, Dots, reliability, OS, retention, hardware, skepticism).`,
  '- Do **not** rank replies to different questions against each other: accuracy is conditional on the precise question and verified features.',
  '- Before reusing a reply, inspect exact current source, product build, community rules and any sensitive context; the bank is not an auto-reply bot.',
  '',
  '## What to test next', '',
  '1. Reproduce one clear household/admin task and one interrupted/resumed task in an actual installable candidate. Replace placeholders with truthful entry points and platform/cost requirements.',
  '2. Screen matched, *publishable* variants separately with newcomers: ask what it does, what it costs, what to click first and whether it really reduces work.',
  '3. Re-score against observed comprehension and completion, preserve dated evidence, and only then learn a broader outreach recipe. Do not promote a winner from these editorial scores alone.',
  '',
  '**Operational status:** No drafts have been posted, no creator contacted, and no paid distribution started.',
  ''
);
const resultText = lines.join('\n');
const result = {brief:brief.version, date:brief.date, candidates:rows, replyCount, replyResults,
  groups:Object.fromEntries(Object.keys(brief.groups).map(key=>{
    const filtered = rows.filter(r=>r.group===key && r.comparable).sort(cmp);
    return [key,{editorialLeader:filtered[0]?.id??null,publicWinner:null}];
  }))};
await writeFile(resolve(root,'benchmark/results.md'),resultText,'utf8');
await writeFile(resolve(root,'benchmark/results.json'),JSON.stringify(result,null,2)+'\n','utf8');
console.log(`Evaluated ${rows.length} posts, ${replyResults.length * 2} matched reply variants, and audited ${replyCount} FAQ drafts; 0 publish-ready. Wrote benchmark/results.md and results.json`);
