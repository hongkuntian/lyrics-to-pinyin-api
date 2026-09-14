import {randomUUID} from 'node:crypto';
import {LibraryError} from './store.js';

const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0]??null;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const publicReview=row=>({id:row.id,revisionID:row.revision_id,assessmentID:row.assessment_id,verificationID:row.verification_id});
const reviewSQL=`SELECT r.*,a.id AS assessment_id,v.id AS verification_id FROM translation_reviews r
  JOIN library_spend_operations a ON a.review_id=r.id AND a.kind='review_assessment'
  JOIN library_spend_operations v ON v.review_id=r.id AND v.kind='review_verification' WHERE r.revision_id=$1`;
export const budget=db=>first(db,'SELECT * FROM library_spend_totals');
export function checkBudget(settings,totals,amount,{review=false}={}) {
  if(Number(totals.daily)+amount>Number(settings.daily_micros)||Number(totals.monthly)+amount>Number(settings.monthly_micros))
    throw new LibraryError('budget_exhausted',429);
  if(review&&(Number(totals.review_daily)+amount>Number(settings.review_daily_micros)||Number(totals.review_monthly)+amount>Number(settings.review_monthly_micros)))
    throw new LibraryError('review_budget_exhausted',429);
}
export async function configureReviews(db,{enabled,dailyMicros,monthlyMicros,maxDaily=5}) {
  if(typeof enabled!=='boolean'||[dailyMicros,monthlyMicros,maxDaily].some(x=>!Number.isSafeInteger(x)||x<0)||maxDaily>100)
    throw new LibraryError('invalid_budget',400);
  await db.query('UPDATE library_settings SET review_enabled=$1,review_daily_micros=$2,review_monthly_micros=$3,review_max_daily=$4 WHERE id=1',
    [enabled,dailyMicros,monthlyMicros,maxDaily]);
}
export async function reserveReview(database,{revisionID,policyVersion,assessmentMicros,verificationMicros,model='gpt-5.6-luna'}) {
  if(typeof revisionID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(revisionID)||
    typeof policyVersion!=='string'||!policyVersion.trim()||policyVersion.length>100||model!=='gpt-5.6-luna'||
    !positive(assessmentMicros)||!positive(verificationMicros)||!positive(assessmentMicros+verificationMicros)) throw new LibraryError('invalid_review',400);
  return database.transaction(async db=> {
    const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
    if(!settings) throw new LibraryError('store_unavailable',503);
    const prior=await first(db,reviewSQL,[revisionID]);
    if(prior) return {...publicReview(prior),created:false};
    if(!settings.enabled) throw new LibraryError('generation_disabled',503);
    if(!settings.review_enabled) throw new LibraryError('review_disabled',503);
    // Sharing the container lock with publication prevents reserving against a superseded head.
    const current=await first(db,`SELECT t.id FROM translation_heads h JOIN song_translations t ON t.id=h.translation_id
      WHERE h.revision_id=$1 FOR UPDATE OF t`,[revisionID]);
    if(!current) throw new LibraryError('translation_revision_superseded');
    const head=await first(db,'SELECT revision_id FROM translation_heads WHERE translation_id=$1',[current.id]);
    if(head.revision_id!==revisionID) throw new LibraryError('translation_revision_superseded');
    const count=await first(db,"SELECT count(*) AS n FROM translation_reviews WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
    if(Number(count.n)>=settings.review_max_daily) throw new LibraryError('review_allowance_exhausted',429);
    checkBudget(settings,await budget(db),assessmentMicros+verificationMicros,{review:true});
    const id=randomUUID(),assessmentID=randomUUID(),verificationID=randomUUID();
    await db.query('INSERT INTO translation_reviews(id,revision_id,policy_version,model) VALUES($1,$2,$3,$4)',[id,revisionID,policyVersion,model]);
    for(const [operationID,kind,amount] of [[assessmentID,'review_assessment',assessmentMicros],[verificationID,'review_verification',verificationMicros]]) {
      await db.query(`INSERT INTO library_spend_operations(id,operation_key,kind,review_id,state,reserved_micros,accounted_micros)
        VALUES($1,$2,$3,$4,'reserved',$5,$5)`,[operationID,`${id}:${kind}`,kind,id,amount]);
    }
    return {id,revisionID,assessmentID,verificationID,created:true};
  });
}
export async function claimReviewOperation(database,id) {
  return database.transaction(async db=> {
    const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
    if(!settings?.enabled||!settings.review_enabled) return null;
    // This transition happens BEFORE any network request. Submitted/unknown work is never reclaimed.
    return first(db,`UPDATE library_spend_operations SET state='submitted',submitted_at=now()
      WHERE id=$1 AND kind<>'generation' AND state='reserved' RETURNING *`,[id]);
  });
}
export async function finishReviewOperation(database,id,{actualMicros,providerID=null,errorCode=null}) {
  if(actualMicros!==null&&(!Number.isSafeInteger(actualMicros)||actualMicros<0)||
    providerID!==null&&(typeof providerID!=='string'||providerID.length>200)||errorCode!==null&&(typeof errorCode!=='string'||errorCode.length>100))
    throw new LibraryError('invalid_usage',400);
  return database.transaction(async db=> {
    await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
    const op=await first(db,"SELECT * FROM library_spend_operations WHERE id=$1 AND kind<>'generation' FOR UPDATE",[id]);
    if(!op) throw new LibraryError('operation_not_found',404);
    if(op.state==='settled') {
      if(Number(op.accounted_micros)!==actualMicros||op.provider_id!==providerID) throw new LibraryError('operation_settlement_conflict');
      return;
    }
    if(!['submitted','unknown'].includes(op.state)) throw new LibraryError('operation_not_submitted');
    const charged=actualMicros??Number(op.reserved_micros);
    if(charged>Number(op.reserved_micros)||errorCode==='provider_configuration_changed') {
      await db.query('UPDATE library_settings SET enabled=false,review_enabled=false WHERE id=1');
      if(charged>Number(op.reserved_micros)) errorCode='cost_reservation_exceeded';
    }
    await db.query(`UPDATE library_spend_operations SET state=$2,accounted_micros=$3,provider_id=$4,error_code=$5,
      settled_at=CASE WHEN $2='settled' THEN now() ELSE NULL END WHERE id=$1`,
      [id,actualMicros===null?'unknown':'settled',charged,providerID,errorCode]);
  });
}
export async function releaseReviewOperation(database,id) {
  return database.transaction(async db=> {
    await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
    const op=await first(db,"SELECT * FROM library_spend_operations WHERE id=$1 AND kind<>'generation' FOR UPDATE",[id]);
    if(op?.state==='released') return;
    if(op?.state!=='reserved') throw new LibraryError('operation_not_releasable');
    await db.query("UPDATE library_spend_operations SET state='released',accounted_micros=0 WHERE id=$1",[id]);
  });
}
