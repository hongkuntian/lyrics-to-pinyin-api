// Offline-only paid work. A checkpoint belongs to one reviewed plan, ceiling and
// retry allowance. No HTTP handler should import/run this engine.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {hostname} from 'node:os';

const error=code=>Object.assign(new Error(code),{code});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
 throw error('invalid_json_value');
}
function retryBound(n){if(!integer(n)||n>2)throw error('invalid_retry_allowance');return n;}
function sum(values){const n=values.reduce((a,b)=>a+b,0);if(!integer(n))throw error('amount_overflow');return n;}
function validPlan(plan){
 if(!plan||plan.version!==1||!Array.isArray(plan.tasks)||plan.id!==hash({version:1,tasks:plan.tasks}))throw error('invalid_plan');
 const normalized=planTasks(plan.tasks);
 if(normalized.id!==plan.id)throw error('invalid_plan');
 return plan;
}
// Exact duplicate IDs are coalesced; a reused ID with different body or budget
// fails rather than silently sending the wrong generation request. Ordering is
// canonical so a restarted enumeration produces the same reviewable plan ID.
export function planTasks(tasks){
 if(!Array.isArray(tasks)||tasks.length>20000)throw error('invalid_tasks');
 const unique=new Map();
 for(const task of tasks){
  if(!task||typeof task.id!=='string'||!task.id.length||task.id.length>128||!integer(task.reservationMicros)||task.body===undefined)throw error('invalid_task');
  const body=JSON.parse(canonical(task.body)),next={id:task.id,body,reservationMicros:task.reservationMicros};
  if(unique.has(task.id)&&canonical(unique.get(task.id))!==canonical(next))throw error('conflicting_task_id');
  unique.set(task.id,next);
 }
 const ordered=[...unique.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),value={version:1,tasks:ordered};
 sum(ordered.map(t=>t.reservationMicros));
 return {...value,id:hash(value)};
}
// Rates are configured USD per million tokens, equivalently USD micros/token.
// Pilot usage is a measured per-request sample, not an upper bound. The review
// receives both its estimate and the conservative exact-request reservations.
export function pricePlan(plan,{pilotUsage,rates,retryAllowance=0}={}){
 validPlan(plan);retryBound(retryAllowance);
 if(!pilotUsage||!integer(pilotUsage.input_tokens)||!integer(pilotUsage.output_tokens)||!rates||![rates.input,rates.output].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))throw error('invalid_pricing');
 const attempts=1+retryAllowance,perAttempt=pilotUsage.input_tokens*rates.input+pilotUsage.output_tokens*rates.output;
 const estimatedMicros=Math.ceil(perAttempt*plan.tasks.length*attempts),reservationMicros=sum(plan.tasks.map(t=>t.reservationMicros))*attempts;
 if(!integer(estimatedMicros)||!integer(reservationMicros))throw error('amount_overflow');
 return {version:1,planID:plan.id,currency:'USD',tasks:plan.tasks.length,maxAttempts:plan.tasks.length*attempts,retryAllowance,
  pilotUsage:{...pilotUsage},rates:{...rates},estimatedMicros,reservationMicros};
}
async function persist(path,value){
 const temporary=`${path}.${randomUUID()}.tmp`;
 let file;
 try{
  file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(value));await file.sync();await file.close();file=null;
  await rename(temporary,path);
  const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
 }finally{await file?.close();await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
function accounting(state){
 state.chargedMicros=sum(state.tasks.flatMap(t=>t.attempts.map(a=>a.chargedMicros)));
 state.state=state.tasks.some(t=>t.state==='unknown')?'unknown':state.tasks.every(t=>t.state==='ready')?'ready':'pending';
 return state;
}
function verifyState(state,plan,ceilingMicros,retryAllowance){
 if(state?.version!==1||state.planID!==plan.id||state.ceilingMicros!==ceilingMicros||state.retryAllowance!==retryAllowance||state.currency!=='USD')throw error('job_configuration_changed');
 if(!Array.isArray(state.tasks)||state.tasks.length!==plan.tasks.length)throw error('invalid_checkpoint');
 for(let i=0;i<plan.tasks.length;i++){
  const task=state.tasks[i],expected=plan.tasks[i];
  if(task.id!==expected.id||task.inputHash!==hash(expected)||!['pending','running','ready','unknown'].includes(task.state)||!Array.isArray(task.attempts)||task.attempts.length>retryAllowance+1)throw error('invalid_checkpoint');
  for(let j=0;j<task.attempts.length;j++){
   const a=task.attempts[j];
   if(a.attempt!==j+1||a.reservationMicros!==expected.reservationMicros||!integer(a.chargedMicros)||!['running','ready','failed','unknown'].includes(a.state))throw error('invalid_checkpoint');
   if(a.state==='running'&&a.chargedMicros!==a.reservationMicros)throw error('invalid_checkpoint');
  }
  if(task.state==='ready'&&(!task.attempts.length||task.attempts.at(-1).state!=='ready'||task.content===undefined))throw error('invalid_checkpoint');
  if(task.state==='running'&&task.attempts.at(-1)?.state!=='running')throw error('invalid_checkpoint');
 }
 return accounting(state);
}
// generate(task,{attempt}) returns {content,actualMicros}. Unknown usage or an
// interrupted attempt is never automatically retried. A known failed attempt
// may retry only when the adapter explicitly marks safeToRetry and provides a
// nonnegative actualMicros; adapters must not mark ambiguous network errors safe.
// .lock is intentionally never stolen: after SIGKILL an operator must verify no
// worker is alive and remove the stale lock before resuming. Resume then marks
// persisted running work unknown, preserving its entire prepaid reservation.
export async function runPreparationJob({path,plan,ceilingMicros,retryAllowance=0,generate}={}){
 validPlan(plan);retryBound(retryAllowance);
 if(typeof path!=='string'||!path||!integer(ceilingMicros)||typeof generate!=='function')throw error('invalid_job');
 await mkdir(dirname(path),{recursive:true});
 let lock;try{lock=await open(path+'.lock','wx',0o600);}catch(e){if(e.code==='EEXIST')throw error('job_locked');throw e;}
 try{
  await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname(),planID:plan.id,startedAt:new Date().toISOString()}));await lock.sync();
  let state;
  try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(state)verifyState(state,plan,ceilingMicros,retryAllowance);
  else state={version:1,currency:'USD',planID:plan.id,ceilingMicros,retryAllowance,state:'pending',chargedMicros:0,
   tasks:plan.tasks.map(t=>({id:t.id,inputHash:hash(t),state:'pending',attempts:[]}))};
  for(const task of state.tasks)if(task.state==='running'){
   task.state='unknown';task.code='worker_interrupted';task.attempts.at(-1).state='unknown';
  }
  accounting(state);await persist(path,state);
  if(state.state==='unknown'||state.state==='ready')return state;
  delete state.blockedCode;
  for(let i=0;i<state.tasks.length;i++){
   const task=state.tasks[i],input=plan.tasks[i];if(task.state==='ready')continue;
   while(task.state==='pending'){
    if(task.attempts.length>=retryAllowance+1){task.state='unknown';task.code='retry_exhausted';break;}
    if(sum([state.chargedMicros,input.reservationMicros])>ceilingMicros){state.blockedCode='currency_ceiling';accounting(state);await persist(path,state);return state;}
    const attempt={attempt:task.attempts.length+1,state:'running',reservationMicros:input.reservationMicros,chargedMicros:input.reservationMicros};
    task.attempts.push(attempt);task.state='running';accounting(state);await persist(path,state);
    try{
     const result=await generate(JSON.parse(canonical(input)),{attempt:attempt.attempt});
     if(!integer(result?.actualMicros)||result.content===undefined){task.state='unknown';attempt.state='unknown';task.code='usage_unknown';}
     else{
      // Canonicalization validates that the ready checkpoint is serializable.
      const content=JSON.parse(canonical(result.content));attempt.chargedMicros=result.actualMicros;
      if(result.actualMicros>input.reservationMicros){task.state='unknown';attempt.state='unknown';task.code='reservation_exceeded';}
      else{task.state='ready';attempt.state='ready';task.content=content;}
     }
    }catch(e){
     const known=integer(e.actualMicros);if(known)attempt.chargedMicros=e.actualMicros;
     const safe=known&&e.actualMicros<=input.reservationMicros&&e.safeToRetry===true;
     attempt.state=safe?'failed':'unknown';task.state=safe?'pending':'unknown';task.code=safe?'safe_failure':'provider_outcome_unknown';
    }
    accounting(state);await persist(path,state);
    if(task.state==='unknown')return state;
   }
   if(task.state==='unknown'){accounting(state);await persist(path,state);return state;}
  }
  accounting(state);await persist(path,state);return state;
 }finally{await lock.close();await unlink(path+'.lock');}
}
