import {normalizeLyricAnnotations,LYRIC_NORMALIZATION_VERSION,LYRIC_SELECTION_REVISION} from '../api/utils/lyric-annotations.js';
import {getProcessor} from '../api/processors/index.js';
import {getDefaultRomanizationSystem} from '../api/utils/language-detection.js';
import {digest} from '../api/utils/song-library/store.js';

// Local transformation only: never fetch providers or regenerate translations.
// Old IDs remain as explicit retirement records for accounting/report foreign keys.
export async function migrateSourceContent(database) {
  return database.transaction(async db=> {
    await db.query("SET LOCAL statement_timeout='120s'");
    await db.query("SET LOCAL lock_timeout='120s'");
    await db.query('SELECT pg_advisory_xact_lock(71309,2)');
    await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
    const {rows}=await db.query(`SELECT * FROM lyric_documents WHERE superseded_by IS NULL
      AND coalesce(structure->>'version','')<>$1 ORDER BY id FOR UPDATE`,[LYRIC_NORMALIZATION_VERSION]);
    let migrated=0;
    for(const old of rows) {
      if(!Array.isArray(old.response.lines)||!old.response.lines.length) continue;
      const busy=await db.query(`SELECT 1 FROM translation_jobs WHERE document_id=$1 AND state IN ('queued','running')
        UNION ALL SELECT 1 FROM study_explanations WHERE document_id=$1 AND state IN ('queued','running') LIMIT 1`,[old.id]);
      if(busy.rows.length) throw new Error('source_migration_active_generation');
      const response=old.response,structure=old.structure;
      const timestamps=new Map((structure.occurrences??[]).map((o,i)=>[o.sourceIndex,response.lines[i]?.timestamp]));
      const raw=structure.sourceRows?.length?structure.sourceRows.map((row,i)=>({...row,timestamp:timestamps.has(i)?timestamps.get(i):row.timestamp}))
        :response.lines.map(row=>({text:row.original,timestamp:row.timestamp}));
      const clean=normalizeLyricAnnotations({source:response.metadata.source,lines:raw},
        {title:response.song.title.original,artist:response.song.artist.original,
          performers:(structure.speakers??[]).map(s=>({name:s.displayName,aliases:[s.sourceLabel]}))});
      if(!clean.lines.length) throw new Error('source_migration_empty');
      const prior=new Map(response.lines.map(row=>[row.original,row.romanized]));
      const script=response.song.language,system=response.song.romanization_system??getDefaultRomanizationSystem(script);
      const processor=script==='en'?null:getProcessor(script);
      const lines=await Promise.all(clean.lines.map(async row=>({original:row.text,
        romanized:prior.get(row.text)??(processor?(await processor.romanize(row.text,system,{})).romanized:row.text),timestamp:row.timestamp??null})));
      const nextResponse={...response,lines,metadata:{...response.metadata,lyric_structure:clean.lyricStructure,selection_revision:LYRIC_SELECTION_REVISION}};
      delete nextResponse.song_details;delete nextResponse.provider_translation;
      const sourceHash=digest({language:script,lines,structure:clean.lyricStructure});
      const id=digest({recordingKey:old.recording_key,sourceHash});
      await db.query(`INSERT INTO lyric_documents(id,recording_key,source_hash,selection_revision,response,structure)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[id,old.recording_key,sourceHash,LYRIC_SELECTION_REVISION,JSON.stringify(nextResponse),JSON.stringify(clean.lyricStructure)]);
      const details={catalog_id:response.metadata.recording_match?.catalog_id??null,source_id:String(response.song.id??''),source:response.metadata.source,credits:clean.credits};
      await db.query(`INSERT INTO lyric_document_extras(document_id,song_details,provider_translation) VALUES($1,$2,$3)
        ON CONFLICT(document_id) DO NOTHING`,[id,JSON.stringify(details),JSON.stringify(clean.providerTranslation??null)]);
      await db.query(`INSERT INTO lyric_requests(request_key,selection_revision,document_id,checked_at)
        SELECT request_key,$2,$3,'1970-01-01'::timestamptz FROM lyric_requests WHERE document_id=$1
        ON CONFLICT(request_key,selection_revision) DO NOTHING`,[old.id,LYRIC_SELECTION_REVISION,id]);
      await db.query('UPDATE lyric_requests SET document_id=$2 WHERE document_id=$1',[old.id,id]);
      const retirement=JSON.stringify({retired:true,replacement_id:id});
      await db.query('UPDATE lyric_documents SET superseded_by=$2,response=$3,structure=$3 WHERE id=$1',[old.id,id,retirement]);
      migrated++;
    }
    return {migrated};
  });
}
