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

// SHA-256 of a string's UTF-8 bytes, in plain JS so the generators and scorers also run in a browser.
const K256 = Uint32Array.from([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const len = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(len);
  buf.set(bytes); buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(len - 8, Math.floor(bytes.length / 0x20000000)); view.setUint32(len - 4, (bytes.length * 8) >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64), rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) w[i] = (rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 16] + (rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10)) + w[i - 7];
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (h[i] + v) >>> 0; });
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}

export const round = n => Math.round(n * 100) / 100;
export const cites = a => [a?.source, ...[].concat(a?.sources ?? [])].filter(Boolean).map(asText).join(' ').toUpperCase();
