// Provision only the two owner operations. Never print database credentials.
import {writeFile,mkdir,access} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {migrateLibrary} from './library-migrations.js';
let client;
try {
  const output=process.argv[2],subject=process.env.LYRA_DASHBOARD_OWNER_SUBJECT;
  if(!output || !subject || subject.length>100 || !process.env.LYRA_LIBRARY_DATABASE_URL) throw new Error('configuration_required');
  const path=resolve(output);
  if(await access(path).then(()=>true,()=>false)) throw new Error('output_already_exists');
  client=new pg.Client({connectionString:process.env.LYRA_LIBRARY_DATABASE_URL,statement_timeout:10000});await client.connect();
  if((await client.query("SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_operator'")).rowCount) throw new Error('operator_already_exists_use_retained_credentials');
  await migrateLibrary({transaction:async fn=>{await client.query('BEGIN');try{const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}}});
  const password=randomBytes(36).toString('base64url'),url=new URL(process.env.LYRA_LIBRARY_DATABASE_URL);
  url.username='lyra_dashboard_operator';url.password=password;url.searchParams.set('sslmode','verify-full');
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,`LYRA_DASHBOARD_OPERATOR_DATABASE_URL=${url.toString()}\n`,{flag:'wx',mode:0o600});
  await client.query('BEGIN');
  try {
    await client.query(`CREATE ROLE lyra_dashboard_operator LOGIN PASSWORD ${client.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query('GRANT USAGE ON SCHEMA lyra_dashboard_control TO lyra_dashboard_operator');
    await client.query('GRANT EXECUTE ON FUNCTION lyra_dashboard_control.set_control(text,uuid,bigint,text,boolean),lyra_dashboard_control.rollback_translation(text,uuid,text,text,uuid,uuid,text) TO lyra_dashboard_operator');
    await client.query("ALTER ROLE lyra_dashboard_operator SET statement_timeout='8s'");
    await client.query("ALTER ROLE lyra_dashboard_operator SET search_path=pg_catalog");
    await client.query('INSERT INTO lyra_dashboard_control.operators(subject) VALUES($1)',[subject]);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
  console.log('Dashboard operator provisioned. Credentials saved to the specified private file.');
} catch(error) {
  console.error(['configuration_required','output_already_exists','operator_already_exists_use_retained_credentials'].includes(error.message)?error.message:'dashboard_operator_provision_failed');process.exitCode=1;
} finally {await client?.end();}
