// Trusted operator primitive. No public request can reset a failed job or spend again.
import {randomUUID} from 'node:crypto';
import {LibraryError,digest} from './store.js';
import {requestBody,reservationMicros,translationRecipe} from './translation.js';
import {budget,checkBudget,checkEmergencyBudget} from './spending.js';
import {reusableTranslation} from './translation-reuse.js';
import {reserveMemberUsage} from '../membership/store.js';
const first=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0]??null;
export async function retryTranslation(database,{jobID,expectedAttempt,requestKey,actor,reason,dryRun=false}) {
  if(typeof jobID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobID)||!Number.isSafeInteger(expectedAttempt)||expectedAttempt<1||
    typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200||typeof actor!=='string'||!actor.trim()||actor.length>100||
    typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new LibraryError('invalid_retry',400);
  const requestHash=digest({jobID,expectedAttempt,actor,reason});
  return database.transaction(async db=>{
    const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
    const prior=await first(db,'SELECT * FROM translation_retry_requests WHERE request_key=$1',[requestKey]);
    if(prior){if(prior.request_hash!==requestHash)throw new LibraryError('retry_key_conflict');return {jobID:prior.job_id,attempt:prior.attempt};}
    const job=await first(db,'SELECT * FROM translation_jobs WHERE id=$1 FOR UPDATE',[jobID]);if(!job)throw new LibraryError('job_not_found',404);
    if(job.attempt!==expectedAttempt)throw new LibraryError('retry_attempt_superseded');
    const operation=await first(db,'SELECT state FROM library_spend_operations WHERE generation_job_id=$1 AND generation_attempt=$2',[jobID,expectedAttempt]);
    if(job.state!=='failed'||operation?.state!=='settled')throw new LibraryError('retry_requires_known_failure');
    const row=await first(db,'SELECT * FROM lyric_documents WHERE id=$1 AND superseded_by IS NULL',[job.document_id]);
    if(!row)throw new LibraryError('source_revision_superseded');
    const doc={id:row.id,sourceHash:row.source_hash,response:row.response,structure:row.structure};
    if(!await first(db,'SELECT 1 FROM lyric_requests WHERE document_id=$1 LIMIT 1',[doc.id]))throw new LibraryError('source_revision_superseded');
    // Dry runs perform no binding writes. Actual admission checks saved content first.
    if(!dryRun&&await reusableTranslation(db,doc,job.target))throw new LibraryError('translation_already_available');
    if(!settings?.enabled)throw new LibraryError('generation_disabled',503);
    const user=await first(db,'SELECT * FROM library_users WHERE id=$1 AND NOT disabled',[job.user_id]);if(!user)throw new LibraryError('unauthorized',401);
    if(await first(db,"SELECT id FROM translation_jobs WHERE user_id=$1 AND state IN ('queued','running','unknown') UNION ALL SELECT id FROM study_explanations WHERE user_id=$1 AND state IN ('queued','running','unknown') LIMIT 1",[job.user_id]))throw new LibraryError('user_busy',429);
    const generationRequest=requestBody(doc,job.target),amount=reservationMicros(generationRequest);
    checkEmergencyBudget(settings,await budget(db),amount);
    if(!user.unlimited_generation){
      const counts=await first(db,`SELECT count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily,count(*) AS monthly
        FROM (SELECT user_id,created_at FROM translation_jobs UNION ALL SELECT user_id,created_at FROM study_explanations
        UNION ALL SELECT j.user_id,r.created_at FROM translation_retry_requests r JOIN translation_jobs j ON j.id=r.job_id) attempts
        WHERE user_id=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[job.user_id]);
      if(user.access_kind==='beta'&&(Number(counts.daily)>=settings.user_daily||Number(counts.monthly)>=settings.user_monthly))throw new LibraryError('generation_allowance_exhausted',429);
      checkBudget(settings,await budget(db),amount);
    }
    if(dryRun)return {jobID,attempt:expectedAttempt+1,reservedMicros:amount,model:generationRequest.model,maxOutputTokens:generationRequest.max_output_tokens,dryRun:true};
    await reserveMemberUsage(db,job.user_id,jobID,'translation');
    await db.query(`UPDATE translation_jobs SET attempt=attempt+1,attempt_id=$2,attempt_created_at=now(),state='queued',
      recipe=$3,generation_request=$4,reserved_micros=$5,accounted_micros=$5,cost_final=false,error_code=NULL,provider_response=NULL,started_at=NULL,finished_at=NULL WHERE id=$1`,
      [jobID,randomUUID(),translationRecipe(job.target),JSON.stringify(generationRequest),amount]);
    await db.query('INSERT INTO translation_retry_requests(request_key,request_hash,job_id,attempt,actor,reason) VALUES($1,$2,$3,$4,$5,$6)',[requestKey,requestHash,jobID,expectedAttempt+1,actor,reason]);
    return {jobID,attempt:expectedAttempt+1};
  });
}
