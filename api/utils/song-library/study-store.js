import {randomUUID} from 'node:crypto';
import {LibraryError} from './store.js';
import {budget,checkBudget,finishReviewOperation} from './spending.js';
const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0]??null;
export const publicExplanation=row=>({id:row.id,documentID:row.document_id,translationID:row.revision_id,sourceID:row.source_id,
  lower:row.lower_offset,upper:row.upper_offset,recipe:row.recipe,...row.content,
  ...(row.contract_version===2?{contractVersion:2,explanationLanguage:row.explanation_language,studyText:row.study_text,
    selection:{offsetUnit:'grapheme',ranges:[{lower:row.lower_offset,upper:row.upper_offset}],textHash:row.selection_text_hash}}:{})});
export async function reserveExplanation(database,{key,doc,translation,selection,recipe,userID,amount,explanationLanguage='en',generationRequest=null}) {
  return database.transaction(async db=>{
    const settings=await first(db,'SELECT * FROM library_settings WHERE id=1 FOR UPDATE');
    const prior=await first(db,'SELECT * FROM study_explanations WHERE cache_key=$1',[key]);
    if(prior)return {created:false,row:prior};
    if(!settings?.enabled)throw new LibraryError('generation_disabled',503);
    const user=await first(db,'SELECT id FROM library_users WHERE id=$1 AND NOT disabled',[userID]);
    if(!user)throw new LibraryError('unauthorized',401);
    if(translation) {
      const head=await first(db,`SELECT h.revision_id FROM translation_heads h JOIN song_translations t ON t.id=h.translation_id WHERE t.document_id=$1 AND t.target=$2 FOR UPDATE OF t`,[doc.id,translation.target??'en']);
      if(head?.revision_id!==translation.id)throw new LibraryError('translation_revision_superseded');
    }
    const active=await first(db,`SELECT id FROM translation_jobs WHERE user_id=$1 AND state IN ('queued','running','unknown')
      UNION ALL SELECT id FROM study_explanations WHERE user_id=$1 AND state IN ('queued','running','unknown') LIMIT 1`,[userID]);
    if(active)throw new LibraryError('user_busy',429);
    const counts=await first(db,`SELECT count(*) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily,count(*) AS monthly
      FROM (SELECT user_id,created_at FROM translation_jobs UNION ALL SELECT user_id,created_at FROM study_explanations) attempts
      WHERE user_id=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[userID]);
    if(Number(counts.daily)>=settings.user_daily||Number(counts.monthly)>=settings.user_monthly)throw new LibraryError('generation_allowance_exhausted',429);
    checkBudget(settings,await budget(db),amount);
    const id=randomUUID();
    const row=await first(db,`INSERT INTO study_explanations(id,cache_key,document_id,revision_id,source_id,lower_offset,upper_offset,recipe,user_id,state,contract_version,explanation_language,study_text,selection_text_hash,generation_request)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12,$13,$14) RETURNING *`,[id,key,doc.id,translation?.id??null,selection.sourceID,selection.lower,selection.upper,recipe,userID,selection.studyText?2:1,explanationLanguage,selection.studyText?JSON.stringify(selection.studyText):null,selection.textHash??null,generationRequest?JSON.stringify(generationRequest):null]);
    await db.query(`INSERT INTO library_spend_operations(id,operation_key,kind,explanation_id,state,reserved_micros,accounted_micros)
      VALUES($1,$2,'study_explanation',$1,'reserved',$3,$3)`,[id,`study:${key}`,amount]);
    return {created:true,row};
  });
}
export async function claimExplanation(database,id) {
  return database.transaction(async db=>{
    const settings=await first(db,'SELECT enabled FROM library_settings WHERE id=1 FOR UPDATE');if(!settings?.enabled)return false;
    const row=await first(db,"UPDATE study_explanations SET state='running' WHERE id=$1 AND state='queued' RETURNING id",[id]);if(!row)return false;
    await db.query("UPDATE library_spend_operations SET state='submitted',submitted_at=now() WHERE id=$1 AND state='reserved'",[id]);return true;
  });
}
export async function finishExplanation(database,id,{content=null,actualMicros=null,response=null,errorCode=null}) {
  // Settlement remains durable even if the later content write is interrupted.
  // Re-entering cannot issue another paid provider request.
  await finishReviewOperation(database,id,{actualMicros,providerID:response?.id??null,errorCode});
  await database.query(`UPDATE study_explanations SET state=$2,content=$3,error_code=$4 WHERE id=$1 AND state='running'`,
    [id,content?'ready':actualMicros===null?'unknown':'failed',content?JSON.stringify(content):null,errorCode]);
}
