import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreLite } from './score-lite.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'lite-runs');
const verified=[];
const ids=new Set();
let excluded=0;
for(const name of fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!f.includes('.template.')).sort()){
  const run=scoreLite(JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
  if(ids.has(run.run_id)) throw new Error('Duplicate run id '+run.run_id);
  ids.add(run.run_id);
  if(run.review.status==='verified') verified.push(run); else excluded++;
}
verified.sort((a,b)=>b.total-a.total||a.run_id.localeCompare(b.run_id));
const data={schema_version:'0.1',benchmark_version:'lite-0.1',verified_count:verified.length,excluded_self_reports:excluded,results:verified};
const safe=s=>String(s??'').replace(/[\r\n|]/g,' ').slice(0,160);
const rows=verified.map(r=>'| '+[
  safe(r.run_id),safe(r.agent.name),safe(r.agent.model),safe(r.agent.harness),
  r.total+'/30',r.tasks.L1.score+'/10',r.tasks.L2.score+'/12',r.tasks.L3.score+'/8',
  r.observations?.elapsed_minutes??'—',r.observations?.tool_calls??'—',safe(r.review.reference)
].join(' | ')+' |');
const md=[
  '# Agent Arena Lite — reviewed results', '',
  'Lite scores are out of 30 and **cannot be directly compared** with the separate 100-point full-suite results.', '',
  '| Run | Agent | Model | Harness | Total | L1 Sources | L2 Code reasoning | L3 Capabilities | Minutes | Calls | Review |',
  '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ...(rows.length?rows:['| *No verified Lite runs yet* | — | — | — | — | — | — | — | — | — | — |']),
  '', 'Verified runs: '+verified.length+'. Excluded self-reports: '+excluded+'.',
  'Only reviewer-accepted criterion checks are scored. Evidence must be independently assessed; this script does not authenticate reviews.', ''
].join('\n');
fs.writeFileSync(path.join(root,'lite-results.json'),JSON.stringify(data,null,2)+'\n');
fs.writeFileSync(path.join(root,'LITE-RESULTS.md'),md);
console.log('Built Lite results: '+verified.length+' verified, '+excluded+' self-reported excluded');
