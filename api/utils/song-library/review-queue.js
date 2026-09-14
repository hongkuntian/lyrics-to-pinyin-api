import {randomUUID} from 'node:crypto';
import {LibraryError,digest} from './store.js';
import {reserveReview,claimReviewOperation,finishReviewOperation,releaseReviewOperation} from './spending.js';
import {assessmentBody,batchReservation,VERIFICATION_RESERVATION,REVIEW_POLICY,assessRecord} from './review-assessment.js';
import {BatchProvider,batchInput,batchMatches,parseBatchFiles,stableJSON} from './batch-provider.js';
import {first,within,reviewContext as context,saveReviewBatch} from './review-context.js';
import {advanceReviews,prepareVerifications} from './review-publication.js';
import {parseVerification} from './review-verification.js';
export class ReviewQueue {
  constructor(db,owner=randomUUID()) {this.db=db;this.owner=owner;}
  async acquire() {
    return !!await first(this.db,`UPDATE correction_worker SET owner=$1,lease_until=now()+interval '6 minutes',last_run_at=now()
      WHERE id=1 AND (owner IS NULL OR lease_until<now()) RETURNING id`,[this.owner]);
  }
  async release(outcome) {
    await this.db.query('UPDATE correction_worker SET owner=NULL,lease_until=NULL,last_outcome=$2 WHERE id=1 AND owner=$1',[this.owner,outcome]);
  }
  async tx(fn) {
    return this.db.transaction(async db=> {
      // Fences expired workers, even if an earlier HTTP request completes after takeover.
      const owned=await first(db,'SELECT id FROM correction_worker WHERE id=1 AND owner=$1 AND lease_until>now() FOR UPDATE',[this.owner]);
      if(!owned)throw new LibraryError('worker_lease_lost',503);
      return fn(db);
    });
  }
  active() {return first(this.db,"SELECT * FROM correction_batches WHERE state NOT IN ('completed','cancelled')");}
  async items(id) {return (await this.db.query('SELECT * FROM correction_batch_items WHERE batch_id=$1 ORDER BY operation_id',[id])).rows;}
  async prepare() {
    return this.tx(async db=> {
      const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
      const active=await first(db,"SELECT * FROM correction_batches WHERE state NOT IN ('completed','cancelled')");
      if(active)return {batch:active};
      if(!settings?.enabled||!settings.review_enabled)return {outcome:'review_disabled'};
      const advanced=await advanceReviews(db,settings);
      const verification=await prepareVerifications(db,settings);
      if(verification)return {batch:verification};
      if(!settings.review_max_daily)return {outcome:'review_allowance_exhausted'};
      // Superseded revisions cost nothing. Age gets priority after seven days; reporter
      // count is capped so a report flood cannot grow the paid queue for one revision.
      await db.query(`UPDATE correction_review_queue q SET state='superseded',reason='translation_revision_superseded'
        WHERE state='pending' AND NOT EXISTS(SELECT 1 FROM translation_heads h WHERE h.revision_id=q.revision_id)`);
      const candidates=(await db.query(`SELECT q.revision_id FROM correction_review_queue q WHERE q.state='pending'
        ORDER BY (q.first_reported_at<now()-interval '7 days') DESC,
        least(3,(SELECT count(DISTINCT user_id) FROM correction_reports r WHERE r.translation_id=q.revision_id AND r.category='translation')) DESC,
        q.first_reported_at,q.revision_id LIMIT 25`)).rows;
      const items=[];let outcome=advanced.published?'published':advanced.closed?'review_completed':'empty';
      for(const row of candidates) {
        if(items.length>=Math.min(5,settings.review_max_daily))break;
        let c,body,reports;
        try {
          c=await context(db,row.revision_id);
          reports=(await db.query(`SELECT id,source_id,detail FROM (
            SELECT id,source_id,detail,created_at,row_number() OVER(PARTITION BY user_id ORDER BY created_at,id) AS per_user
            FROM correction_reports WHERE translation_id=$1 AND category='translation' AND status='pending') r
            WHERE per_user<=2 ORDER BY per_user,created_at,id LIMIT 10`,[row.revision_id])).rows;
          if(!reports.length)throw new LibraryError('no_pending_translation_reports');
          body=assessmentBody(c.doc,c.content,reports);batchReservation(body);
        } catch(e) {
          if(!(e instanceof LibraryError))throw e;
          await db.query("UPDATE correction_review_queue SET state='blocked',reason=$2 WHERE revision_id=$1",[row.revision_id,e.code]);continue;
        }
        let review;
        try {review=await reserveReview(within(db),{revisionID:row.revision_id,policyVersion:REVIEW_POLICY,
          assessmentMicros:batchReservation(body),verificationMicros:VERIFICATION_RESERVATION});}
        catch(e) {
          if(!['budget_exhausted','review_budget_exhausted','review_allowance_exhausted'].includes(e.code))throw e;
          outcome=e.code;break;
        }
        if(!review.created) {
          await db.query("UPDATE correction_review_queue SET state='blocked',review_id=$2,reason='revision_already_reviewed' WHERE revision_id=$1",[row.revision_id,review.id]);continue;
        }
        items.push({operation_id:review.assessmentID,review_id:review.id,revision_id:row.revision_id,request_body:body,report_snapshot:reports});
        await db.query("UPDATE correction_review_queue SET state='reserved',review_id=$2,reason=NULL WHERE revision_id=$1",[row.revision_id,review.id]);
      }
      if(!items.length)return {outcome};
      return {batch:await saveReviewBatch(db,items,'assessment',REVIEW_POLICY)};
    });
  }
  async transition(id,from,to) {
    return this.tx(db=>first(db,'UPDATE correction_batches SET state=$3,error_code=NULL,updated_at=now() WHERE id=$1 AND state=$2 RETURNING *',[id,from,to]));
  }
  async uploaded(local,fileID) {
    if(typeof fileID!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(fileID))throw new LibraryError('invalid_provider_id',502);
    return this.tx(db=>first(db,"UPDATE correction_batches SET state='uploaded',input_file_id=$2,error_code=NULL,updated_at=now() WHERE id=$1 AND state='uploading' RETURNING *",[local.id,fileID]));
  }
  async claim(local) {
    return this.tx(async db=> {
      const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
      if(!settings?.enabled||!settings.review_enabled)return null;
      if(local.stage==='verification'&&!settings.review_publication_enabled)return null;
      const items=(await db.query('SELECT * FROM correction_batch_items WHERE batch_id=$1 ORDER BY operation_id',[local.id])).rows;
      if(digest(batchInput(items))!==local.request_hash)throw new LibraryError('batch_request_changed');
      for(const i of items) {
        const head=await first(db,`SELECT h.revision_id,t.id AS translation_id FROM translation_heads h JOIN song_translations t ON t.id=h.translation_id
          WHERE h.revision_id=$1 FOR UPDATE OF t`,[i.revision_id]);
        const fresh=head&&await first(db,'SELECT revision_id FROM translation_heads WHERE translation_id=$1',[head.translation_id]);
        if(fresh?.revision_id!==i.revision_id) {
          for(const item of items) {
            const ops=(await db.query("SELECT id FROM library_spend_operations WHERE review_id=$1 AND state='reserved'",[item.review_id])).rows;
            for(const op of ops)await releaseReviewOperation(within(db),op.id);
          }
          await db.query("UPDATE correction_batch_items SET state='cancelled',error_code='batch_source_superseded' WHERE batch_id=$1",[local.id]);
          await db.query("UPDATE correction_review_queue SET state='blocked',reason='batch_source_superseded' WHERE review_id IN(SELECT review_id FROM correction_batch_items WHERE batch_id=$1)",[local.id]);
          await db.query("UPDATE correction_batches SET state='cancelled',error_code='batch_source_superseded',updated_at=now() WHERE id=$1",[local.id]);
          return null;
        }
      }
      const claimed=await first(db,"UPDATE correction_batches SET state='submitting',updated_at=now(),error_code=NULL WHERE id=$1 AND state='uploaded' RETURNING *",[local.id]);
      if(!claimed)return null;
      for(const i of items)if(!await claimReviewOperation(within(db),i.operation_id))throw new LibraryError('operation_already_claimed');
      await db.query("UPDATE correction_review_queue SET state='submitted',reason=$2 WHERE review_id IN(SELECT review_id FROM correction_batch_items WHERE batch_id=$1)",[local.id,local.stage==='verification'?'verification_submitted':null]);
      return claimed;
    });
  }
  async attach(local,remote) {
    if(!batchMatches(remote,local)||typeof remote.id!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(remote.id))throw new LibraryError('batch_identity_conflict',502);
    return this.tx(db=>first(db,`UPDATE correction_batches SET state='submitted',provider_batch_id=$2,provider_status=$3,error_code=NULL,updated_at=now()
      WHERE id=$1 AND state='submitting' RETURNING *`,[local.id,remote.id,remote.status]));
  }
  async markError(id,code) {
    return this.tx(async db=> {
      if(['batch_identity_conflict','batch_request_changed','provider_configuration_changed'].includes(code))await db.query('UPDATE library_settings SET review_enabled=false WHERE id=1');
      await db.query('UPDATE correction_batches SET error_code=$2,updated_at=now() WHERE id=$1',[id,code]);
    });
  }
  async settle(local,remote,records) {
    return this.tx(async db=> {
      await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
      const items=(await db.query('SELECT * FROM correction_batch_items WHERE batch_id=$1 ORDER BY operation_id',[local.id])).rows;
      let unknown=false;
      for(const i of items) {
        const record=records.get(i.operation_id),hash=record?digest(stableJSON(record)):null;
        if(i.state==='done') {
          if(hash&&i.result_hash!==hash)throw new LibraryError('batch_result_identity_conflict',502);
          continue;
        }
        const c=await context(db,i.revision_id);
        const assessed=record?assessRecord(record,c.doc,c.content,i.stage==='verification'?parseVerification:undefined):{actualMicros:null,result:null,errorCode:'batch_result_missing'};
        const current=!!await first(db,'SELECT 1 FROM translation_heads WHERE revision_id=$1',[i.revision_id]);
        if(!current&&assessed.errorCode!=='provider_configuration_changed')assessed.errorCode='translation_revision_superseded';
        await finishReviewOperation(within(db),i.operation_id,{actualMicros:assessed.actualMicros,providerID:remote.id,errorCode:assessed.errorCode});
        const known=assessed.actualMicros!==null;unknown ||= !known;
        const usage=known&&record?.response?.body?.usage;
        const responseID=record?.response?.body?.id;
        await db.query(`UPDATE correction_batch_items SET state=$2,result=$3,result_hash=$4,error_code=$5,usage=$6,provider_response_id=$7,completed_at=now() WHERE operation_id=$1`,
          [i.operation_id,known?'done':'unknown',assessed.result?JSON.stringify(assessed.result):null,hash,assessed.errorCode,
            usage?JSON.stringify({input_tokens:usage.input_tokens,output_tokens:usage.output_tokens}):null,
            typeof responseID==='string'&&responseID.length<=200?responseID:null]);
        if(i.stage==='assessment'&&known&&(!current||assessed.result?.decision!=='correct')) {
          const v=await first(db,"SELECT id FROM library_spend_operations WHERE review_id=$1 AND kind='review_verification'",[i.review_id]);
          await releaseReviewOperation(within(db),v.id);
        }
        await db.query('UPDATE correction_review_queue SET state=$2,reason=$3 WHERE revision_id=$1',
          [i.revision_id,known?(current?'assessed':'superseded'):'submitted',assessed.errorCode??(i.stage==='verification'?'comparison_completed':assessed.result?.decision==='correct'?'awaiting_verification':assessed.result?.decision)]);
      }
      await db.query('UPDATE correction_batches SET state=$2,provider_status=$3,error_code=$4,updated_at=now() WHERE id=$1',
        [local.id,unknown?'submitted':'completed',remote.status,unknown?'provider_usage_unknown':null]);
      const settings=await first(db,'SELECT * FROM library_settings WHERE id=1');
      const advanced=await advanceReviews(db,settings);
      return unknown?'reconciliation_required':advanced.published?'published':local.stage==='verification'?'review_completed':'assessed';
    });
  }
}

