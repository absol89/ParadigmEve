// Static client-only rendering. No analytics, credentials, submission requests or CDNs.
const $ = id => document.getElementById(id);
const el = (tag, text, className = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};
const link = (title, href) => {
  const node = el('a', title);
  node.href = href;
  return node;
};
async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' while loading ' + url);
  return response.json();
}
async function render() {
  try {
    const [manifest, rankings, liteRankings] = await Promise.all([getJson('manifest.json'), getJson('results.json'), getJson('lite-results.json')]);
    const tracks = $('tracks');
    tracks.replaceChildren();
    for (const track of manifest.tracks) {
      const card = el('article', '', 'track');
      card.append(el('small', track.id.toUpperCase()), el('strong', track.title), el('div', String(track.max_points), 'score'), el('small', 'points available'));
      tracks.append(card);
    }
    const list = $('task-grid');
    list.replaceChildren();
    for (const task of manifest.tasks) {
      const card = el('article', '', 'task');
      const links = el('div', '', 'links');
      links.append(link('Read task', task.prompt));
      if (task.fixture_archive) links.append(link('Download tiny ZIP', task.fixture_archive));
      card.append(el('div', task.track + ' · ' + task.max_points + ' points', 'tag'), el('h3', task.id.replaceAll('-', ' ')),
        el('p', task.checks.map(x => x.description).join(' ')), links);
      list.append(card);
    }
    const body = $('leaderboard');
    body.replaceChildren();
    const verified = (rankings.results ?? []).filter(x => x.review?.status === 'verified');
    for (const result of verified) {
      const row = document.createElement('tr');
      const cells = [result.agent.name + ' / ' + result.agent.model, result.agent.harness,
        result.total + '/100', ...['code', 'memory', 'hotlink', 'research', 'capability'].map(t => result.tracks?.[t]?.score ?? '—'),
        result.observations?.elapsed_minutes ?? '—', result.observations?.tool_calls ?? '—'];
      for (const cell of cells) row.append(el('td', String(cell)));
      body.append(row);
    }
    if (!verified.length) {
      const row = document.createElement('tr');
      const cell = el('td', 'No independently verified runs published yet. The leaderboard will populate after reviewed submissions.');
      cell.colSpan = 10;
      row.append(cell);
      body.append(row);
    }
    $('results-meta').textContent = verified.length + ' verified result(s). ' + (rankings.excluded_self_reports ?? 0) + ' self-reported submission(s) excluded.';
    const liteBody=$('lite-leaderboard');
    liteBody.replaceChildren();
    const liteVerified=(liteRankings.results??[]).filter(r=>r.review?.status==='verified');
    for(const result of liteVerified){
      const tr=document.createElement('tr');
      const cells=[
        result.agent.name+' / '+result.agent.model,result.agent.harness,result.total+'/30',
        result.tasks?.L1?.score??'—',result.tasks?.L2?.score??'—',result.tasks?.L3?.score??'—',
        result.observations?.elapsed_minutes??'—'
      ];
      for(const cell of cells) tr.append(el('td',String(cell)));
      liteBody.append(tr);
    }
    if(!liteVerified.length){
      const tr=document.createElement('tr'),cell=el('td','No independently verified Lite runs yet.');
      cell.colSpan=7;tr.append(cell);liteBody.append(tr);
    }
    $('lite-results-meta').textContent=liteVerified.length+' verified Lite run(s), '+(liteRankings.excluded_self_reports??0)+' self-reports excluded.';
  } catch (error) {
    $('tracks').textContent = 'Catalog unavailable: ' + error.message;
    $('task-grid').textContent = 'Open manifest.json directly to read the task catalog.';
    $('leaderboard').textContent = 'Published results unavailable.';
    $('lite-leaderboard').textContent = 'Lite results unavailable.';
  }
}
render();

// A runner-only, entirely local synthetic context challenge. No server, storage
// or network request. The runner must not share the private answer with a contestant.
let challenge = null;
const choice = arr => arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length];
$('generate-challenge').addEventListener('click', () => {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    $('challenge-status').textContent = 'This browser lacks secure random generation.';
    return;
  }
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  const type = $('challenge-kind').value;
  const facts = {
    project: choice(['Saffron Atlas', 'Moss Meridian', 'Hollow Lantern', 'Glacier Kite']),
    milestone: choice(['Alpha-13', 'Tango-28', 'Quartz-07', 'Pine-42']),
    owner: choice(['Nora', 'Vega', 'Pax', 'Sami']),
    checkpoint: choice(['October 9', 'November 18', 'January 24', 'May 6']),
    rule: choice(['never overwrite a disputed send', 'retain the first approved revision', 'verify hashes before reporting', 'defer changes until evidence is complete'])
  };
  const handle = '%arena-' + id;
  const line = Object.entries(facts).map(([k, v]) => k + ': ' + v).join('; ');
  const stage1 = type === 'durable-hotlink'
    ? 'Create a durable reference named ' + handle + ' with five synthetic facts: ' + line + '. Confirm what actually persisted and where, without changing global rules.'
    : 'Please remember these five synthetic facts for a later conversation under challenge id ' + id + ': ' + line + '. Use only genuine durable memory facilities; report if impossible.';
  const stage2 = type === 'durable-hotlink'
    ? 'In this new chat, resolve the previously stored reference ' + handle + '. Return project, milestone, owner, checkpoint and rule. If unavailable, do not guess.'
    : 'In this new chat, retrieve the five facts I previously asked you to remember for challenge id ' + id + '. Return project, milestone, owner, checkpoint and rule. If unavailable, do not guess.';
  challenge = { type, id, handle, stage1, stage2, PRIVATE_RUNNER_ANSWER: facts };
  $('stage1').value = stage1;
  $('stage2').value = stage2;
  $('private-answer').textContent = JSON.stringify({ id, handle, facts }, null, 2);
  $('challenge-output').hidden = false;
  $('challenge-status').textContent = 'Unique synthetic challenge created locally.';
});
for (const step of [1, 2]) {
  $('copy-stage' + step).addEventListener('click', async () => {
    if (!challenge) return;
    const text = challenge['stage' + step];
    try { await navigator.clipboard.writeText(text); $('challenge-status').textContent = 'Stage ' + step + ' copied.'; }
    catch { $('challenge-status').textContent = 'Clipboard unavailable; select and copy the prompt manually.'; }
  });
}
$('save-answer').addEventListener('click', () => {
  if (!challenge) return;
  const data = JSON.stringify(challenge, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'agent-arena-runner-' + challenge.id + '.json';
  a.click();
  URL.revokeObjectURL(url);
});
