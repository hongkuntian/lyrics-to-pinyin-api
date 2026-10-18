import {randomUUID} from 'node:crypto';
import {translationIdentity} from './translation-identity.js';
import {currentTranslationSQL} from './revisions.js';
import {digest} from './store.js';
import {independentModelContext,hasIndependentContext} from './model-context.js';
import {sourceCapsule,canonicalJSON,independentProvider} from './spotify-recording.js';
import {requestBody,translationRecipe,strictJSON} from './translation.js';

const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0]??null;
const modelRequestIdentity=body=>canonicalJSON({...body,input:body.input.map(message=>({...message,content:strictJSON(message.content)}))});
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
  const bridged=await reusableIndependentTranslation(db,doc,target);
  if(bridged)return bridged;
  const proof=doc.response.metadata?.catalog_resolution;
  if(doc.canonicalRecordingID && proof?.catalog_items?.length) {
    const keys=[...new Set(proof.catalog_items.map(item=>digest({catalogID:item.catalog_id,storefront:item.storefront})))];
    // Bridge historical localized names only within verified catalog bindings.
    // Both meaning inputs still need byte-exact ordered words and speaker turns.
    const legacy=(await db.query(`SELECT t.id AS container_id,r.content,d.response,d.structure,
      a.response AS archived_response,a.structure AS archived_structure,d.superseded_by
      FROM song_translations t JOIN translation_heads h ON h.translation_id=t.id
      JOIN translation_revisions r ON r.id=h.revision_id JOIN lyric_documents d ON d.id=t.document_id
      LEFT JOIN lyric_source_archives a ON a.document_id=d.id
      WHERE t.target=$1 AND (d.canonical_recording_id=$2 OR d.recording_key=ANY($3::text[]))
      ORDER BY t.created_at,t.id LIMIT 50`,[target,doc.canonicalRecordingID,keys])).rows;
    const meaning=translationIdentity(doc,{omitContext:true});
    for(const candidate of legacy) {
      const old=candidate.superseded_by ? {response:candidate.archived_response,structure:candidate.archived_structure}:candidate;
      if(translationIdentity(old,{omitContext:true})===meaning && contentFitsSource(candidate.content,doc))
        return bindTranslation(db,doc,target,candidate.container_id,'verified_catalog_semantics');
    }
  }
  return null;
}

async function reusableIndependentTranslation(db,doc,target) {
  if(doc.selectedSourceCapsule||doc.selectedSource)return null;
  // One side must carry a verified independent source capsule. A matching
  // title, ISRC or legacy context hash never establishes this bridge alone.
  const spotify=hasIndependentContext(doc);
  let source,body;
  try {
    if(spotify)independentModelContext(doc);
    source=sourceCapsule(doc.response);body=requestBody(doc,target);
  } catch {return null;}
  const labels={lrclib:['lrclib','LRCAPI'],netease:['netease','NeteaseAPI'],kugou:['kugou','KugouAPI'],qq:['qq','QQMusicAPI']}[source.provider];
  const candidates=(await db.query(`SELECT t.id AS container_id,r.content,r.recipe,j.generation_request,
    d.response,d.structure,d.source_hash,d.source_capsule,d.model_context,d.recording_key
    FROM song_translations t JOIN translation_heads h ON h.translation_id=t.id
    JOIN translation_revisions r ON r.id=h.revision_id JOIN lyric_documents d ON d.id=t.document_id
    LEFT JOIN translation_jobs j ON j.id=t.id
    WHERE t.target=$1 AND r.recipe=$2 AND d.superseded_by IS NULL AND d.selected_source IS NULL
      AND (d.source_capsule IS NULL)=$6
      AND ((d.source_capsule->>'provider'=$3 AND d.source_capsule->>'itemID'=$4)
        OR (d.source_capsule IS NULL AND d.response->'metadata'->>'source'=ANY($5::text[])
          AND d.response->'song'->>'id'=$4))
    ORDER BY t.created_at,t.id LIMIT 50`,[target,translationRecipe(target),source.provider,source.itemID,labels,spotify])).rows;
  for(const candidate of candidates) {
    const other={response:candidate.response,structure:candidate.structure,sourceHash:candidate.source_hash,
      recordingKey:candidate.recording_key,...(candidate.source_capsule?{sourceCapsule:candidate.source_capsule,modelContext:candidate.model_context}:{})};
    try {
      if(hasIndependentContext(other)===spotify)continue;
      if(!spotify)independentModelContext(other);
      const otherSource=sourceCapsule(other.response);
      if(independentProvider(otherSource.provider)!==source.provider||otherSource.itemID!==source.itemID)continue;
      // Compare the actual complete input, including source language, every
      // repeated occurrence, speaker semantics, context and current recipe.
      // Different album context or an unknown legacy recipe deliberately misses.
      const expected=requestBody(other,target);
      // PostgreSQL JSONB reorders structure keys. Canonicalize the embedded
      // JSON too, while preserving every source string and ordered array.
      if(modelRequestIdentity(expected)!==modelRequestIdentity(body)
        ||candidate.generation_request&&modelRequestIdentity(candidate.generation_request)!==modelRequestIdentity(expected)
        ||!contentFitsSource(candidate.content,doc))continue;
      return bindTranslation(db,doc,target,candidate.container_id,'verified_independent_model_input');
    } catch { /* Missing/invalid provenance leaves the ordinary generation path. */ }
  }
  return null;
}
export async function jobForDocument(db,row,documentID) {
  if(row.document_id===documentID)return {id:row.id,state:row.state,documentID,target:row.target,errorCode:row.error_code};
  await db.query(`INSERT INTO translation_job_aliases(id,job_id,document_id,target) VALUES($1,$2,$3,$4)
    ON CONFLICT(job_id,document_id) DO NOTHING`,[randomUUID(),row.id,documentID,row.target]);
  const alias=await first(db,'SELECT id FROM translation_job_aliases WHERE job_id=$1 AND document_id=$2',[row.id,documentID]);
  return {id:alias.id,state:row.state,documentID,target:row.target,errorCode:row.error_code};
}
