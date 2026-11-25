#!/usr/bin/env node
// Offline operator commands. No listener-controlled operation reaches this file.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {database} from '../api/utils/song-library/database.js';
import {environmentLanguagePolicy} from '../api/utils/song-library/languages.js';
import {poolInventory,acquireEdition,stagePlan,priceStage,executeStage,finishTranslations,finishEdition} from '../api/utils/prepared-editions/preparation.js';
import {PreparedEditionStore} from '../api/utils/prepared-editions/store.js';
import {validateBundle} from '../api/utils/prepared-editions/core.js';
import {migrateLibrary,migrationNames} from './library-migrations.js';
const {values:v,positionals:[command]}=parseArgs({allowPositionals:true,options:Object.fromEntries(['input','output','spec','stage','translations','native-rows','pilot-usage','review','job','database-config-file','edition-id','generation','expected-head','expected-generation','migration-plan'].map(k=>[k,{type:'string'}]))});
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const output=async value=>{if(v.output){await mkdir(dirname(v.output),{recursive:true});await writeFile(v.output,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});}else console.log(JSON.stringify(value,null,2));};
let db;
async function openDB(){
 if(!v['database-config-file'])throw new Error('owner_database_config_required');
 const path=v['database-config-file'],metadata=await stat(path);if((metadata.mode&0o077)!==0)throw new Error('owner_only_config_required');
 const config=await read(path);if(typeof config.LYRICA_LIBRARY_DATABASE_URL!=='string')throw new Error('database_config_required');
 db=database({LYRICA_LIBRARY_DATABASE_URL:config.LYRICA_LIBRARY_DATABASE_URL});return db;
}
try{
 if(command==='inventory')await output(poolInventory());
 else if(command==='acquire'){
  // Import the ordinary recording loader only for this explicit network command.
  const {lyricLoader}=await import('../api/song-library.js'),{SELECTION_REVISION}=await import('../api/music-romanize.js');
  await output(await acquireEdition(await read(v.spec),{loadLyrics:lyricLoader(),selectionRevision:SELECTION_REVISION}));
 }else if(command==='plan'){
  const acquired=await read(v.input),translations=v.translations?await read(v.translations):null,rows=v['native-rows']?await read(v['native-rows']):null;
  await output(stagePlan(acquired,{stage:v.stage,translations,rows,policy:environmentLanguagePolicy()}));
 }else if(command==='price')await output(priceStage(await read(v.input),await read(v['pilot-usage'])));
 else if(command==='run'){
  const acquired=await read(v.spec),stage=await read(v.input),translations=v.translations?await read(v.translations):null;
  const checkpoint=await executeStage(acquired,stage,{path:v.job,review:await read(v.review),database:await openDB(),apiKey:process.env.OPENAI_API_KEY,translations});
  await output({planID:checkpoint.planID,state:checkpoint.state,chargedMicros:checkpoint.chargedMicros,blockedCode:checkpoint.blockedCode??null});
 }else if(command==='finish-translations')await output(finishTranslations(await read(v.spec),await read(v.input),await read(v.job)));
 else if(command==='finish-edition')await output(finishEdition(await read(v.spec),await read(v.input),await read(v.job),await read(v.translations)));
 else if(command==='validate'){
  const b=validateBundle(await read(v.input));await output({editionID:b.editionID,artifacts:b.artifacts.length,complete:true});
 }else if(command==='publish'){
  const b=validateBundle(await read(v.input)),store=new PreparedEditionStore(await openDB());
  await output(await store.publish(b,{expectedGeneration:v['expected-generation']??null,expectedHead:v['expected-head']??null}));
 }else if(command==='withdraw')await output(await new PreparedEditionStore(await openDB()).withdraw(v['edition-id'],v.generation));
 else if(command==='migration-plan'){
  const active=await openDB(),receipts=(await active.query('SELECT name,sha256 FROM library_schema_migrations')).rows,map=new Map(receipts.map(r=>[r.name,r.sha256])),pending=[];
  for(const name of migrationNames){const hash=createHash('sha256').update(await readFile(new URL('../db/'+name,import.meta.url))).digest('hex');if(map.has(name)&&map.get(name)!==hash)throw new Error('migration_changed');if(!map.has(name))pending.push({name,sha256:hash});}
  await output({pending});
 }else if(command==='migrate')await output({applied:await migrateLibrary(await openDB(),{expectedPending:(await read(v['migration-plan'])).pending})});
 else if(command==='status'){
  const active=await openDB();
  await output({migration:(await active.query('SELECT name,sha256 FROM library_schema_migrations ORDER BY applied_at DESC LIMIT 1')).rows,
   publications:(await active.query('SELECT edition_id,generation::text,state FROM prepared_editions ORDER BY generation DESC')).rows,
   generationRuns:(await active.query('SELECT plan_id,state,ceiling_micros::text,accounted_micros::text FROM prepared_generation_runs')).rows});
 }else throw new Error('unknown_command');
}catch(error){
 const code=error.code??error.message;console.error(/^[a-z_]{1,80}$/.test(code)?code:'prepared_command_failed');process.exitCode=1;
}finally{await db?.close();}
