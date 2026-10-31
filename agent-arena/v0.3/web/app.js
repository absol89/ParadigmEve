// Page wiring for score-web.mjs. Everything stays in this tab: no storage, no network.
import { PRACTICE_SEED } from '../lib/common.mjs';
import { v03Challenge } from '../lib/bundle.mjs';
import { scorePaste, radarSvg } from './score-web.mjs';

const $ = id => document.getElementById(id);
const FIELDS = ['honesty', 'swedish', 'instructions', 'calibration', 'pushback_initial', 'pushback_final'];
const FILES = { 'honesty.json': 'honesty', 'swedish.json': 'swedish', 'instructions.md': 'instructions', 'calibration.json': 'calibration', 'pushback/initial.json': 'pushback_initial', 'pushback/final.json': 'pushback_final' };
let honestyChallenge = null, last = null;

// v0.2's generator sits beside this version on the site; without it, honesty is reported as not scored.
import('../../v0.2/lib/challenges.mjs').then(m => { honestyChallenge = m.honestyChallenge; }).catch(() => {});

const mode = () => document.querySelector('input[name="mode"]:checked').value;
const seed = () => mode() === 'practice' ? PRACTICE_SEED : $('seed').value.trim();

function showChallenge() {
  $('private-fields').hidden = mode() !== 'private';
  const s = seed();
  try { $('challenge-line').textContent = s ? `Challenge ${v03Challenge(s).id}. The agent's answers must name this id.` : 'Enter the seed.'; }
  catch (e) { $('challenge-line').textContent = e.message; }
}
document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', showChallenge));
$('seed').addEventListener('input', showChallenge);
showChallenge();

$('folder').addEventListener('change', async e => {
  for (const file of e.target.files) {
    const rel = file.webkitRelativePath.split('/').slice(1).join('/');
    if (rel in FILES) $('t-' + FILES[rel]).value = await file.text();
  }
});

$('score').addEventListener('click', () => {
  const texts = Object.fromEntries(FIELDS.map(f => [f, $('t-' + f).value]));
  try {
    last = scorePaste({ seed: seed(), honestySeed: $('honesty-seed').value.trim() || undefined, texts, honestyChallenge });
  } catch (e) { $('challenge-line').textContent = e.message; return; }
  $('result').hidden = false;
  $('standing').textContent = `${last.standing} · ${last.total} of ${last.measured_max} measured points · challenge ${last.challenge}`;
  $('radar').innerHTML = radarSvg(last.dimensions);
  const body = $('table').querySelector('tbody');
  body.replaceChildren(...last.dimensions.map(d => {
    const tr = document.createElement('tr');
    const cells = d.status === 'scored' ? [d.label, `${d.points} / ${d.max}`, `${Math.round(100 * d.fraction)}%`] : [d.label, '—', d.reason];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
    if (d.status !== 'scored') tr.className = 'na';
    return tr;
  }));
  $('flags').replaceChildren(...last.flags.map(f => Object.assign(document.createElement('li'), { textContent: f })));
  $('download').disabled = false;
});

$('download').addEventListener('click', () => {
  if (!last) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(last, null, 2) + '\n'], { type: 'application/json' }));
  a.download = `eveal-web-score-${last.challenge}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
