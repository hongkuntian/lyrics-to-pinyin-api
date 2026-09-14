#!/usr/bin/env node
// Explicit operator commands; this module is never exposed as an HTTP endpoint.
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import {database} from '../api/utils/song-library/database.js';
import {SongLibraryStore} from '../api/utils/song-library/store.js';
import {migrateLibrary} from './library-migrations.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  id:{type:'string'},'token-file':{type:'string'},'daily-usd':{type:'string'},'monthly-usd':{type:'string'},enable:{type:'boolean'},
  'user-daily':{type:'string',default:'10'},'user-monthly':{type:'string',default:'50'},'max-daily':{type:'string',default:'5'}
}});
const dollars=value=> {
  if(typeof value!=='string'||!/^\d+(\.\d{1,6})?$/.test(value))throw new Error('Specify an explicit nonnegative USD amount.');
  return Math.round(Number(value)*1_000_000);
};
let db;
try {
  db=database();const store=new SongLibraryStore(db);
  const command=positionals[0];
  if(command==='migrate') {
    await migrateLibrary(db);
    console.log('Song library schema ready. New installations default to generation and review disabled.');
  } else if(command==='configure') {
    const configuration={enabled:values.enable===true,dailyMicros:dollars(values['daily-usd']),monthlyMicros:dollars(values['monthly-usd']),
      userDaily:Number(values['user-daily']),userMonthly:Number(values['user-monthly'])};
    await store.configure(configuration);console.log(JSON.stringify(configuration));
  } else if(command==='disable') {
    await db.query('UPDATE library_settings SET enabled=false,review_enabled=false WHERE id=1');console.log('New paid work disabled. Saved content remains readable.');
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
  } else if(command==='usage') {
    console.log(JSON.stringify({usage:await store.usage(),budget:await store.budget()}));
  } else if(command==='reports') {
    const result=await db.query('SELECT id,document_id,translation_id,source_id,category,detail,status,created_at FROM correction_reports ORDER BY created_at DESC LIMIT 100');
    console.log(JSON.stringify(result.rows,null,2));
  } else throw new Error('Commands: migrate, configure, configure-reviews, configure-publication, disable, user, usage, reports.');
} catch(error) {
  // Never print connection strings, tokens, provider bodies or driver diagnostics.
  console.error(error.code??'admin_command_failed');process.exitCode=1;
} finally {await db?.close();}
