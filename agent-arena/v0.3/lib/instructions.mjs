// Verifiable instruction following (8 points). One practical brief with eight compatible rules, each
// checked by its own small function, one point each; whole-brief success (all eight) is reported but
// not scored. The seed picks the topic, headings, list length, term, banned word, forbidden character,
// word range and closing line. Every generated brief is proven satisfiable by building a reference note.
import { rng, utc, iso, addDays, norm } from './common.mjs';

const TOPICS = [
  { what: 'moving the billing service to the new Ostrava cluster', term: 'cutover window' },
  { what: 'retiring the old print queue in the Lund office', term: 'freeze list' },
  { what: 'switching the support inbox to the new ticket tool', term: 'read-only mode' },
  { what: 'rotating the signing keys for the mobile app', term: 'rollback point' },
  { what: 'enabling the new search index for the docs site', term: 'canary group' }
];
const HEADINGS = ['Context', 'Plan', 'Risks', 'Owners', 'Timeline', 'Open questions', 'Rollback'];
const BANNED = ['simply', 'just', 'obviously', 'basically', 'very', 'really'];
const CHARS = [';', '!', '?', '&'];
const PEOPLE = ['Dana', 'Ravi', 'Mina', 'Jonas', 'Ilse', 'Keiko', 'Amara', 'Bram', 'Noor', 'Pavel'];
const FILLER = ['the', 'team', 'will', 'check', 'each', 'step', 'with', 'care', 'and', 'write', 'down', 'what', 'changed', 'before', 'moving', 'on', 'to', 'next', 'item'];

const fence = /```json\s*\n([\s\S]*?)```/;
const stripJson = t => t.replace(/```[\s\S]*?```/g, ' ');
const lines = t => t.replace(/\r\n/g, '\n').split('\n');
export const countWords = t => (lines(stripJson(t)).filter(l => !/^\s*#{1,6}\s/.test(l)).join(' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const headingLines = t => lines(stripJson(t)).map(l => /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)).filter(Boolean);
const headingName = s => norm(s).replace(/[:.]$/, '');

export function instructionsChallenge(seed) {
  const r = rng(seed, 'instructions-v03');
  const topic = r.pick(TOPICS);
  const headings = r.take(HEADINGS, 3);
  const listUnder = r.pick(headings);
  const items = 3 + r.int(3);
  const banned = r.pick(BANNED);
  const ch = r.pick(CHARS.filter(c => !headings.join('').includes(c)));
  const lo = r.pick([110, 130, 150]), hi = lo + 60;
  const owner = r.pick(PEOPLE);
  const due = iso(addDays(utc(2027, 1, 1), 30 + r.int(300)));
  const closing = r.pick([`End of handover.`, `Questions go to ${owner}.`, `Next review on ${due}.`]);
  const rules = [
    { id: 'headings', text: `Use exactly three headings, all level 2 (\`## \`), in this order: ${headings.map(h => `\`## ${h}\``).join(', ')}. No other headings of any level.` },
    { id: 'word-range', text: `Between ${lo} and ${hi} words in total. Words are counted outside headings and outside the JSON block.` },
    { id: 'list', text: `Under \`## ${listUnder}\`, a bulleted list (lines starting with \`- \`) of exactly ${items} items, and no bullets under the other headings.` },
    { id: 'term', text: `Use the exact term "${topic.term}" at least twice.` },
    { id: 'banned', text: `Never use the word "${banned}".` },
    { id: 'char', text: `Do not use the character \`${ch}\` anywhere in the file.` },
    { id: 'json', text: `Include one fenced \`\`\`json block holding an object with exactly these keys: "owner" (the string "${owner}"), "due" (the string "${due}") and "items" (the number of bullets, as a number).` },
    { id: 'closing', text: `The very last line of the file is exactly: ${closing}` }
  ];
  const order = r.shuffle(rules);
  const task = [
    `# Instructions: a handover note (challenge %ID%)`,
    '',
    `Write a short handover note for the operations team about ${topic.what}. Save it as \`instructions.md\` in`,
    `your output folder. Write only the note into the file. Every rule below is checked by a script.`,
    '',
    ...order.map((rule, i) => `${i + 1}. ${rule.text}`),
    ''
  ].join('\n');
  const key = { headings, listUnder, items, term: topic.term, banned, ch, lo, hi, owner, due, closing };
  return { files: { 'tasks/instructions.md': task }, key, reference: referenceNote(key) };
}

function referenceNote(k) {
  const build = filler => {
    const parts = [];
    for (const h of k.headings) {
      parts.push(`## ${h}`, '');
      if (h === k.listUnder) for (let i = 0; i < k.items; i++) parts.push(`- item ${i + 1} of the ${k.term}`);
      else parts.push(`We keep the ${k.term} in mind.`);
      parts.push('');
    }
    const words = Array.from({ length: filler }, (_, i) => FILLER[i % FILLER.length]).join(' ');
    parts.push(words ? words + '.' : '', '', '```json', JSON.stringify({ owner: k.owner, due: k.due, items: k.items }), '```', '', k.closing);
    return parts.join('\n') + '\n';
  };
  return build(Math.max(0, k.lo + 10 - countWords(build(0))));
}

export function scoreInstructions(key, text) {
  if (typeof text !== 'string' || !text.trim()) return { points: 0, max: 8, rules: {}, all_pass: false };
  const t = text.normalize('NFC').replace(/^﻿/, '');
  const heads = headingLines(t);
  const words = countWords(t);
  const sectionOf = name => {
    const ls = lines(t); let inside = false; const out = [];
    for (const l of ls) {
      const h = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
      if (h) { inside = headingName(h[1]) === headingName(name); continue; }
      if (inside) out.push(l);
    }
    return out;
  };
  const bullets = ls => ls.filter(l => /^\s*[-*+]\s+\S/.test(l)).length;
  let json = null;
  try { json = JSON.parse(fence.exec(t)?.[1] ?? ''); } catch { json = null; }
  const nonEmpty = lines(t).map(l => l.trim()).filter(Boolean);
  const termCount = (norm(t).match(new RegExp(key.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  const rules = {
    headings: heads.length === 3 && heads.every((h, i) => h[1] === '##' && headingName(h[2]) === headingName(key.headings[i])),
    'word-range': words >= key.lo && words <= key.hi,
    list: bullets(sectionOf(key.listUnder)) === key.items && key.headings.filter(h => h !== key.listUnder).every(h => bullets(sectionOf(h)) === 0),
    term: termCount >= 2,
    banned: !new RegExp(String.raw`(?<![\p{L}])${key.banned}(?![\p{L}])`, 'iu').test(t),
    char: !t.includes(key.ch),
    json: Boolean(json) && typeof json === 'object' && !Array.isArray(json)
      && Object.keys(json).sort().join() === 'due,items,owner'
      && norm(json.owner) === norm(key.owner) && norm(json.due) === key.due && Number(json.items) === key.items && String(json.items).trim() !== '',
    closing: nonEmpty.at(-1) === key.closing
  };
  const passed = Object.values(rules).filter(Boolean).length;
  return { points: passed, max: 8, rules, all_pass: passed === 8, diagnostics: { words, headings: heads.map(h => h[2]), term_count: termCount } };
}
