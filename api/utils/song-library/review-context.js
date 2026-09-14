import {randomUUID} from 'node:crypto';
import {LibraryError,digest} from './store.js';
import {batchInput} from './batch-provider.js';
export const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0]??null;
export const within=db=>({transaction:fn=>fn(db)});
export async function reviewContext(db,revisionID) {
  const r=await first(db,`SELECT d.id,d.source_hash,d.response,d.structure,r.content,r.source_hash AS revision_source_hash,t.target
    FROM translation_revisions r JOIN song_translations t ON t.id=r.translation_id JOIN lyric_documents d ON d.id=t.document_id WHERE r.id=$1`,[revisionID]);
  if(!r||r.target!=='en'||r.source_hash!==r.revision_source_hash)throw new LibraryError('review_context_unavailable');
  return {doc:{id:r.id,sourceHash:r.source_hash,response:r.response,structure:r.structure},content:r.content};
}
export async function saveReviewBatch(db,items,stage,policy) {
  items.sort((a,b)=>a.operation_id.localeCompare(b.operation_id));
  const id=randomUUID(),hash=digest(batchInput(items));
  const batch=await first(db,"INSERT INTO correction_batches(id,state,request_hash,stage,policy_version) VALUES($1,'prepared',$2,$3,$4) RETURNING *",[id,hash,stage,policy]);
  for(const i of items)await db.query(`INSERT INTO correction_batch_items(operation_id,batch_id,review_id,revision_id,request_body,report_snapshot,stage,comparison_context)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[i.operation_id,id,i.review_id,i.revision_id,JSON.stringify(i.request_body),JSON.stringify(i.report_snapshot??[]),stage,
    i.comparison_context?JSON.stringify(i.comparison_context):null]);
  return batch;
}
