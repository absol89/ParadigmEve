// Shared pieces of the v0.3 generators and scorers: the seeded RNG, dates, Swedish calendar words and
// the lenient parsers. Leniency is about form only (types, separators, wording around a value); the
// value itself is compared strictly. A reading that could go two ways is accepted only when one way
// matches, and is then flagged for review.
//
// rng, makeSeed and challengeId are byte-for-byte the v0.2 functions (lib/challenges.mjs), so a seed
// means the same thing in both versions; tools/v03.test.mjs checks that against v0.2 when it is present.

const enc = s => new TextEncoder().encode(s);

function hash128(text) {
  let h = 0x811c9dc5;
  for (const b of enc(text)) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  const out = [];
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35 + i) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    out.push(h);
  }
  return out;
}

export function rng(seed, salt) {
  let [a, b, c, d] = hash128(salt + '\u0000' + seed);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 24; i++) next();
  const api = {
    float: next,
    int: n => Math.floor(next() * n),
    pick: list => list[Math.floor(next() * list.length)],
    chance: p => next() < p,
    shuffle: list => { const a2 = [...list]; for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    take: (list, n) => api.shuffle(list).slice(0, n),
    hex: n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(next() * 16)]).join('')
  };
  return api;
}

const B32 = 'abcdefghjkmnpqrstuvwxyz23456789';
export function makeSeed(randomBytes) {
  return Array.from(randomBytes.slice(0, 16), b => B32[b % B32.length]).join('');
}

export function challengeId(seed, kind) {
  let s = kind + ':' + seed;
  for (let i = 0; i < 20000; i++) s = hash128(s).map(x => x.toString(16).padStart(8, '0')).join('');
  return kind.slice(0, 3) + '-' + s.slice(0, 10);
}

// The public practice seed. Its items ship in Eve's eveal/ folder; scores on it are open-book practice.
export const PRACTICE_SEED = 'eveal-v03-public-practice';

export const DAY = 86_400_000;
export const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
export const iso = d => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const mondayIndex = d => (d.getUTCDay() + 6) % 7;

// ISO 8601 week of a date: the week belongs to the year that holds its Thursday.
export function isoWeek(date) {
  const thursday = addDays(date, 3 - mondayIndex(date));
  const year = thursday.getUTCFullYear();
  return { year, week: 1 + Math.floor((thursday - utc(year, 1, 1)) / DAY / 7) };
}

export function isoWeekMonday(year, week) {
  const jan4 = utc(year, 1, 4);
  return addDays(jan4, (week - 1) * 7 - mondayIndex(jan4));
}

export const SV_MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
export const SV_DAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const svDate = d => `${d.getUTCDate()} ${SV_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// Agents return one value in many JSON shapes: "3.2", ["a", "b"], {"value": 5}. Score the content.
export const asText = v => v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(asText).join(', ')
  : typeof v === 'object' ? ('answer' in v ? asText(v.answer) : 'value' in v ? asText(v.value) : JSON.stringify(v)) : String(v);
export const norm = v => asText(v).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
export const isUnknown = v => {
  const t = norm(v);
  return t === '' || /^(unknown|okänt|okänd|vet ej|vet inte|n\/a|not (known|stated|determinable|answerable)|cannot be determined|can't be determined|insufficient evidence)\b/.test(t);
};

// Every number an answer could mean. Spaces (any kind) group thousands, as in "12 500 kr". A comma is
// the Swedish decimal sign ("3,5"); "12,500"-style groups also read as English thousands, and that
// reading comes back with ambiguous=true so the caller can flag it.
export function numberReadings(v) {
  const text = asText(v).normalize('NFKC').replace(/[   ]/g, ' ');
  const m = text.match(/-?\d+(?:[ ,.]\d+)*/);
  if (!m) return [];
  const t = m[0].replace(/ (?=\d{3}(?!\d))/g, '').replace(/ .*$/, '');
  const out = [];
  if (/^-?\d+(,\d+)?$/.test(t)) out.push({ value: Number(t.replace(',', '.')), ambiguous: false });
  else if (/^-?\d+(\.\d+)?$/.test(t)) out.push({ value: Number(t), ambiguous: false });
  if (/^-?\d{1,3}(,\d{3})+$/.test(t)) out.push({ value: Number(t.replace(/,/g, '')), ambiguous: true });
  if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) out.push({ value: Number(t.replace(/\./g, '')), ambiguous: true });
  if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(t)) out.push({ value: Number(t.replace(/,/g, '')), ambiguous: true });
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(t)) out.push({ value: Number(t.replace(/\./g, '').replace(',', '.')), ambiguous: true });
  return out.filter(r => Number.isFinite(r.value));
}

export function numberMatches(v, expected, tolerance = 1e-6) {
  const hit = numberReadings(v).find(r => Math.abs(r.value - expected) <= tolerance);
  return hit ? { ok: true, ambiguous: hit.ambiguous } : { ok: false, ambiguous: false };
}

// "14:30", "14.30", "kl. 14.30" -> "14:30". A 12-hour clock is not the 24-hour answer asked for.
export function parseTime(v) {
  const t = norm(v);
  const m = t.match(/(?:^|[^\d])(\d{1,2})[:.](\d{2})(?!\d)/);
  if (!m || /\b(am|pm)\b|[ap]\.m\./.test(t)) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}

// ISO dates, or "3 april 2027" / "3 april" with Swedish or English month names. Slash and dotted
// numeric dates are refused: they are exactly the ambiguity the Swedish task tests.
export function parseDate(v, defaultYear) {
  const t = norm(v);
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(utc(+m[1], +m[2], +m[3]));
  for (const hit of t.matchAll(/(\d{1,2})(?::e|e|st|nd|rd|th)?\s+([a-zåäö]+)(?:\s+(\d{4}))?/g)) {
    const month = [SV_MONTHS, EN_MONTHS].map(list => list.indexOf(hit[2])).find(i => i >= 0);
    if (month !== undefined) return iso(utc(hit[3] ? +hit[3] : defaultYear, month + 1, +hit[1]));
  }
  return null;
}

// A probability as the calibration task defines it: "80%" -> 0.8; an unmarked number in [0, 1] is a
// probability, one above 1 up to 100 a percentage. Anything else is unparseable (null).
export function parseProbability(v) {
  if (typeof v === 'number') return v >= 0 && v <= 1 ? v : v > 1 && v <= 100 ? v / 100 : null;
  const t = asText(v).trim().replace(',', '.');
  let m = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return Number(m[1]) <= 100 ? Number(m[1]) / 100 : null;
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  return m ? parseProbability(Number(m[1])) : null;
}

// The last fenced json block (or the whole text) that parses and has an "answers" object.
export function extractAnswers(text) {
  text = text.replace(/^﻿/, '');
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1]).reverse();
  for (const candidate of [...blocks, text]) {
    try { const v = JSON.parse(candidate); if (v && typeof v.answers === 'object' && v.answers) return v; } catch { /* next */ }
  }
  const brace = text.indexOf('{'), end = text.lastIndexOf('}');
  if (brace >= 0 && end > brace) { try { const v = JSON.parse(text.slice(brace, end + 1)); if (v?.answers) return v; } catch { /* none */ } }
  return null;
}

export const round = n => Math.round(n * 100) / 100;
export const cites = a => [a?.source, ...[].concat(a?.sources ?? [])].filter(Boolean).map(asText).join(' ').toUpperCase();
