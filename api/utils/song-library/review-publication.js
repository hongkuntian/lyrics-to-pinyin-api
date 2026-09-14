import {LibraryError,digest} from './store.js';
import {publishRevision} from './revisions.js';
import {first,within,reviewContext,saveReviewBatch} from './review-context.js';
import {releaseReviewOperation} from './spending.js';
import {REVIEW_POLICY,batchReservation} from './review-assessment.js';
import {VERIFICATION_POLICY,validatedAssessment,comparisonContext,verificationBody,parseVerification,comparisonDecision} from './review-verification.js';
import {stableJSON} from './batch-provider.js';
const hash=value=>digest(stableJSON(value));

async function currentHead(db,revisionID) {
  const container=await first(db,'SELECT t.id FROM song_translations t JOIN translation_revisions r ON r.translation_id=t.id WHERE r.id=$1 FOR UPDATE OF t',[revisionID]);
  return container&&(await first(db,'SELECT revision_id FROM translation_heads WHERE translation_id=$1',[container.id]))?.revision_id===revisionID;
}
async function outcome(db,item,disposition,reason,{candidateHash=null,comparisonHash=null,publishedID=null}={}) {
  await db.query(`INSERT INTO correction_review_outcomes(review_id,disposition,policy_version,reason,candidate_hash,comparison_hash,published_revision_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[item.review_id,disposition,VERIFICATION_POLICY,reason,candidateHash,comparisonHash,publishedID]);
  const unused=await first(db,"SELECT id FROM library_spend_operations WHERE review_id=$1 AND kind='review_verification' AND state='reserved'",[item.review_id]);
  if(unused)await releaseReviewOperation(within(db),unused.id);
  await db.query('UPDATE correction_review_queue SET state=$2,reason=$3 WHERE review_id=$1',[item.review_id,disposition,reason]);
  // Only the frozen reports actually shown to the assessor receive a disposition.
  // Late or omitted reports cannot inherit a claim that the model read their evidence.
  const ids=item.report_snapshot.map(r=>r.id);
  const changed=disposition==='published'?item.result.changes.map(c=>c.sourceID):[];
  await db.query(`UPDATE correction_reports SET assessment=$2,
    status=CASE WHEN $3='kept' THEN 'rejected' WHEN $3='published' AND source_id=ANY($4::text[]) THEN 'accepted' ELSE status END
    WHERE id=ANY($1::uuid[]) AND status='pending'`,[ids,JSON.stringify({reviewID:item.review_id,policyVersion:VERIFICATION_POLICY,disposition,reason,publishedRevisionID:publishedID}),disposition,changed]);
}

// Caller owns a transaction, worker lease and settings lock. Publication, disposition,
// report updates and the immutable outcome receipt commit together, or all roll back.
export async function advanceReviews(db,settings) {
  const counts={published:0,closed:0};
  if(!settings.enabled||!settings.review_enabled)return counts;
  const completed=(await db.query(`SELECT a.*,r.policy_version,r.model,o.state AS spend_state,o.error_code AS spend_error
    FROM correction_batch_items a JOIN translation_reviews r ON r.id=a.review_id JOIN library_spend_operations o ON o.id=a.operation_id
    WHERE a.stage='assessment' AND a.state='done' AND NOT EXISTS(SELECT 1 FROM correction_review_outcomes d WHERE d.review_id=a.review_id)
    ORDER BY a.completed_at,a.operation_id LIMIT 25`)).rows;
  for(const a of completed) {
    let c,assessment;
    if(a.spend_state!=='settled')continue;
    if(!await currentHead(db,a.revision_id)) {await outcome(db,a,'superseded','translation_revision_superseded');counts.closed++;continue;}
    try {
      if(a.error_code||a.spend_error||a.model!=='gpt-5.6-luna'||a.policy_version!==REVIEW_POLICY||!a.provider_response_id)throw new LibraryError('assessment_not_eligible');
      c=await reviewContext(db,a.revision_id);assessment=validatedAssessment(a.result,c.doc,c.content);
    } catch(e) {
      if(!(e instanceof LibraryError))throw e;
      await outcome(db,a,'blocked',e.code);counts.closed++;continue;
    }
    if(assessment.decision!=='correct') {
      await outcome(db,a,assessment.decision==='keep'?'kept':'deferred',`assessment_${assessment.decision}`);counts.closed++;continue;
    }
    const v=await first(db,`SELECT i.*,o.state AS spend_state,o.error_code AS spend_error,b.policy_version FROM correction_batch_items i
      JOIN library_spend_operations o ON o.id=i.operation_id JOIN correction_batches b ON b.id=i.batch_id WHERE i.review_id=$1 AND i.stage='verification'`,[a.review_id]);
    if(!v||!['done','cancelled'].includes(v.state))continue;
    if(v.state==='cancelled'){await outcome(db,a,'superseded','verification_cancelled');counts.closed++;continue;}
    if(v.spend_state!=='settled')continue;
    let comparison;
    try {
      if(v.error_code||v.spend_error||v.policy_version!==VERIFICATION_POLICY||!v.provider_response_id)throw new LibraryError('comparison_not_eligible');
      const body=verificationBody(c.doc,c.content,assessment,v.comparison_context);
      if(stableJSON(body)!==stableJSON(v.request_body))throw new LibraryError('comparison_request_changed');
      comparison=parseVerification(JSON.stringify(v.result),c.doc);
    } catch(e) {
      if(!(e instanceof LibraryError))throw e;
      await outcome(db,a,'blocked',e.code);counts.closed++;continue;
    }
    const decision=comparisonDecision(comparison,assessment,v.comparison_context);
    const provenance={candidateHash:hash(assessment.candidate),comparisonHash:hash(comparison)};
    if(decision!=='publish') {
      await outcome(db,a,['current_translation_preferred','translations_equivalent'].includes(decision)?'kept':'deferred',decision,provenance);counts.closed++;continue;
    }
    if(!settings.review_publication_enabled)continue;
    const published=await publishRevision(within(db),{expectedRevisionID:a.revision_id,sourceHash:c.doc.sourceHash,candidate:assessment.candidate,
      publicationKey:`automatic-review:${a.review_id}`,actor:'automatic-luna-review',
      reason:'A fresh Luna comparison preferred this exact candidate, with source evidence for every change and no detected regression.'});
    await outcome(db,a,'published','comparison_passed',{...provenance,publishedID:published.id});counts.published++;
  }
  return counts;
}

export async function prepareVerifications(db,settings) {
  if(!settings.review_publication_enabled)return null;
  const candidates=(await db.query(`SELECT a.*,o.id AS verification_id,o.reserved_micros FROM correction_batch_items a
    JOIN library_spend_operations o ON o.review_id=a.review_id AND o.kind='review_verification'
    JOIN library_spend_operations assessed ON assessed.id=a.operation_id JOIN translation_reviews r ON r.id=a.review_id
    WHERE a.stage='assessment' AND a.state='done' AND a.result->>'decision'='correct' AND o.state='reserved'
      AND a.error_code IS NULL AND a.provider_response_id IS NOT NULL AND assessed.state='settled' AND assessed.error_code IS NULL
      AND r.policy_version=$1 AND r.model='gpt-5.6-luna'
      AND NOT EXISTS(SELECT 1 FROM correction_review_outcomes d WHERE d.review_id=a.review_id)
      AND NOT EXISTS(SELECT 1 FROM correction_batch_items v WHERE v.review_id=a.review_id AND v.stage='verification')
    ORDER BY a.completed_at,a.operation_id LIMIT 5`,[REVIEW_POLICY])).rows;
  const items=[];
  for(const a of candidates) {
    let body,context;
    try {
      if(!await currentHead(db,a.revision_id))throw new LibraryError('translation_revision_superseded');
      const c=await reviewContext(db,a.revision_id),assessment=validatedAssessment(a.result,c.doc,c.content);
      context=comparisonContext(c.doc,c.content,assessment);body=verificationBody(c.doc,c.content,assessment,context);
      if(batchReservation(body)>Number(a.reserved_micros))throw new LibraryError('verification_reservation_too_small');
    } catch(e) {
      if(!(e instanceof LibraryError))throw e;
      await outcome(db,a,e.code==='translation_revision_superseded'?'superseded':'blocked',e.code);continue;
    }
    items.push({operation_id:a.verification_id,review_id:a.review_id,revision_id:a.revision_id,request_body:body,comparison_context:context});
    await db.query("UPDATE correction_review_queue SET state='reserved',reason='verification_prepared' WHERE review_id=$1",[a.review_id]);
  }
  return items.length?saveReviewBatch(db,items,'verification',VERIFICATION_POLICY):null;
}
