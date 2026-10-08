// Read-only, nonspending export for local content review. No user identities,
// credentials, reports or provider billing payloads are included.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {database} from '../api/utils/song-library/database.js';
export async function contentSnapshot(db,{songs=20,studies=40}={}) {
 if(![songs,studies].every(n=>Number.isSafeInteger(n)&&n>0&&n<=50))throw new Error('invalid_snapshot_limits');
 return db.transaction(async tx=> {
  await tx.query('SET TRANSACTION READ ONLY');
  const counts=(await tx.query('SELECT state,count(*)::int FROM study_explanations GROUP BY state')).rows;
  const rows=(await tx.query(`SELECT t.id,t.target,t.recipe,t.created_at,r.content,d.id AS document_id,d.source_hash,d.response,d.structure
   FROM song_translations t JOIN translation_heads h ON h.translation_id=t.id JOIN translation_revisions r ON r.id=h.revision_id
   JOIN lyric_documents d ON d.id=t.document_id ORDER BY t.created_at DESC LIMIT $1`,[songs])).rows;
  const study=(await tx.query(`SELECT id,document_id,revision_id,source_id,lower_offset,upper_offset,recipe,content,created_at,
   contract_version,explanation_language,study_text,selection_text_hash,generation_request
   FROM study_explanations WHERE state='ready' ORDER BY created_at DESC LIMIT $1`,[studies])).rows;
  return {at:new Date().toISOString(),counts,rows,study};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const {values}=parseArgs({options:{'database-config-file':{type:'string'},output:{type:'string'}}});let db;
 try {
  if(!values.output||!values['database-config-file'])throw new Error('explicit_paths_required');
  const file=values['database-config-file'],metadata=await stat(file);
  if(!metadata.isFile()||(metadata.mode&0o077)!==0)throw new Error('owner_only_configuration_required');
  const configuration=JSON.parse(await readFile(file,'utf8'));
  db=database({LYRA_LIBRARY_DATABASE_URL:configuration.LYRA_LIBRARY_DATABASE_URL});
  const snapshot=await contentSnapshot(db);
  await writeFile(values.output,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({songs:snapshot.rows.length,studies:snapshot.study.length,readOnly:true}));
 } catch {console.error('content_snapshot_failed');process.exitCode=1;}finally{await db?.close();}
}
