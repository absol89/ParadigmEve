import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rubric = JSON.parse(fs.readFileSync(path.join(base, 'lite-manifest.json'),'utf8'));
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/;

export function scoreLite(run) {
  if (run?.schema_version !== rubric.schema_version || !safeId.test(run.run_id??''))
    throw new Error('Invalid schema version or run id');
  for (const key of ['name','model','harness','reasoning','tools'])
    if (typeof run.agent?.[key] !== 'string' || !run.agent[key].trim())
      throw new Error('Missing agent.'+key);
  if (!['self-reported','verified'].includes(run.review?.status)) throw new Error('Invalid review status');
  if (run.review.status === 'verified' && (!run.review.reviewer?.trim() || !run.review.reference?.trim()))
    throw new Error('Verified scores need reviewer and a public review reference');
  for (const key of ['elapsed_minutes','tool_calls','approval_waits']) {
    const value = run.observations?.[key] ?? null;
    if (value !== null && (!Number.isFinite(value) || value < 0 || (key !== 'elapsed_minutes' && !Number.isInteger(value))))
      throw new Error('Invalid observation '+key);
  }
  const legal = new Set(rubric.tasks.map(t=>t.id));
  for (const id of Object.keys(run.tasks??{})) if (!legal.has(id)) throw new Error('Unknown task '+id);
  let total = 0;
  const tasks = {};
  for (const task of rubric.tasks) {
    const item=run.tasks?.[task.id]??{checks:{},evidence:[]};
    const checkNames=new Set(task.checks.map(c=>c.id));
    for (const id of Object.keys(item.checks??{})) if (!checkNames.has(id)) throw new Error('Unknown check '+task.id+'/'+id);
    if (!Array.isArray(item.evidence??[]) || (item.evidence??[]).some(x=>typeof x!=='string'||!x.trim()))
      throw new Error('Invalid evidence '+task.id);
    const score=task.checks.reduce((n,c)=>{
      const v=item.checks?.[c.id]??false;
      if(typeof v!=='boolean') throw new Error('Invalid check '+task.id+'/'+c.id);
      return n+(v?c.points:0);
    },0);
    if(score>0 && (item.evidence??[]).length===0) throw new Error('Positive checks need evidence '+task.id);
    total+=score;
    tasks[task.id]={score,max:task.max_points};
  }
  if(total>rubric.max_points) throw new Error('Overweight');
  return {run_id:run.run_id,date:run.date,agent:run.agent,review:run.review,observations:run.observations??{},total,max:rubric.max_points,tasks};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(!process.argv[2]) throw new Error('Usage: node agent-arena/tools/score-lite.mjs <lite-run.json>');
    const result=scoreLite(JSON.parse(fs.readFileSync(path.resolve(process.argv[2]),'utf8')));
    console.log(JSON.stringify(result,null,2));
    if(result.review.status!=='verified') console.error('SELF REPORTED — NOT A VERIFIED LITE SCORE');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
