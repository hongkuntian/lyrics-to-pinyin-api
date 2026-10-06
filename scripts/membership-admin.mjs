#!/usr/bin/env node
// Local operator only. Secrets are read/written in owner-only files, never printed.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import pg from 'pg';
import {migrateLibrary} from './library-migrations.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  'database-config-file':{type:'string'},'account-config-file':{type:'string'},set:{type:'string',multiple:true}
}});
const booleans=['public_access_enabled','purchases_enabled','live_enabled','widgets_enabled','carplay_enabled'];
const limits=['starter_daily_limit','preview_daily_limit','relay_monthly_limit'];
let client;
try {
  const command=positionals[0];
  if(!['status','configure','provision'].includes(command)||positionals.length!==1||!values['database-config-file'])throw new Error('invalid_arguments');
  const path=resolve(values['database-config-file']),metadata=await stat(path);
  if(!metadata.isFile()||(metadata.mode&0o077)!==0)throw new Error('owner_only_file_required');
  const config=JSON.parse(await readFile(path,'utf8'));
  const connectionString=config.LYRA_LIBRARY_DATABASE_URL_UNPOOLED??config.LYRA_LIBRARY_DATABASE_URL;
  if(!connectionString)throw new Error('database_configuration_required');
  client=new pg.Client({connectionString,connectionTimeoutMillis:5000,statement_timeout:10000});
  await client.connect();
  if(command==='provision') {
    if(!values['account-config-file'])throw new Error('account_config_file_required');
    if((await client.query("SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1'")).rowCount)throw new Error('account_role_exists_use_retained_credentials');
    const output=resolve(values['account-config-file']),password=randomBytes(36).toString('base64url');
    const url=new URL(config.LYRA_LIBRARY_DATABASE_URL);url.username='lyra_account_v1';url.password=password;
    await mkdir(dirname(output),{recursive:true,mode:0o700});
    await writeFile(output,JSON.stringify({LYRA_ACCOUNT_DATABASE_URL:url.toString(),LYRA_ACCOUNT_ENCRYPTION_KEY:randomBytes(32).toString('base64')})+'\n',{mode:0o600,flag:'wx'});
    await client.query('BEGIN');
    try {
      await client.query(`CREATE ROLE lyra_account_v1 LOGIN PASSWORD ${client.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 8`);
      await client.query("ALTER ROLE lyra_account_v1 SET statement_timeout='10s'");
      await client.query("ALTER ROLE lyra_account_v1 SET idle_in_transaction_session_timeout='10s'");
      await migrateLibrary({transaction:fn=>fn(client)});
      // Also grant if a previous migration ran before this login existed.
      const sql=await readFile(new URL('../db/025-memberships.sql',import.meta.url),'utf8');
      await client.query(sql.slice(sql.indexOf('DO $$ BEGIN'),sql.lastIndexOf('COMMIT;')));
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    console.log('Account role provisioned. Retain the private configuration file; add its two values as production secrets.');
  } else if(command==='configure') {
    if(!values.set?.length)throw new Error('explicit_settings_required');
    const assignments=[],parameters=[];
    for(const setting of values.set) {
      const [key,value,...extra]=setting.split('=');
      if(extra.length||(!booleans.includes(key)&&!limits.includes(key)))throw new Error('invalid_setting');
      if(booleans.includes(key)&&!['true','false'].includes(value))throw new Error('invalid_setting');
      if(limits.includes(key)&&(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>2_000_000_000))throw new Error('invalid_setting');
      parameters.push(booleans.includes(key)?value==='true':Number(value));assignments.push(`${key}=$${parameters.length}`);
    }
    await client.query(`UPDATE membership_settings SET ${assignments.join(',')} WHERE id=1`,parameters);
  }
  console.log(JSON.stringify((await client.query('SELECT * FROM membership_settings WHERE id=1')).rows[0]));
} catch(error) {
  const safe=['invalid_arguments','owner_only_file_required','database_configuration_required','account_config_file_required',
    'account_role_exists_use_retained_credentials','explicit_settings_required','invalid_setting'];
  console.error(safe.includes(error.message)?error.message:'membership_operator_failed');process.exitCode=1;
} finally { await client?.end(); }
