import {randomUUID} from 'node:crypto';
import {translationIdentity} from './translation-identity.js';
import {currentTranslationSQL} from './revisions.js';

const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0]??null;
export function contentFitsSource(content,doc) {
  if(!Array.isArray(content.lines)||content.lines.length!==doc.structure.occurrences.length) return false;
  const rows=new Map(content.lines.map(l=>[l.sourceID,l]));
  return rows.size===content.lines.length && doc.structure.occurrences.every(o=>{
    const l=rows.get(o.sourceID);
    return l && typeof l.lyricText==='string' && l.lyricText.trim() && (l.speakerID??null)===(o.speakerID??null) && Boolean(l.startsTurn)===Boolean(o.startsTurn);
  }) && (content.sourceNotes??[]).every(n=>doc.structure.occurrences.some(o=>o.sourceID===n.sourceID && o.sourceText.includes(n.sourceQuote)));
}
export async function bindTranslation(db,doc,target,translationID,verification='exact_semantics') {
  const identity=translationIdentity(doc);
  await db.query(`INSERT INTO translation_document_bindings(document_id,target,translation_id,identity,verification)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(document_id,target) DO NOTHING`,[doc.id,target,translationID,identity,verification]);
  await db.query(`INSERT INTO translation_reuse_events(document_id,translation_id,identity,verification)
    VALUES($1,$2,$3,$4) ON CONFLICT(document_id,translation_id) DO NOTHING`,[doc.id,translationID,identity,verification]);
  return first(db,currentTranslationSQL,[doc.id,target]);
}
export async function reusableTranslation(db,doc,target) {
  const exact=await first(db,currentTranslationSQL,[doc.id,target]);
  if(exact)return exact;
  const identity=translationIdentity(doc);if(!identity)return null;
  // Backfilled and future documents share only when the entire meaning input agrees.
  const candidates=(await db.query(`SELECT t.id AS container_id,r.content FROM song_translations t
    JOIN translation_heads h ON h.translation_id=t.id JOIN translation_revisions r ON r.id=h.revision_id
    JOIN lyric_documents d ON d.id=t.document_id WHERE d.translation_identity=$1 AND t.target=$2
    ORDER BY t.created_at,t.id`,[identity,target])).rows;
  for(const candidate of candidates) if(contentFitsSource(candidate.content,doc))
    return bindTranslation(db,doc,target,candidate.container_id);
  return null;
}
export async function jobForDocument(db,row,documentID) {
  if(row.document_id===documentID)return {id:row.id,state:row.state,documentID,target:row.target,errorCode:row.error_code};
  await db.query(`INSERT INTO translation_job_aliases(id,job_id,document_id,target) VALUES($1,$2,$3,$4)
    ON CONFLICT(job_id,document_id) DO NOTHING`,[randomUUID(),row.id,documentID,row.target]);
  const alias=await first(db,'SELECT id FROM translation_job_aliases WHERE job_id=$1 AND document_id=$2',[row.id,documentID]);
  return {id:alias.id,state:row.state,documentID,target:row.target,errorCode:row.error_code};
}
