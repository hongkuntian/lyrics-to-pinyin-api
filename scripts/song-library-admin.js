#!/usr/bin/env node
// Explicit operator commands; this module is never exposed as an HTTP endpoint.
import {writeFile,mkdir,readFile,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import {database} from '../api/utils/song-library/database.js';
import {SongLibraryStore} from '../api/utils/song-library/store.js';
import {migrateLibrary} from './library-migrations.js';
import {repairTranslationReuse} from './repair-translation-reuse.js';
import {retryTranslation} from '../api/utils/song-library/translation-retry.js';
import {executeTranslationJob} from '../api/utils/song-library/translation-worker.js';
import {configureEmergencyBudget,disableUser,revokeSessions,revokeKey} from '../api/utils/app-auth/admin.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  id:{type:'string'},'token-file':{type:'string'},'daily-usd':{type:'string'},'monthly-usd':{type:'string'},enable:{type:'boolean'},
  'user-daily':{type:'string',default:'10'},'user-monthly':{type:'string',default:'50'},'max-daily':{type:'string',default:'5'},
  unlimited:{type:'boolean'},limited:{type:'boolean'},apply:{type:'boolean'},execute:{type:'boolean'},
  'expected-attempt':{type:'string'},'request-key':{type:'string'},actor:{type:'string'},reason:{type:'string'},
  'database-config-file':{type:'string'}
}});
const dollars=value=> {
  if(typeof value!=='string'||!/^\d+(\.\d{1,6})?$/.test(value))throw new Error('Specify an explicit nonnegative USD amount.');
  return Math.round(Number(value)*1_000_000);
};
let db;
try {
  if(values['database-config-file']) {
    const path=resolve(values['database-config-file']),metadata=await stat(path);
    if(!metadata.isFile()||(metadata.mode&0o077)!==0)throw new Error('Use an owner-only database configuration file.');
    const configuration=JSON.parse(await readFile(path,'utf8'));
    if(typeof configuration.LYRA_LIBRARY_DATABASE_URL!=='string')throw new Error('Missing database URL.');
    process.env.LYRA_LIBRARY_DATABASE_URL=configuration.LYRA_LIBRARY_DATABASE_URL;
  }
  db=database();const store=new SongLibraryStore(db);
  const command=positionals[0];
  if(command==='migrate') {
    await migrateLibrary(db);
    console.log('Song library schema ready. New installations default to generation and review disabled.');
  } else if(command==='repair-translations') {
    console.log(JSON.stringify(await repairTranslationReuse(db,{dryRun:!values.apply})));
  } else if(command==='retry-translation') {
    if(values.execute&&(!values.apply||!process.env.OPENAI_API_KEY))throw new Error('Execution requires --apply and configured provider credentials.');
    const receipt=await retryTranslation(db,{jobID:values.id,expectedAttempt:Number(values['expected-attempt']),requestKey:values['request-key'],actor:values.actor,reason:values.reason,dryRun:!values.apply});
    if(values.apply&&values.execute){await executeTranslationJob(store,receipt.jobID,{apiKey:process.env.OPENAI_API_KEY});receipt.job=await store.job(receipt.jobID);}
    console.log(JSON.stringify(receipt));
  } else if(command==='run-translation') {
    if(!values.id||!values.execute||!process.env.OPENAI_API_KEY)throw new Error('run-translation requires --id, --execute and configured provider credentials.');
    await executeTranslationJob(store,values.id,{apiKey:process.env.OPENAI_API_KEY});console.log(JSON.stringify(await store.job(values.id)));
  } else if(command==='configure') {
    const configuration={enabled:values.enable===true,dailyMicros:dollars(values['daily-usd']),monthlyMicros:dollars(values['monthly-usd']),
      userDaily:Number(values['user-daily']),userMonthly:Number(values['user-monthly'])};
    await store.configure(configuration);console.log(JSON.stringify(configuration));
  } else if(command==='disable') {
    await db.query('UPDATE library_settings SET enabled=false,review_enabled=false WHERE id=1');console.log('New paid work disabled. Saved content remains readable.');
  } else if(command==='configure-emergency') {
    const configuration={dailyMicros:dollars(values['daily-usd']),monthlyMicros:dollars(values['monthly-usd'])};
    await configureEmergencyBudget(db,configuration);console.log(JSON.stringify(configuration));
  } else if(command==='disable-user') {
    await disableUser(db,values.id);console.log(JSON.stringify({userID:values.id,disabled:true}));
  } else if(command==='revoke-sessions') {
    await revokeSessions(db,values.id);console.log(JSON.stringify({userID:values.id,sessionsRevoked:true}));
  } else if(command==='revoke-key') {
    await revokeKey(db,values.id);console.log('App key and its sessions revoked.');
  } else if(command==='configure-reviews') {
    const configuration={enabled:values.enable===true,dailyMicros:dollars(values['daily-usd']),monthlyMicros:dollars(values['monthly-usd']),maxDaily:Number(values['max-daily'])};
    await store.configureReviews(configuration);console.log(JSON.stringify(configuration));
  } else if(command==='configure-publication') {
    await db.query('UPDATE library_settings SET review_publication_enabled=$1 WHERE id=1',[values.enable===true]);
    console.log(JSON.stringify({publicationEnabled:values.enable===true}));
  } else if(command==='user') {
    if(!values.id||!values['token-file'])throw new Error('user requires --id and --token-file. Reusing the ID rotates its token without resetting quotas.');
    const path=resolve(values['token-file']);await mkdir(dirname(path),{recursive:true});
    const token=randomBytes(32).toString('base64url');
    await writeFile(path,token+'\n',{mode:0o600,flag:'wx'});
    await store.createUser(values.id,token);console.log(JSON.stringify({userID:values.id,tokenFile:path}));
  } else if(command==='user-access') {
    if(!values.id||(values.unlimited===true)===(values.limited===true))throw new Error('user-access requires --id and exactly one of --unlimited or --limited.');
    await store.configureUserAccess(values.id,{unlimitedGeneration:values.unlimited===true});
    console.log(JSON.stringify({userID:values.id,unlimitedGeneration:values.unlimited===true}));
  } else if(command==='usage') {
    console.log(JSON.stringify({usage:await store.usage(),budget:await store.budget()}));
  } else if(command==='reports') {
    const result=await db.query('SELECT id,document_id,translation_id,source_id,category,detail,status,created_at FROM correction_reports ORDER BY created_at DESC LIMIT 100');
    console.log(JSON.stringify(result.rows,null,2));
  } else throw new Error('Commands: migrate, repair-translations, retry-translation, run-translation, configure, configure-emergency, configure-reviews, configure-publication, disable, disable-user, revoke-sessions, revoke-key, user, user-access, usage, reports.');
} catch(error) {
  // Never print connection strings, tokens, provider bodies or driver diagnostics.
  console.error(error.code??'admin_command_failed');process.exitCode=1;
} finally {await db?.close();}
