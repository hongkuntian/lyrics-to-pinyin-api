import {canonicalTarget} from './languages.js';
import {createHash,randomUUID} from 'node:crypto';
import {currentTranslationSQL,publishRevision,revisions} from './revisions.js';
import {budget,checkBudget,checkEmergencyBudget,configureReviews,reserveReview,claimReviewOperation,finishReviewOperation,releaseReviewOperation} from './spending.js';
import {translationIdentity} from './translation-identity.js';
import {reusableTranslation,jobForDocument} from './translation-reuse.js';
import {reserveMemberUsage,settleMemberUsage} from '../membership/store.js';

export class LibraryError extends Error {
  constructor(code,status=409) { super(code);this.code=code;this.status=status; }
}
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0] ?? null;
const document=row=>row && ({id:row.id,recordingKey:row.recording_key,sourceHash:row.source_hash,
  canonicalRecordingID:row.canonical_recording_id??null,textRevision:row.text_revision??null,timingRevision:row.timing_revision??null,readingRevision:row.reading_revision??null,
  selectionRevision:row.selection_revision,checkedAt:row.checked_at??null,response:{...row.response,...(row.song_details?{song_details:row.song_details}:{}),...(row.provider_translation?{provider_translation:row.provider_translation}:{})},structure:row.structure});
const publicJob=row=>({id:row.id,state:row.state,documentID:row.document_id,target:row.target,errorCode:row.error_code});