export async function runReviewQueue({db,provider=new BatchProvider({apiKey:process.env.OPENAI_API_KEY}),queue=new ReviewQueue(db)}={}) {
  if(!await queue.acquire())return {state:'worker_busy'};
  let outcome='worker_interrupted',local;
  try {
    const prepared=await queue.prepare();local=prepared.batch;
    if(!local){outcome=prepared.outcome;return {state:outcome};}
    const items=await queue.items(local.id);
    if(local.state==='prepared') {
      local=await queue.transition(local.id,'prepared','uploading');
      local=await queue.uploaded(local,await provider.upload(local,items));
    } else if(local.state==='uploading') {
      const file=await provider.findUpload(local,items);
      if(!file){outcome='upload_reconciliation_required';await queue.markError(local.id,outcome);return {state:outcome};}
      local=await queue.uploaded(local,file);
    }
    if(local.state==='uploaded') {
      const claimed=await queue.claim(local);
      if(!claimed){outcome='submission_paused';return {state:outcome};}
      local=claimed;local=await queue.attach(local,await provider.submit(local));
    } else if(local.state==='submitting') {
      const remote=await provider.findBatch(local);
      if(!remote){outcome='submission_reconciliation_required';await queue.markError(local.id,outcome);return {state:outcome};}
      local=await queue.attach(local,remote);
    }
    const remote=await provider.get(local.provider_batch_id);
    if(!batchMatches(remote,local)||remote.id!==local.provider_batch_id)throw new LibraryError('batch_identity_conflict',502);
    if(!['completed','expired','cancelled','failed'].includes(remote.status)) {
      await queue.tx(db=>db.query('UPDATE correction_batches SET provider_status=$2,error_code=NULL,updated_at=now() WHERE id=$1',[local.id,remote.status]));
      outcome='processing';return {state:outcome,assessments:items.length};
    }
    const texts=[];
    for(const file of [remote.output_file_id,remote.error_file_id].filter(Boolean))texts.push(await provider.file(file));
    const records=parseBatchFiles(texts,items);
    outcome=await queue.settle(local,remote,records);
    return {state:outcome,assessments:items.length};
  } catch(e) {
    outcome=e instanceof LibraryError?e.code:'worker_storage_failure';
    if(local)await queue.markError(local.id,outcome).catch(()=>{});
    return {state:outcome};
  } finally {await queue.release(outcome);}
}
