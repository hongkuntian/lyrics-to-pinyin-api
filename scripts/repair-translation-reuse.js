import {translationIdentity,legacySourceCandidates} from '../api/utils/song-library/translation-identity.js';
import {bindTranslation,contentFitsSource} from '../api/utils/song-library/translation-reuse.js';

const document=row=>({id:row.id,recordingKey:row.recording_key,sourceHash:row.source_hash,response:row.response,structure:row.structure});
export async function repairTranslationReuse(database,{dryRun=false}={}) {
  return database.transaction(async db=>{
    if(!dryRun){await db.query('SELECT pg_advisory_xact_lock(71309,3)');await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');}
    const docs=(await db.query('SELECT * FROM lyric_documents ORDER BY id')).rows;
    const byID=new Map(docs.map(d=>[d.id,d]));
    let indexed=0,recovered=0;const deferred=[];
    for(const row of docs) if(!row.superseded_by){
      const identity=translationIdentity(document(row));if(!identity)continue;indexed++;
      if(!dryRun)await db.query('UPDATE lyric_documents SET translation_identity=$2 WHERE id=$1 AND translation_identity IS DISTINCT FROM $2',[row.id,identity]);
    }
    const retired=(await db.query(`SELECT t.id AS translation_id,t.target,t.document_id,r.content FROM song_translations t
      JOIN lyric_documents d ON d.id=t.document_id JOIN translation_heads h ON h.translation_id=t.id
      JOIN translation_revisions r ON r.id=h.revision_id WHERE d.superseded_by IS NOT NULL ORDER BY t.id`)).rows;
    for(const item of retired){
      const old=byID.get(item.document_id);let replacement=byID.get(old.superseded_by);const visited=new Set([old.id]);
      while(replacement?.superseded_by&&replacement.recording_key===old.recording_key&&!visited.has(replacement.id)){
        visited.add(replacement.id);replacement=byID.get(replacement.superseded_by);
      }
      if(!replacement||replacement.superseded_by||old.recording_key!==replacement.recording_key){deferred.push({translationID:item.translation_id,reason:'recording_or_replacement_changed'});continue;}
      const next=document(replacement);
      if(!translationIdentity(next)){deferred.push({translationID:item.translation_id,reason:'source_context_unavailable'});continue;}
      const archived=(await db.query('SELECT source_hash,response,structure FROM lyric_source_archives WHERE document_id=$1',[old.id])).rows[0];
      // Immutable archives retain the original verified hash. Rehashing JSONB
      // would reorder object fields and destroy an otherwise exact legacy proof.
      const candidates=archived?[{source:{language:archived.response.song.language,lines:archived.response.lines,structure:archived.structure},hash:archived.source_hash}]:legacySourceCandidates(next);
      const proof=candidates.find(c=>c.hash===old.source_hash);
      if(!proof || !contentFitsSource(item.content,next)) {deferred.push({translationID:item.translation_id,reason:'source_equivalence_unproven'});continue;}
      // An archive must have the same ordered words/turns, not merely a matching historical hash.
      const originalSong=archived?.response.song?.title?.original&&archived.response.song?.artist?.original?archived.response.song:next.response.song;
      const oldSemantic={...next,response:{...next.response,song:{...originalSong,language:proof.source.language}},structure:proof.source.structure};
      if(translationIdentity(oldSemantic)!==translationIdentity(next)){deferred.push({translationID:item.translation_id,reason:'source_meaning_changed'});continue;}
      const bound=(await db.query('SELECT translation_id FROM translation_document_bindings WHERE document_id=$1 AND target=$2',[next.id,item.target])).rows[0];
      if(bound&&bound.translation_id!==item.translation_id){deferred.push({translationID:item.translation_id,reason:'replacement_already_has_translation'});continue;}
      if(!dryRun){
        await db.query(`INSERT INTO lyric_source_archives(document_id,source_hash,response,structure,verification)
          VALUES($1,$2,$3,$4,'reconstructed_sha256') ON CONFLICT(document_id) DO NOTHING`,[old.id,old.source_hash,
          JSON.stringify({song:{language:proof.source.language},lines:proof.source.lines}),JSON.stringify(proof.source.structure)]);
        await db.query('UPDATE lyric_documents SET translation_identity=$2 WHERE id=$1',[old.id,translationIdentity(next)]);
        await bindTranslation(db,next,item.target,item.translation_id,'legacy_source_sha256');
      }
      recovered++;
    }
    if(!dryRun){
      // Preserve existing completed translations; choose a single job for future aliases.
      await db.query(`INSERT INTO translation_generation_keys(identity,target,job_id)
        SELECT DISTINCT ON(d.translation_identity,j.target) d.translation_identity,j.target,j.id
        FROM translation_jobs j JOIN lyric_documents d ON d.id=j.document_id WHERE d.translation_identity IS NOT NULL
        ORDER BY d.translation_identity,j.target,CASE j.state WHEN 'ready' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'unknown' THEN 3 ELSE 4 END,j.created_at,j.id
        ON CONFLICT(identity,target) DO NOTHING`);
    }
    return {dryRun,indexed,recovered,deferred};
  });
}