export class SongLibraryStore {
  constructor(db) { this.db=db; }
  async configure({enabled,dailyMicros,monthlyMicros,userDaily=10,userMonthly=50}) {
    if(typeof enabled!=='boolean' || [dailyMicros,monthlyMicros,userDaily,userMonthly].some(x=>!Number.isSafeInteger(x)||x<0)) throw new LibraryError('invalid_budget',400);
    await this.db.query('UPDATE library_settings SET enabled=$1,daily_micros=$2,monthly_micros=$3,user_daily=$4,user_monthly=$5 WHERE id=1',[enabled,dailyMicros,monthlyMicros,userDaily,userMonthly]);
  }
  async createUser(id,token) {
    if(typeof id!=='string'||!id.trim()||id.length>128||typeof token!=='string'||!token) throw new LibraryError('invalid_user',400);
    await this.db.transaction(async db=> {
      await db.query('INSERT INTO library_users(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
      // Rotation retains the same user and all usage history, and revokes older credentials.
      await db.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[id]);
      const existing=await first(db,'SELECT user_id FROM library_tokens WHERE digest=$1',[digest(token)]);
      if(existing && existing.user_id!==id) throw new LibraryError('token_collision');
      await db.query('INSERT INTO library_tokens(digest,user_id) VALUES($1,$2) ON CONFLICT(digest) DO UPDATE SET revoked=false',[digest(token),id]);
    });
  }
  async configureUserAccess(id,{unlimitedGeneration}) {
    if(typeof id!=='string'||!id.trim()||id.length>128||typeof unlimitedGeneration!=='boolean') throw new LibraryError('invalid_user_access',400);
    await this.db.transaction(async db=> {
      // Serialize access changes with generation admission. Token rotation preserves this setting.
      await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
      const row=await first(db,'UPDATE library_users SET unlimited_generation=$2 WHERE id=$1 RETURNING id',[id,unlimitedGeneration]);
      if(!row) throw new LibraryError('user_not_found',404);
    });
  }
  async authenticate(token) {
    if(typeof token!=='string') return null;
    return first(this.db,'SELECT u.id FROM library_tokens t JOIN library_users u ON u.id=t.user_id WHERE t.digest=$1 AND NOT t.revoked AND NOT u.disabled AND (t.expires_at IS NULL OR t.expires_at>now())',[digest(token)]);
  }
  async rateLimit(userID) {
    const row=await first(this.db,`INSERT INTO library_rate_windows(user_id,window_start,count)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(user_id,window_start)
      DO UPDATE SET count=library_rate_windows.count+1 RETURNING count`,[userID]);
    if(row.count>60) throw new LibraryError('rate_limited',429);
  }
  async saveDocument(value,{replaceID=null,lookupOwner=null}={}) {
    return this.db.transaction(async db=> {
      if(lookupOwner) {
        const lease=await first(db,`SELECT owner FROM lyric_lookups WHERE request_key=$1 AND selection_revision=$2
          AND owner=$3 AND expires_at>now() FOR UPDATE`,[value.requestKey,value.selectionRevision,lookupOwner]);
        if(!lease) throw new LibraryError('lookup_superseded');
      }
      const {song_details,provider_translation,...lyricResponse}=value.response;
      await db.query(`INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure,translation_identity)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[value.id,value.recordingKey,value.sourceHash,value.selectionRevision,JSON.stringify(lyricResponse),JSON.stringify(value.structure),translationIdentity(value)]);
      if(value.canonicalRecordingID) {
        await db.query(`UPDATE lyric_documents SET canonical_recording_id=$2,text_revision=$3,timing_revision=$4,reading_revision=$5 WHERE id=$1 AND canonical_recording_id IS NULL`,
          [value.id,value.canonicalRecordingID,value.textRevision,value.timingRevision,value.readingRevision]);
        const proof=value.response.metadata.catalog_resolution;
        for(const item of proof.catalog_items??[]) {
          await db.query(`INSERT INTO catalog_recording_bindings(catalog_id,storefront,canonical_recording_id,evidence)
            VALUES($1,$2,$3,$4) ON CONFLICT(catalog_id,storefront) DO UPDATE SET canonical_recording_id=$3,evidence=$4,checked_at=now()`,
            [item.catalog_id,item.storefront,value.canonicalRecordingID,JSON.stringify(proof)]);
        }
        await db.query(`INSERT INTO recording_lyric_heads(canonical_recording_id,selection_revision,document_id)
          VALUES($1,$2,$3) ON CONFLICT(canonical_recording_id,selection_revision) DO UPDATE SET document_id=$3,checked_at=now()
          WHERE NOT EXISTS(SELECT 1 FROM lyric_documents d WHERE d.id=recording_lyric_heads.document_id
            AND (d.response->'quality'->>'synced')::boolean AND NOT $4)`,
          [value.canonicalRecordingID,value.selectionRevision,value.id,value.response.quality.synced===true]);
      }
      await db.query(`INSERT INTO lyric_document_extras(document_id,song_details,provider_translation)
        VALUES($1,$2,$3) ON CONFLICT(document_id) DO UPDATE SET song_details=$2,provider_translation=$3,checked_at=now()`,
        [value.id,JSON.stringify(song_details??null),JSON.stringify(provider_translation??null)]);
      await db.query(`INSERT INTO lyric_requests(request_key,selection_revision,document_id) VALUES($1,$2,$3)
        ON CONFLICT(request_key,selection_revision) DO NOTHING`,[value.requestKey,value.selectionRevision,value.id]);
      if(replaceID && lookupOwner) await db.query(`UPDATE lyric_requests SET document_id=$3,checked_at=now()
        WHERE request_key=$1 AND selection_revision=$2 AND document_id=$4 AND EXISTS
          (SELECT 1 FROM lyric_lookups WHERE request_key=$1 AND selection_revision=$2 AND owner=$5 AND expires_at>now())`,
        [value.requestKey,value.selectionRevision,value.id,replaceID,lookupOwner]);
      if(replaceID && lookupOwner && replaceID!==value.id) await db.query(`UPDATE lyric_requests SET document_id=$3,checked_at=now()
        WHERE selection_revision=$2 AND document_id=$4 AND EXISTS
          (SELECT 1 FROM lyric_requests WHERE request_key=$1 AND selection_revision=$2 AND document_id=$3)`,
        [value.requestKey,value.selectionRevision,value.id,replaceID]);
      // Equivalent aliases must move together, otherwise an old alias could
      // continue admitting paid work for a superseded source document.
      // A refresh may advance the head only while its lease and previous head match.
      return document(await first(db,`SELECT d.*,r.checked_at,r.selection_revision AS selection_revision,x.song_details,x.provider_translation FROM lyric_requests r JOIN lyric_documents d ON d.id=r.document_id LEFT JOIN lyric_document_extras x ON x.document_id=d.id
        WHERE r.request_key=$1 AND r.selection_revision=$2`,[value.requestKey,value.selectionRevision]));
    });
  }
  async documentForRequest(key,revision) {
    return document(await first(this.db,`SELECT d.*,r.checked_at,r.selection_revision AS selection_revision,x.song_details,x.provider_translation FROM lyric_requests r JOIN lyric_documents d ON d.id=r.document_id LEFT JOIN lyric_document_extras x ON x.document_id=d.id
      WHERE r.request_key=$1 AND r.selection_revision=$2`,[key,revision]));
  }
  // Old immutable references remain readable. Admission checks separately reject
  // retired sources, so reading a saved translation never starts fresh paid work.
  async document(id) {
    const row=await first(this.db,`SELECT d.*,x.song_details,x.provider_translation,a.response AS archived_response,a.structure AS archived_structure
      FROM lyric_documents d LEFT JOIN lyric_document_extras x ON x.document_id=d.id LEFT JOIN lyric_source_archives a ON a.document_id=d.id WHERE d.id=$1`,[id]);
    if(row?.superseded_by) {
      if(!row.archived_response?.lines?.length || !row.archived_structure?.occurrences?.length)return null;
      row.response=row.archived_response;row.structure=row.archived_structure;
    }
    return document(row);
  }
  async bindRecordingHead(request,key,revision) {
    if(!request.storefront)return null;
    return this.db.transaction(async db=>{
      const row=await first(db,`SELECT d.*,h.checked_at,h.selection_revision,x.song_details,x.provider_translation,b.evidence
        FROM catalog_recording_bindings b JOIN recording_lyric_heads h ON h.canonical_recording_id=b.canonical_recording_id
        JOIN lyric_documents d ON d.id=h.document_id LEFT JOIN lyric_document_extras x ON x.document_id=d.id
        WHERE b.catalog_id=$1 AND b.storefront=$2 AND h.selection_revision=$3 AND b.checked_at>now()-interval '1 day'
          AND d.superseded_by IS NULL`,[request.catalog_id,request.storefront,revision]);
      if(!row)return null;
      // Metadata validation is replayed by the resolver before new bindings are
      // created; this path accepts only a previously checked request signature.
      const proof=row.evidence;
      const original=proof?.accepted_request;
      if(!original || original.catalog_id!==request.catalog_id || original.artist!==request.artist || original.title!==request.title
        || original.album!==request.album || original.duration!==request.duration)return null;
      await db.query(`INSERT INTO lyric_requests(request_key,selection_revision,document_id,checked_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(request_key,selection_revision) DO NOTHING`,[key,revision,row.id,row.checked_at]);
      return document(row);
    });
  }
  async isCurrentDocument(id,revision) {
    return !!await first(this.db,'SELECT 1 FROM lyric_requests WHERE document_id=$1 AND selection_revision=$2 LIMIT 1',[id,revision]);
  }
  async claimLookup(key,revision) {
    const owner=randomUUID();
    const row=await first(this.db,`INSERT INTO lyric_lookups(request_key,selection_revision,owner,expires_at)
      VALUES($1,$2,$3,now()+interval '30 seconds') ON CONFLICT(request_key,selection_revision)
      DO UPDATE SET owner=$3,expires_at=now()+interval '30 seconds' WHERE lyric_lookups.expires_at<now() RETURNING owner`,[key,revision,owner]);
    return row?.owner??null;
  }
  async releaseLookup(key,revision,owner) { await this.db.query('DELETE FROM lyric_lookups WHERE request_key=$1 AND selection_revision=$2 AND owner=$3',[key,revision,owner]); }
  async translation(documentID,target) {
    const doc=await this.document(documentID);if(!doc)return null;
    const row=await reusableTranslation(this.db,doc,target);
    return row && {...row.content,id:row.id,recipe:row.recipe,target:row.target,documentID:row.document_id,sourceHash:row.source_hash,notesLanguage:row.target};
  }
  publishRevision(args) { return publishRevision(this.db,args); }
  rollbackRevision(args) { return publishRevision(this.db,args,{rollback:true}); }
  revisions(documentID,target) { return revisions(this.db,documentID,target); }
  budget() { return budget(this.db); }
  configureReviews(args) { return configureReviews(this.db,args); }
  reserveReview(args) { return reserveReview(this.db,args); }
  claimReviewOperation(id) { return claimReviewOperation(this.db,id); }
  finishReviewOperation(id,args) { return finishReviewOperation(this.db,id,args); }
  releaseReviewOperation(id) { return releaseReviewOperation(this.db,id); }
  async reserve({userID,documentID,target,recipe,reservedMicros,generationRequest=null,allowGeneration=false}) {
    if(canonicalTarget(target)!==target||typeof recipe!=='string'||!recipe||!Number.isSafeInteger(reservedMicros)||reservedMicros<=0) throw new LibraryError('invalid_generation',400);
    return this.db.transaction(async db=> {
      // All admission decisions use the same locked row: cached, coalesced, quota and spend checks
      // therefore agree across instances. The lock is released BEFORE contacting any provider.
      const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
      if(!settings) throw new LibraryError('store_unavailable',503);
      if(await first(db,'SELECT 1 FROM lyric_documents WHERE id=$1 AND superseded_by IS NOT NULL',[documentID])) throw new LibraryError('source_revision_superseded');
      const user=await first(db,'SELECT id,unlimited_generation,access_kind FROM library_users WHERE id=$1 AND NOT disabled',[userID]);
      if(!user) throw new LibraryError('unauthorized',401);
      const doc=document(await first(db,'SELECT * FROM lyric_documents WHERE id=$1 AND superseded_by IS NULL',[documentID]));
      if(!doc)throw new LibraryError('document_not_found',404);
      const identity=translationIdentity(doc);
      const saved=await reusableTranslation(db,doc,target);
      if(saved) return {kind:'ready',translation:{...saved.content,id:saved.id,recipe:saved.recipe,target:saved.target,documentID:saved.document_id,sourceHash:saved.source_hash,notesLanguage:saved.target}};
      const prior=await first(db,`SELECT j.* FROM translation_jobs j WHERE j.document_id=$1 AND j.target=$2
        UNION ALL SELECT j.* FROM translation_generation_keys k JOIN translation_jobs j ON j.id=k.job_id
        WHERE k.identity=$3 AND k.target=$2 LIMIT 1`,[documentID,target,identity]);
      if(prior) return {kind:prior.state==='queued'||prior.state==='running'?'pending':prior.state,job:await jobForDocument(db,prior,documentID)};
      if(user.access_kind!=='beta'&&!allowGeneration)throw new LibraryError('generation_required');
      if(!settings.enabled) throw new LibraryError('generation_disabled',503);
      const active=await first(db,"SELECT id FROM translation_jobs WHERE user_id=$1 AND state IN ('queued','running','unknown') UNION ALL SELECT id FROM study_explanations WHERE user_id=$1 AND state IN ('queued','running','unknown') LIMIT 1",[userID]);
      if(active) throw new LibraryError('user_busy',429);
      checkEmergencyBudget(settings,await budget(db),reservedMicros);
      if(!user.unlimited_generation) {
        const counts=await first(db,`SELECT count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily,
          count(*) AS monthly FROM (SELECT user_id,created_at FROM translation_jobs UNION ALL SELECT user_id,created_at FROM study_explanations UNION ALL SELECT j.user_id,r.created_at FROM translation_retry_requests r JOIN translation_jobs j ON j.id=r.job_id) attempts WHERE user_id=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[userID]);
        if(user.access_kind==='beta'&&(Number(counts.daily)>=settings.user_daily || Number(counts.monthly)>=settings.user_monthly)) throw new LibraryError('generation_allowance_exhausted',429);
        checkBudget(settings,await budget(db),reservedMicros);
      }
      const id=randomUUID();
      await reserveMemberUsage(db,userID,id,'translation');
      const row=await first(db,`INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros,generation_request)
        VALUES($1,$2,$3,$4,$5,'queued',$6,$6,$7) RETURNING *`,[id,documentID,target,recipe,userID,reservedMicros,generationRequest?JSON.stringify(generationRequest):null]);
      if(identity)await db.query('INSERT INTO translation_generation_keys(identity,target,job_id) VALUES($1,$2,$3) ON CONFLICT(identity,target) DO NOTHING',[identity,target,row.id]);
      return {kind:'created',job:publicJob(row)};
    });
  }
  async claim(id) {
    // A running/unknown job is never reclaimed: the provider may already have charged it.
    return this.db.transaction(async db=>{
      const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');if(!settings?.enabled)return null;
      checkEmergencyBudget(settings,await budget(db));
      return first(db,`UPDATE translation_jobs SET state='running',started_at=now()
        WHERE id=coalesce((SELECT job_id FROM translation_job_aliases WHERE id=$1),$1) AND state='queued'
        AND EXISTS(SELECT 1 FROM library_users u WHERE u.id=translation_jobs.user_id AND NOT u.disabled) RETURNING *`,[id]);
    });
  }
  async complete(id,content,actualMicros,response,attempt=null) {
    return this.finish(id,{content,actualMicros,response,state:'ready',errorCode:null,attempt});
  }
  async fail(id,errorCode,actualMicros,response=null,attempt=null) {
    return this.finish(id,{actualMicros,response,state:actualMicros===null?'unknown':'failed',errorCode,attempt});
  }
  async finish(id,{content,actualMicros,response,state,errorCode,attempt=null}) {
    if(actualMicros!==null && (!Number.isSafeInteger(actualMicros)||actualMicros<0)) throw new LibraryError('invalid_usage',500);
    return this.db.transaction(async db=> {
      await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
      const job=await first(db,"SELECT * FROM translation_jobs WHERE id=$1 AND state='running' AND ($2::integer IS NULL OR attempt=$2) FOR UPDATE",[id,attempt]);
      if(!job) return;
      const charged=actualMicros ?? Number(job.reserved_micros);
      if(errorCode==='provider_configuration_changed') await db.query('UPDATE library_settings SET enabled=false WHERE id=1');
      if(charged>Number(job.reserved_micros)) {
        await db.query('UPDATE library_settings SET enabled=false WHERE id=1');
        state='failed';errorCode='cost_reservation_exceeded';
      }
      if(state==='ready') await db.query(`INSERT INTO song_translations(id,document_id,target,recipe,content) VALUES($1,$2,$3,$4,$5)`,[id,job.document_id,job.target,job.recipe,JSON.stringify(content)]);
      await db.query(`UPDATE translation_jobs SET state=$2,accounted_micros=$3,error_code=$4,provider_response=$5,finished_at=now(),cost_final=$6 WHERE id=$1`,[id,state,charged,errorCode,JSON.stringify(response),actualMicros!==null]);
      await settleMemberUsage(db,id,state==='ready');
    });
  }
  async job(id) {
    const alias=await first(this.db,'SELECT * FROM translation_job_aliases WHERE id=$1',[id]);
    const jobID=alias?.job_id??id;
    // A crashed worker is visible as unknown after its execution window. Its reservation remains.
    await this.db.query("UPDATE translation_jobs SET state='unknown',error_code='worker_interrupted' WHERE id=$1 AND state='running' AND started_at<now()-interval '6 minutes'",[jobID]);
    const row=await first(this.db,'SELECT * FROM translation_jobs WHERE id=$1',[jobID]);
    if(row?.state==='unknown')await settleMemberUsage(this.db,jobID,false);
    return row && {...publicJob(row),id,documentID:alias?.document_id??row.document_id};
  }
  async usage() { return first(this.db,`SELECT coalesce(sum(accounted_micros),0) AS accounted_micros,
    count(*) FILTER(WHERE kind='generation') AS jobs,count(*) FILTER(WHERE kind<>'generation') AS review_operations FROM library_spend_operations`); }
  async report({userID,documentID,translationID=null,sourceID,category,detail}) {
    if(typeof documentID!=='string'||typeof sourceID!=='string'||
      (translationID!==null&&(typeof translationID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(translationID))))
      throw new LibraryError('invalid_report',400);
    const doc=await this.document(documentID);
    if(!doc||!doc.structure.occurrences.some(x=>x.sourceID===sourceID)||!['lyrics','translation','pronunciation','timing'].includes(category)||typeof detail!=='string'||!detail.trim()||detail.length>2000) throw new LibraryError('invalid_report',400);
    if(translationID) {
      const row=await first(this.db,`SELECT r.id FROM translation_revisions r JOIN translation_document_bindings b ON b.translation_id=r.translation_id
        WHERE r.id=$1 AND b.document_id=$2`,[translationID,documentID]);
      if(!row) throw new LibraryError('invalid_report',400);
    }
    const fingerprint=digest([userID,documentID,translationID,sourceID,category,detail.trim()]);
    return this.db.transaction(async db=> {
      await db.query('SELECT id FROM library_users WHERE id=$1 FOR UPDATE',[userID]);
      const prior=await first(db,'SELECT id,status FROM correction_reports WHERE fingerprint=$1',[fingerprint]);
      if(prior) return prior;
      const count=await first(db,"SELECT count(*) AS n FROM correction_reports WHERE user_id=$1 AND created_at>=now()-interval '1 day'",[userID]);
      if(Number(count.n)>=20) throw new LibraryError('report_allowance_exhausted',429);
      return first(db,`INSERT INTO correction_reports(id,user_id,document_id,translation_id,source_id,category,detail,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status`,[randomUUID(),userID,documentID,translationID,sourceID,category,detail.trim(),fingerprint]);
    });
  }
}
