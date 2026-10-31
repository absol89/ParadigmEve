// EVE-Al suite page. Static, client-only: no analytics, storage, submissions or third-party scripts.
import { generators, makeSeed } from './v0.2/lib/challenges.mjs';

const $ = id => document.getElementById(id);
const el = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
const copy = async (text, status) => {
  try { await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; }
  catch { status.textContent = 'Clipboard unavailable; select the text and copy it.'; }
};

for (const button of document.querySelectorAll('[data-copy]'))
  button.addEventListener('click', () => copy($(button.dataset.copy).value, $('gen-status')));

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  return r.json();
}

async function renderRubric() {
  try {
    // The v0.3 Quick reveal is v0.2's four Quick tasks plus v0.3's five; it is the only scale shown.
    const [rubric, v03] = await Promise.all([getJson('v0.2/rubric.json'), getJson('v0.3/rubric.json')]);
    const V03_AREAS = { swedish: 'Swedish (svenska)', instructions: 'exact instructions', general_fix: 'general bug fix', pushback: 'pushback vs. evidence', calibration: 'calibration' };
    const tasks = [...rubric.tiers.quick.tasks.map(t => ({ area: t.area, points: t.points })), ...v03.tasks.map(t => ({ area: V03_AREAS[t.id] ?? t.id, points: t.points }))];
    const max = tasks.reduce((n, t) => n + t.points, 0);
    const card = el('article', '', 'tier');
    card.append(el('small', 'QUICK REVEAL · %eveal · v0.3'), el('h3', `Quick reveal · ${max} points`));
    const list = el('ul');
    for (const t of tasks) list.append(el('li', `${t.area}: ${t.points}`));
    card.append(list, el('p', `Aim for ${v03.budget.target_minutes} minutes, stop at ${v03.budget.hard_stop_minutes}. Offline-capable; the hygiene, general fix and pushback tasks need Node or must be declared unable.`, 'small'));
    $('tiers').replaceChildren(card);
  } catch (e) { $('tiers').textContent = 'Rubric unavailable: ' + e.message; }
}

async function renderResults() {
  const body = $('results-body');
  try {
    const data = await getJson('v0.2/results.json');
    body.replaceChildren();
    const rows = (data.results ?? []).filter(r => r.review?.status === 'verified');
    for (const r of rows) {
      const tr = el('tr');
      const hallucinated = r.tasks?.honesty?.receipt?.stats?.fabricated ?? '—';
      for (const cell of [`${r.agent.name} / ${r.agent.persona}`, `${r.agent.model} · ${r.agent.reasoning}`, r.agent.harness, r.tier,
        `${r.total}/${r.applicable_max}`, hallucinated, r.minutes ?? '—', r.review.reference]) tr.append(el('td', String(cell)));
      body.append(tr);
    }
    if (!rows.length) { const tr = el('tr'), td = el('td', 'No verified runs yet. Nothing here is a model ranking until a reviewed run is published.'); td.colSpan = 8; tr.append(td); body.append(tr); }
    $('results-meta').textContent = `${rows.length} verified run(s). ${data.excluded_self_reports ?? 0} self-report(s) excluded.`;
  } catch (e) { body.replaceChildren(); $('results-meta').textContent = 'Results unavailable: ' + e.message; }
}

function showChallenge(kind, seed, fresh) {
  const c = generators[kind](seed);
  const out = $('gen-output');
  out.replaceChildren();
  const panels = [...(c.stages ?? []).map(s => [`Conversation ${s.chat}: paste into a NEW conversation`, s.text]), ...(c.final ? [['Final: paste into a NEW conversation', c.final]] : [])];
  panels.forEach(([title, text], i) => {
    const div = el('div');
    const area = el('textarea'); area.readOnly = true; area.value = text; area.id = 'gen-text-' + i; area.setAttribute('aria-label', title);
    const button = el('button', 'Copy'); button.type = 'button'; button.addEventListener('click', () => copy(text, $('gen-status')));
    div.append(el('h3', title), area, button);
    out.append(div);
  });
  $('gen-seed-box').hidden = !fresh;
  $('gen-seed-value').textContent = fresh ? seed : '';
  $('gen-status').textContent = `Challenge ${c.id} ready.`;
}

$('gen-new').addEventListener('click', () => {
  if (!globalThis.crypto?.getRandomValues) { $('gen-status').textContent = 'This browser has no secure random source.'; return; }
  showChallenge($('gen-kind').value, makeSeed(crypto.getRandomValues(new Uint8Array(16))), true);
});
$('gen-open').addEventListener('click', () => {
  const seed = $('gen-seed').value.trim();
  if (seed.length < 16) { $('gen-status').textContent = 'Seeds are at least 16 characters.'; return; }
  $('gen-seed').value = '';
  showChallenge($('gen-kind').value, seed, false);
});

renderRubric();
renderResults();
