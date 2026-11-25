// Offline owner connection only. These tables have no runtime write grants.
import {checkBudget,budget} from '../song-library/spending.js';
import {hashID,fail} from './core.js';
const amount=n=>Number.isSafeInteger(n)&&n>=0;
export async function reservePlanBudget(database,planID,ceilingMicros){
 if(!hashID(planID)||!amount(ceilingMicros))fail();
 return database.transaction(async db=>{
  const settings=(await db.query('SELECT * FROM library_settings WHERE id=1 FOR UPDATE')).rows[0];
  if(!settings?.enabled)fail('generation_disabled',503);
  const prior=(await db.query('SELECT * FROM prepared_generation_runs WHERE plan_id=$1',[planID])).rows[0];
  if(prior){if(Number(prior.ceiling_micros)!==ceilingMicros)fail('job_configuration_changed',409);return;}
  checkBudget(settings,await budget(db),ceilingMicros);
  await db.query("INSERT INTO prepared_generation_runs(plan_id,ceiling_micros,accounted_micros,state) VALUES($1,$2,$2,'reserved')",[planID,ceilingMicros]);
 });
}
export async function budgetedGenerate(database,{planID,task,attempt,generate}){
 const reservation=task.reservationMicros;
 const prior=await database.transaction(async db=>{
  const settings=(await db.query('SELECT * FROM library_settings WHERE id=1 FOR UPDATE')).rows[0];
  if(!settings?.enabled)fail('generation_disabled',503);
  const run=(await db.query('SELECT * FROM prepared_generation_runs WHERE plan_id=$1 FOR UPDATE',[planID])).rows[0];
  if(!run)fail('budget_not_reserved',409);
  const existing=(await db.query('SELECT * FROM prepared_generation_attempts WHERE plan_id=$1 AND task_id=$2 AND attempt=$3',[planID,task.id,attempt])).rows[0];
  if(existing){if(existing.state==='ready')return {content:existing.content,actualMicros:Number(existing.accounted_micros)};fail('provider_outcome_unknown',409);}
  if(run.state!=='reserved'||!amount(reservation)||attempt!==1)fail('budget_not_reserved',409);
  const used=Number((await db.query('SELECT coalesce(sum(accounted_micros),0) AS n FROM prepared_generation_attempts WHERE plan_id=$1',[planID])).rows[0].n);
  if(used+reservation>Number(run.ceiling_micros))fail('currency_ceiling',409);
  await db.query("INSERT INTO prepared_generation_attempts(plan_id,task_id,attempt,state,accounted_micros) VALUES($1,$2,$3,'submitted',$4)",[planID,task.id,attempt,reservation]);return null;
 });
 if(prior)return prior;
 try{
  const result=await generate();
  if(!amount(result.actualMicros)||result.actualMicros>reservation||result.content===undefined)fail('usage_unknown',409);
  await database.query("UPDATE prepared_generation_attempts SET state='ready',accounted_micros=$4,content=$5 WHERE plan_id=$1 AND task_id=$2 AND attempt=$3 AND state='submitted'",[planID,task.id,attempt,result.actualMicros,JSON.stringify(result.content)]);
  return result;
 }catch(error){
  // Even known failed usage is retained conservatively. No automatic network retries.
  await database.transaction(async db=>{
   await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
   await db.query("UPDATE prepared_generation_attempts SET state='unknown' WHERE plan_id=$1 AND task_id=$2 AND attempt=$3 AND state='submitted'",[planID,task.id,attempt]);
   await db.query("UPDATE prepared_generation_runs SET state='unknown' WHERE plan_id=$1",[planID]);
  });throw error;
 }
}
export async function settlePlanBudget(database,planID,taskIDs){
 return database.transaction(async db=>{
  await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
  const rows=(await db.query('SELECT task_id,state,accounted_micros FROM prepared_generation_attempts WHERE plan_id=$1',[planID])).rows;
  if(rows.length!==taskIDs.length||rows.some(r=>r.state!=='ready'||!taskIDs.includes(r.task_id)))fail('preparation_incomplete',409);
  const actual=rows.reduce((n,r)=>n+Number(r.accounted_micros),0);
  await db.query("UPDATE prepared_generation_runs SET state='settled',accounted_micros=$2,settled_at=now() WHERE plan_id=$1 AND state='reserved'",[planID,actual]);return actual;
 });
}
