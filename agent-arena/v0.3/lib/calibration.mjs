// Evidence calibration (6 points). Ten short questions about a small seeded corpus. For each, the agent
// gives an answer or "unknown" and p, its probability that the corpus uniquely determines a supportable
// answer. The key holds that answerability y (1 or 0). Score: 3 x mean(1 - (p - y)^2) + 3 x the share of
// right answer-or-abstain decisions. This calibrates evidence sufficiency, not confidence in a guess.
// Facts sit at different positions across four pages (short retrieval, not long-context).
import { rng, utc, iso, addDays, asText, norm, isUnknown, numberMatches, parseTime, parseProbability, round } from './common.mjs';

const DEPOTS = ['Quillon', 'Marrow Bay', 'Ostler', 'Penhallow', 'Ridgeway', 'Tamsin'];
const PEOPLE = ['Hana Ito', 'Omar Haddad', 'Greta Lind', 'Felix Moreau', 'Zuri Okafor', 'Lars Bergqvist', 'Priya Nair', 'Tom Walsh'];
const FUELS = ['diesel', 'HVO', 'propane', 'natural gas'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Each fact: question, value generator (two distinct values for supersession or conflicts), sentence.
const FACTS = [
  { id: 'opened', q: 'In what year did the depot open?', kind: 'number', gen: r => 1960 + r.int(55), say: v => `The depot opened in ${v}.` },
  { id: 'bays', q: 'How many loading bays does the depot have?', kind: 'number', gen: r => 4 + r.int(20), say: v => `It has ${v} loading bays.` },
  { id: 'capacity', q: 'What is the storage capacity in tonnes?', kind: 'number', gen: r => 500 + 50 * r.int(60), say: v => `Storage capacity is ${v} tonnes.` },
  { id: 'manager', q: 'Who is the site manager?', kind: 'text', gen: r => r.pick(PEOPLE), say: v => `The site manager is ${v}.` },
  { id: 'shift', q: 'At what time does the early shift start (24-hour clock)?', kind: 'time', gen: r => `0${4 + r.int(4)}:${r.pick(['00', '15', '30', '45'])}`, say: v => `The early shift starts at ${v}.` },
  { id: 'length', q: 'What is the maximum vehicle length allowed on site, in metres?', kind: 'number', gen: r => 12 + r.int(14), say: v => `Vehicles up to ${v} metres long are allowed on site.` },
  { id: 'drill', q: 'In which month is the annual fire drill held?', kind: 'text', gen: r => r.pick(MONTHS), say: v => `The annual fire drill is held in ${v}.` },
  { id: 'fuel', q: 'What fuel does the backup generator use?', kind: 'text', gen: r => r.pick(FUELS), say: v => `The backup generator runs on ${v}.` },
  { id: 'night', q: 'How many staff work the night shift?', kind: 'number', gen: r => 2 + r.int(9), say: v => `The night shift is staffed by ${v} people.` },
  { id: 'parking', q: 'How many visitor parking spaces are there?', kind: 'number', gen: r => 5 + r.int(40), say: v => `There are ${v} visitor parking spaces.` },
  { id: 'temp', q: 'At what temperature (°C) is the cold room kept?', kind: 'number', gen: r => 1 + r.int(7), say: v => `The cold room is kept at ${v} °C.` },
  { id: 'inspect', q: 'Every how many months is the racking inspected?', kind: 'number', gen: r => r.pick([3, 4, 6, 12]), say: v => `The racking is inspected every ${v} months.` }
];

const distinctPair = (r, f) => { const a = f.gen(r); let b = f.gen(r); for (let i = 0; b === a && i < 50; i++) b = f.gen(r); return [a, b]; };

export function calibrationChallenge(seed) {
  const r = rng(seed, 'calibration-v03');
  const depot = r.pick(DEPOTS);
  const tag = r.hex(3).toUpperCase();
  const ids = { sheet: `CAL-${tag}-SHEET`, memo: `CAL-${tag}-MEMO`, north: `CAL-${tag}-REG-N`, south: `CAL-${tag}-REG-S` };
  const facts = r.shuffle(FACTS).slice(0, 10);
  const roles = r.shuffle(['plain', 'plain', 'plain', 'plain', 'plain', 'superseded', 'absent', 'absent', 'conflict', r.pick(['plain', 'conflict', 'absent'])]);
  const pages = { sheet: [], memo: [], north: [], south: [] };
  const key = [];
  facts.forEach((f, i) => {
    const role = roles[i];
    const [a, b] = distinctPair(r, f);
    if (role === 'plain') { pages[r.pick(['sheet', 'memo', 'north'])].push(f.say(a)); key.push({ q: `c${i + 1}`, y: 1, kind: f.kind, value: a }); }
    if (role === 'superseded') { pages.sheet.push(f.say(a)); pages.memo.push(f.say(b)); key.push({ q: `c${i + 1}`, y: 1, kind: f.kind, value: b, wrong: a }); }
    if (role === 'conflict') { pages.north.push(f.say(a)); pages.south.push(f.say(b)); key.push({ q: `c${i + 1}`, y: 0, kind: f.kind, conflict: [a, b] }); }
    if (role === 'absent') key.push({ q: `c${i + 1}`, y: 0, kind: f.kind });
  });
  const sheetDate = utc(2027, 1, 10 + r.int(10)), memoDate = addDays(sheetDate, 60 + r.int(60)), regDate = addDays(memoDate, 10 + r.int(20));
  const filler = [`Visitors sign in at the gatehouse.`, `Hi-vis vests are required beyond the yellow line.`, `Deliveries are booked through the yard office.`, `The canteen closes at 14:00 on Fridays.`];
  const page = (id, title, intro, lines) => [`# ${id}: ${title}`, '', intro, '', ...r.shuffle([...lines, ...r.take(filler, 2)]).map(l => `- ${l}`), ''].join('\n');
  const files = {
    [`corpus/v03-calibration/${ids.sheet}.md`]: page(ids.sheet, `${depot} depot facility sheet`, `Official facility sheet, issued ${iso(sheetDate)}.`, pages.sheet),
    [`corpus/v03-calibration/${ids.memo}.md`]: page(ids.memo, `${depot} depot operations memo`, `Official operations memo, issued ${iso(memoDate)}. Where it differs from ${ids.sheet}, this memo supersedes it.`, pages.memo),
    [`corpus/v03-calibration/${ids.north}.md`]: page(ids.north, `Regional summary (north office)`, `Official regional summary from the north office, issued ${iso(regDate)}. It has the same standing as the south office's summary; neither supersedes the other.`, pages.north),
    [`corpus/v03-calibration/${ids.south}.md`]: page(ids.south, `Regional summary (south office)`, `Official regional summary from the south office, issued ${iso(regDate)}. It has the same standing as the north office's summary; neither supersedes the other.`, pages.south)
  };
  const task = [
    `# Evidence calibration (challenge %ID%)`, '',
    `Use only the four pages in \`corpus/v03-calibration/\` about the ${depot} depot. For each question give`,
    `"answer" (or "unknown" when the pages don't settle it) and "p": your probability, from 0 to 1, that the`,
    `pages uniquely determine a supportable answer. Write "p" as a number such as 0.9, or as a percentage`,
    `string such as "90%". Save \`calibration.json\`:`, '',
    '```json',
    '{"challenge": "%ID%", "answers": {"c1": {"answer": "...", "p": 0.9}, "c2": {"answer": "unknown", "p": 0.1}}}',
    '```', '',
    ...facts.map((f, i) => `- **c${i + 1}.** ${f.q}`), ''
  ].join('\n');
  return {
    files: { 'tasks/calibration.md': task, ...files },
    key,
    reference: Object.fromEntries(key.map(k => [k.q, k.y ? { answer: String(k.value), p: 0.95 } : { answer: 'unknown', p: 0.05 }]))
  };
}

const answerMatches = (k, v) => k.kind === 'number' ? numberMatches(v, k.value).ok
  : k.kind === 'time' ? parseTime(v) === k.value
  : new RegExp(String.raw`(?<![\p{L}])${norm(k.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\p{L}])`, 'u').test(norm(v));

export function scoreCalibration(key, answers) {
  const review = [];
  const items = key.map(k => {
    const a = answers?.[k.q];
    const v = a && typeof a === 'object' && !Array.isArray(a) ? a.answer : a;
    const rawP = a && typeof a === 'object' ? a.p ?? a.probability ?? a.confidence : undefined;
    const p = rawP == null || asText(rawP).trim() === '' ? null : parseProbability(rawP);
    if (rawP != null && asText(rawP).trim() !== '' && p === null) review.push(`${k.q}: probability "${asText(rawP)}" not understood`);
    const q = p === null ? 0 : 1 - (p - k.y) ** 2;
    const abstained = isUnknown(v);
    const decision = k.y ? !abstained && answerMatches(k, v) : abstained;
    return { q: k.q, y: k.y, p, brier_q: q, abstained, decision };
  });
  const meanQ = items.reduce((n, i) => n + i.brier_q, 0) / items.length;
  for (const i of items) i.brier_q = Math.round(i.brier_q * 10000) / 10000; // display only, after the mean
  const decisions = items.filter(i => i.decision).length;
  const parts = { calibration: round(3 * meanQ), decisions: round(3 * decisions / items.length) };
  const stat = (y, f) => items.filter(i => i.y === y && f(i)).length;
  return {
    points: round(parts.calibration + parts.decisions), max: 6, parts, items, review,
    diagnostics: { answerable: { correct: stat(1, i => i.decision), wrong: stat(1, i => !i.decision && !i.abstained), not_attempted: stat(1, i => i.abstained) }, unanswerable: { abstained: stat(0, i => i.abstained), fabricated: stat(0, i => !i.abstained) } }
  };
}
