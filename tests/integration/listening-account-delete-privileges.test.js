import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {migrateLibrary,migrationNames} from '../../scripts/library-migrations.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

async function make(t,{roles=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 const h={query:async(text,args=[])=>args.length?db.query(text,args):(await db.exec(text)).at(-1)};
 h.createRoles=async()=>{
  for(const role of [account,runtime]){
   assert.equal((await one(h,'SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname=$1',[role])).n,0);
   await h.query('CREATE ROLE '+role+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  }
 };
 h.tx=(role,fn,{trace=[],beforeSQL,afterSQL}={})=>db.transaction(async raw=>{
  if(role)await raw.exec('SET LOCAL ROLE '+role);
  trace.push({event:'BEGIN'});
  const tx={query:async(text,args=[])=>{
   const who=(await raw.query('SELECT current_user AS role,session_user AS owner')).rows[0];
   assert.equal(who.role,role??who.owner);
   trace.push({text,currentUser:who.role,sessionUser:who.owner});
   if(beforeSQL)await beforeSQL(text,raw,args);
   const result=args.length?await raw.query(text,args):(await raw.exec(text)).at(-1);
   if(afterSQL)await afterSQL(text,raw,args,result);return result;
  }};
  return fn(tx);
 }).then(value=>{trace.push({event:'COMMIT'});return value;},error=>{trace.push({event:'ROLLBACK'});throw error;});
 h.adapter=(role,options={})=>({query:(text,args=[])=>h.tx(role,tx=>tx.query(text,args),options),transaction:fn=>h.tx(role,fn,options)});
 h.migrator=({failReceipt}={})=>({transaction:fn=>h.tx(null,tx=>fn({query:async(text,args=[])=>{
  if(failReceipt&&text.startsWith('INSERT INTO library_schema_migrations')&&args[0]===failReceipt)throw Object.assign(new Error('injected_036_receipt_failure'),{code:'injected_036_receipt_failure'});
  return tx.query(text,args);
 }}))});
 h.ownerInjection=async(raw,fn)=>{
  await raw.exec('RESET ROLE');try{await fn();}finally{await raw.exec('SET LOCAL ROLE '+account);}
  assert.equal((await one(raw,'SELECT current_user AS role')).role,account);
 };
 if(roles)await h.createRoles();return h;
}

const correction='036-account-data-privacy.sql';
const account='lyra_account_v1',runtime='lyra_runtime_v1';
const policy={audience:'delete-privilege-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const bundleID=policy.bundles[0];
const sha=value=>createHash('sha256').update(value).digest('hex');
const sqlFile=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const body=text=>{
 const outer=/^((?:[ \t]*(?:--[^\n]*)?\r?\n)*)BEGIN;[ \t]*\r?\n/.exec(text);
 assert.ok(outer,'fixture migration must have one leading outer BEGIN');
 assert.match(text,/COMMIT;\s*$/);
 return outer[1]+text.slice(outer[0].length).replace(/COMMIT;\s*$/,'');
};
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0];
const permission=error=>error.code==='42501'&&error.message.includes('listening_rate_windows');
const malformed=error=>error.code==='23514'&&error.message.includes('listening_account_delete_catalog_mismatch');
const legacyNames=()=>migrationNames.filter(name=>name!==correction);
async function selectedMigrate(h,names,options={}){
 const saved=[...migrationNames];migrationNames.splice(0,migrationNames.length,...names);
 try{return await migrateLibrary(h.migrator(options));}
 finally{migrationNames.splice(0,migrationNames.length,...saved);}
}
async function historicalAccountGrants(h){
 if(!(await one(h,'SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS present',[account])).present)return;
 await h.query('GRANT SELECT(owner_id,data),UPDATE(data,updated_at),DELETE ON public.listening_rooms TO '+account);
 await h.query('GRANT DELETE ON public.listening_rate_windows TO '+account);
}
async function retainedSchema(h){
 await h.query(`CREATE TABLE listening_rooms (
 id uuid PRIMARY KEY,
 environment text NOT NULL,
 owner_id text NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('active','ended')),
 invite_hash text NOT NULL UNIQUE,
 code_hash text NOT NULL,
 share_hash text UNIQUE,
 data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX listening_one_hosted_room ON listening_rooms(owner_id,environment) WHERE status='active';
CREATE UNIQUE INDEX listening_active_code ON listening_rooms(code_hash,environment) WHERE status='active';
CREATE INDEX listening_members ON listening_rooms USING gin(data jsonb_path_ops);
CREATE TABLE listening_commands (
 room_id uuid NOT NULL REFERENCES listening_rooms(id) ON DELETE CASCADE,
 command_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 accepted_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,command_id)
);
CREATE TABLE listening_outbox (
 id text PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES listening_rooms(id) ON DELETE CASCADE,
 ordinal integer NOT NULL,
 due_at_ms bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published')),
 receipt text,
 UNIQUE(room_id,ordinal)
);
CREATE INDEX listening_outbox_pending ON listening_outbox(room_id) WHERE state='pending';
CREATE TABLE listening_rate_windows (
 user_id text NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 bucket text NOT NULL,
 window_at timestamptz NOT NULL,
 count integer NOT NULL,
 PRIMARY KEY(user_id,bucket)
);`);
 await historicalAccountGrants(h);
 const name='029-listening-sessions.sql';
 await h.query('INSERT INTO public.library_schema_migrations(name,sha256) VALUES($1,$2)',[name,sha(await sqlFile(name))]);
}
async function schema(h,{historical=false,footprint='minimal'}={}){
 await selectedMigrate(h,legacyNames());
 await retainedSchema(h);
 if(!historical)await migrateLibrary(h.migrator());
 if(footprint==='observed'){
  // Exactly the retained runtime footprint; no added account permission.
  const map={app_attest_keys:'SELECT,INSERT,UPDATE',app_auth_challenges:'SELECT,INSERT,UPDATE,DELETE',
   app_auth_sessions:'SELECT,INSERT,UPDATE,DELETE',library_settings:'SELECT',library_tokens:'SELECT',
   library_users:'SELECT',membership_settings:'SELECT',spotify_connections:'SELECT,INSERT,UPDATE,DELETE',
   spotify_outbox:'SELECT,INSERT,UPDATE,DELETE',spotify_snapshot_capabilities:'SELECT,INSERT,UPDATE,DELETE'};
  for(const [table,rights] of Object.entries(map))await h.query('GRANT '+rights+' ON public.'+table+' TO '+runtime);
  await h.query('GRANT UPDATE(auth_window,auth_count,refresh_window,refresh_count) ON public.library_users TO '+runtime);
  await h.query('GRANT UPDATE(enabled,review_enabled) ON public.library_settings TO '+runtime);
 }
}
const imageTables=['library_users','library_tokens','app_attest_keys','app_auth_sessions','app_auth_challenges',
 'account_identities','account_nonces','account_rate_windows','listening_rooms','listening_commands','listening_outbox',
 'listening_rate_windows','selected_source_access','lyric_documents','live_lyrics_push_receipts','correction_reports',
 'membership_subscriptions','membership_grants','membership_usage','membership_preview_claims','membership_relay_usage',
 'spotify_connections','spotify_snapshot_capabilities','spotify_outbox','library_schema_migrations'];
async function image(h){
 const result={};
 for(const table of imageTables){
  const present=!table.startsWith('listening_')||(await one(h,'SELECT to_regclass($1)::text AS name',['public.'+table])).name;
  result[table]=present?(await h.query('SELECT to_jsonb(t)::text AS image FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows.map(row=>JSON.parse(row.image)):[];
 }
 return result;
}
async function seed(h,{retained=true,rate='matching'}={}){
 const id='delete-target',other='delete-other',keys=[1,2,3].map(n=>Buffer.alloc(32,n).toString('base64'));
 const credentials=['target-c1','target-c2','other-c'].map(sha),bearers=['lyra_s_target_exact','lyra_s_target_sibling','lyra_s_other'];
 const rooms=[1,2,3,4].map(n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'));
 const appToken='11111111-1111-1111-1111-111111111111',grant='22222222-2222-2222-2222-222222222222';
 await h.query("INSERT INTO public.library_users(id,access_kind) VALUES($1,'apple'),($2,'apple')",[id,other]);
 for(let i=0;i<3;i++){
  const owner=i===2?other:id;
  await h.query("INSERT INTO public.library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[credentials[i],owner]);
  await h.query(`INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
   VALUES($1,$2,$3,$4,'development','fixture-public-key',$5)`,[keys[i],owner,policy.audience,bundleID,Buffer.from('fixture-receipt')]);
  await h.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",[sha(bearers[i]),keys[i],credentials[i],policy.audience]);
 }
 await h.query('INSERT INTO public.account_identities(subject_hash,user_id,app_account_token,apple_client_id,refresh_token_encrypted) VALUES($1,$2,$3,$4,$5)',[sha('apple-subject'),id,appToken,bundleID,'encrypted-Apple-fixture']);
 for(let i=0;i<(retained?4:0);i++){
  const owner=i<2?id:other,members=i===2?[{userID:id,name:'Target',shareName:true,other:'preserved'},{userID:other,name:'Other',shareName:true}]:[{userID:owner,name:'Owner',shareName:true}];
  const data={members,recordings:[{provider:'appleMusic',catalogID:'exact-retained-id'}],unchanged:['opaque',i]};
  await h.query("INSERT INTO public.listening_rooms(id,environment,owner_id,status,invite_hash,code_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7)",[rooms[i],i===3?'development':'test',owner,i===1?'ended':'active','invite-'+i,'code-'+i,data]);
  await h.query('INSERT INTO public.listening_commands(room_id,command_id,actor_id,fingerprint,accepted_revision) VALUES($1,$2,$3,$4,1)',[rooms[i],randomUUID(),owner,'command-'+i]);
  await h.query('INSERT INTO public.listening_outbox(id,room_id,ordinal,due_at_ms) VALUES($1,$2,1,0)',['room-job-'+i,rooms[i]]);
 }
 for(const owner of !retained||rate==='empty'?[]:rate==='nonmatching'?[other]:[id,other])for(const bucket of ['read','write'])
  await h.query("INSERT INTO public.listening_rate_windows(user_id,bucket,window_at,count) VALUES($1,$2,'2026-01-01T00:00:00Z',7)",[owner,bucket]);
 await h.query("INSERT INTO public.lyric_documents(id,recording_key,source_hash,selection_revision,response,structure) VALUES('delete-doc','exact-recording','source-hash','rev','{}','{}')");
 for(const owner of [id,other]){
  await h.query("INSERT INTO public.selected_source_access(user_id,document_id) VALUES($1,'delete-doc')",[owner]);
  await h.query("INSERT INTO public.live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at) VALUES($1,$2,$3,'2099-01-01T00:00:00Z')",['push-'+owner,owner,sha(owner)]);
  await h.query("INSERT INTO public.correction_reports(id,user_id,document_id,source_id,category,detail,fingerprint,assessment) VALUES($1,$2,'delete-doc','line','lyrics','private report',$3,'{\"review\":\"retained\"}')",[randomUUID(),owner,'report-'+owner]);
 }
 await h.query("INSERT INTO public.membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,app_account_token,period_start,expires_at,signed_at) VALUES('purchase',$1,'transaction','fixture-product','plus','Sandbox',$2,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[id,appToken]);
 await h.query("INSERT INTO public.membership_grants(id,user_id,kind,period_key,allowance) VALUES($1,$2,'translation','starter',2)",[grant,id]);
 await h.query("INSERT INTO public.membership_usage(operation_id,user_id,grant_id,kind,state) VALUES($1,$2,$3,'translation','consumed')",[randomUUID(),id,grant]);
 await h.query("INSERT INTO public.membership_preview_claims(user_id,activity_id,recording_id,expires_at) VALUES($1,'preview','exact-recording','2099-01-01T00:00:00Z')",[id]);
 await h.query("INSERT INTO public.membership_relay_usage(user_id,period_start,request_count) VALUES($1,'2026-01-01',9)",[id]);
 for(let i=0;i<3;i++){
  const c={id:'spotify-'+i,epoch:'old-epoch-'+i,enrollmentID:'enrollment-'+i,ownerID:i===2?other:id,keyID:keys[i],credentialDigest:credentials[i],status:'connected',refresh:'encrypted-refresh',access:'encrypted-access',stage:{opaque:true},document:{exact:'source'},observation:{exact:true},metadata:{retained:'value'},consumers:{live:{status:'active',generation:1,sessionID:'live-'+i,tokenVersion:1,lastTimestamp:0}}};
  await h.query('INSERT INTO public.spotify_connections(id,owner_id,key_id,credential_digest,enrollment_id,data) VALUES($1,$2,$3,$4,$5,$6)',[c.id,c.ownerID,c.keyID,c.credentialDigest,c.enrollmentID,c]);
  await h.query('INSERT INTO public.spotify_snapshot_capabilities(digest,connection_id,session_id,expires_at_ms) VALUES($1,$2,$3,9007199254740991)',[sha('cap-'+i),c.id,'live-'+i]);
  await h.query("INSERT INTO public.spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,$3,'tick',0,'{\"keep\":true}','2099-01-01T00:00:00Z')",['old-job-'+i,c.id,c.epoch]);
 }
 const challenge='delete-confirmation';
 await h.query("INSERT INTO public.account_nonces(digest,purpose,bundle_id,key_id,user_id,expires_at) VALUES($1,'delete',$2,$3,$4,clock_timestamp()+interval '5 minutes')",[sha(challenge),bundleID,keys[0],id]);
 return {id,other,keys,credentials,bearers,rooms,input:{challenge,bundleID,identityToken:'external-Apple',authorizationCode:'external-Apple'}};
}
async function actual(h,f,{owner=false,beforeSQL,afterSQL,trace=[]}={}){
 const effects={appleAuthenticate:0,appleRevoke:0,cleanup:[]},role=owner?null:account;
 const db=h.adapter(role,{trace,beforeSQL,afterSQL});
 const auth=new AppAuthStore(db,{policy}); // Actual authenticate SQL; no auth replacement.
 const user=await auth.authenticate(f.bearers[0]);assert.equal(user.id,f.id);
 const count=trace.length;
 const store=new AccountStore(db,{policy,apple:{authenticate:async()=>{effects.appleAuthenticate++;return {subjectHash:sha('apple-subject'),refreshTokenEncrypted:'fresh-encrypted'};},revoke:async()=>{effects.appleRevoke++;}},
  spotifyCleanupFn:async(_db,ids)=>{effects.cleanup.push([...ids]);}});
 assert.equal(trace.length,count,'default-off construction executes no SQL');
 const handle=await store.prepareWriterAuthentication(f.bearers[0]);
 return {effects,trace,run:()=>store.delete(user,f.input,handle)};
}
function traceSuccess(trace,role){
 const commit=trace.findLastIndex(e=>e.event==='COMMIT');assert.ok(commit>=0);
 assert.match(trace[commit-1].text,/^WITH auth_clock AS MATERIALIZED/);assert.match(trace[commit-1].text,/AS source_live/);
 for(const e of trace.filter(e=>e.text)){assert.equal(e.currentUser,role??e.sessionUser);assert.doesNotMatch(e.text,/listening_v2\./,'actual default-off methods must not activate V2');}
}
function sorted(rows){return [...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
function unchangedExcept(before,after,fields){
 const strip=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!fields.includes(k)));
 assert.deepEqual(strip(after),strip(before));
}
function assertDeleted(before,after,f){
 const target=r=>r.user_id===f.id,other=r=>r.user_id!==f.id;
 for(const table of ['lyric_documents','app_auth_challenges','account_rate_windows','membership_subscriptions','membership_grants','membership_usage','membership_preview_claims','membership_relay_usage','library_schema_migrations'])assert.deepEqual(after[table],before[table],table);
 for(const r of before.library_users){const a=after.library_users.find(x=>x.id===r.id);assert.deepEqual(a,r.id===f.id?{...r,disabled:true}:r);}
 // image() orders by PostgreSQL text; normalize both sides for transformations.
 for(const table of ['library_tokens','app_attest_keys']){
  const expected=before[table].map(r=>!target(r)?r:table==='library_tokens'?{...r,revoked:true}:{...r,revoked:true,public_key:'',receipt:'\\x'});
  assert.deepEqual(sorted(after[table]),sorted(expected),table+' exact scrub and unchanged metadata');
 }
 assert.deepEqual(after.app_auth_sessions,before.app_auth_sessions.filter(r=>r.key_id===f.keys[2]));
 for(const table of ['selected_source_access','live_lyrics_push_receipts','listening_rate_windows'])assert.deepEqual(after[table],before[table].filter(other),table);
 const retained=after.listening_rooms;assert.equal(retained.length,before.listening_rooms.filter(row=>row.owner_id!==f.id).length);
 for(const old of before.listening_rooms.filter(r=>r.owner_id!==f.id)){
  const row=retained.find(r=>r.id===old.id);assert.ok(row);
  if(old.id===f.rooms[2]){unchangedExcept(old,row,['data','updated_at']);assert.deepEqual(row.data,{...old.data,members:old.data.members.map(m=>m.userID===f.id?{...m,userID:null,name:'Friend',shareName:false}:m)});}
  else assert.deepEqual(row,old);
 }
 for(const table of ['listening_commands','listening_outbox'])assert.deepEqual(after[table],before[table].filter(r=>!f.rooms.slice(0,2).includes(r.room_id)),table+' cascade');
 for(const old of before.account_identities){const row=after.account_identities.find(r=>r.user_id===old.user_id);unchangedExcept(old,row,['deleted_at','refresh_token_encrypted','apple_client_id']);assert.ok(row.deleted_at);assert.equal(row.refresh_token_encrypted,null);assert.equal(row.apple_client_id,null);}
 assert.deepEqual(after.account_nonces,before.account_nonces.map(r=>r.digest===sha(f.input.challenge)?{...r,consumed:true}:r));
 assert.deepEqual(sorted(after.correction_reports),sorted(before.correction_reports.map(r=>target(r)?{...r,detail:'[Account deleted]',assessment:null}:r)));
 for(const old of before.spotify_connections){
  const row=after.spotify_connections.find(r=>r.id===old.id);
  if(old.owner_id!==f.id){assert.deepEqual(row,old);continue;}
  unchangedExcept(old,row,['data','updated_at']);const c=row.data;
  assert.equal(c.status,'disconnected');assert.equal(c.reason,'accountDeleted');assert.notEqual(c.epoch,old.data.epoch);assert.ok(Number.isSafeInteger(c.closedAt));
  for(const field of ['refresh','access','stage','refreshLease','pollLease','document','observation'])assert.equal(c[field],null);
  assert.deepEqual(c.metadata,old.data.metadata);
  assert.deepEqual(c.consumers.live,{...old.data.consumers.live,generation:2,status:'ended',reason:'accountDeleted',endedAt:c.closedAt});
  unchangedExcept(old.data,c,['epoch','status','reason','closedAt','refresh','access','stage','refreshLease','pollLease','document','observation','consumers']);
 }
 assert.deepEqual(after.spotify_snapshot_capabilities,before.spotify_snapshot_capabilities.filter(r=>r.connection_id==='spotify-2'));
 for(const old of before.spotify_outbox)assert.ok(after.spotify_outbox.some(row=>JSON.stringify(row)===JSON.stringify(old)),'prior Spotify jobs preserved');
 const fresh=after.spotify_outbox.filter(r=>!before.spotify_outbox.some(old=>old.id===r.id));assert.equal(fresh.length,2);
 for(const row of fresh){assert.equal(row.kind,'cleanup');assert.equal(row.state,'pending');assert.equal(row.receipt,null);assert.equal(row.data.reason,'accountDeleted');assert.equal(row.data.generation,1);assert.ok(['spotify-0','spotify-1'].includes(row.connection_id));}
}
async function acl(h){return (await h.query(`SELECT n.nspname,c.relname,'table' AS scope,NULL::text AS column_name,x.grantor,x.grantee,x.privilege_type,x.is_grantable
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) x WHERE n.nspname IN ('public','listening_v2')
 UNION ALL SELECT n.nspname,c.relname,'column',a.attname,x.grantor,x.grantee,x.privilege_type,x.is_grantable
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
 CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x WHERE n.nspname IN ('public','listening_v2') ORDER BY 1,2,3,4,5,6,7,8`)).rows;}
async function authority(h){return {roles:(await h.query(`SELECT oid,rolname,rolsuper,rolcanlogin,rolinherit,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_catalog.pg_roles ORDER BY oid`)).rows,
 memberships:(await h.query('SELECT roleid,member,grantor,admin_option FROM pg_catalog.pg_auth_members ORDER BY roleid,member')).rows,
 owners:(await h.query("SELECT n.nspname,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','listening_v2') AND c.relkind='r' ORDER BY 1,2")).rows,
 schemaACL:(await h.query("SELECT nspname,nspacl::text AS acl FROM pg_catalog.pg_namespace WHERE nspname IN ('public','listening_v2') ORDER BY 1")).rows,
 defaults:(await h.query('SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text AS acl FROM pg_catalog.pg_default_acl ORDER BY 1,2,3')).rows};}
async function narrow(h,expected){
 const role=await one(h,"SELECT oid,rolsuper,rolbypassrls,rolinherit FROM pg_catalog.pg_roles WHERE rolname=$1",[account]);
 assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);assert.equal(role.rolinherit,false);
 for(const p of ['SELECT','INSERT','UPDATE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await one(h,'SELECT pg_catalog.has_table_privilege($1,\'public.listening_rate_windows\',$2) AS allowed',[account,p])).allowed,false,p);
 assert.equal((await one(h,"SELECT pg_catalog.has_table_privilege($1,'public.listening_rate_windows','DELETE') AS allowed",[account])).allowed,true);
 for(const column of ['user_id','bucket','window_at','count']){
  assert.equal((await one(h,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows',$2,'SELECT') AS allowed",[account,column])).allowed,column==='user_id'&&expected);
  assert.equal((await one(h,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows',$2,'SELECT WITH GRANT OPTION') AS allowed",[account,column])).allowed,false);
 }
 const a=await authority(h);assert.equal(a.memberships.some(r=>r.member===role.oid),false);
 assert.equal(a.owners.some(r=>r.relowner===role.oid),false);return a;
}
async function runCases(caseTest,make){
 await caseTest('neutral registry and replay retain only the catalog-checked account-data repair',async()=>{
  assert.ok(migrationNames.includes(correction));
  assert.ok(!migrationNames.some(name=>/^(029|030|031|033|034|035)-/.test(name)));
  const historical=(await sqlFile('035-listening-account-delete-privileges.sql')).match(/^DO \$listening_account_delete_privileges\$\n([\s\S]*?)\nEND \$listening_account_delete_privileges\$;/m);
  const neutral=(await sqlFile(correction)).match(/^DO \$account_data_privacy\$\n([\s\S]*?)\nEND \$account_data_privacy\$;/m);
  assert.ok(historical);assert.ok(neutral);
  assert.equal(neutral[1],historical[1].replace('    -- Do not RETURN from an embedded replay: 034 must still withhold metadata.\n',''));
  const replay=await readFile(new URL('../../scripts/membership-role-grants.js',import.meta.url),'utf8');
  assert.doesNotMatch(replay,/03[45]-|sessions_install_metadata_privileges/);
 });
 await caseTest('fresh no-Sessions schema stays absent through migration, late replay, and account deletion',async t=>{
  const h=await make(t);assert.deepEqual(await migrateLibrary(h.migrator()),migrationNames);
  const beforeACL=await acl(h),beforeAuthority=await authority(h);
  await h.query(body(await sqlFile(correction)));await replayMembershipRoleGrants(h);
  assert.deepEqual(await acl(h),beforeACL);assert.deepEqual(await authority(h),beforeAuthority);
  const f=await seed(h,{retained:false}),before=await image(h),trace=[],a=await actual(h,f,{trace});
  assert.deepEqual(await a.run(),{deleted:true});assertDeleted(before,await image(h),f);traceSuccess(trace,account);
  assert.ok(!trace.some(entry=>/^(DELETE FROM|UPDATE) listening_/.test(entry.text??'')));
  assert.equal((await one(h,"SELECT to_regnamespace('listening_v2')::text AS name")).name,null);
  for(const table of ['listening_rooms','listening_commands','listening_outbox','listening_rate_windows'])
   assert.equal((await one(h,'SELECT to_regclass($1)::text AS name',['public.'+table])).name,null);
 });
 await caseTest('fresh no-Sessions schema remains a no-op for roles created after all receipts',async t=>{
  const h=await make(t,{roles:false});await migrateLibrary(h.migrator());await h.createRoles();await replayMembershipRoleGrants(h);
  assert.equal((await one(h,"SELECT to_regclass('public.listening_rate_windows')::text AS name")).name,null);
  assert.deepEqual(await migrateLibrary(h.migrator()),[]);
 });
 for(const config of [{footprint:'minimal'},{footprint:'observed'}])
 await caseTest('actual registered migrator -> populated restricted AccountStore.delete success '+JSON.stringify(config),async t=>{
  const h=await make(t);await schema(h,config);const f=await seed(h,config),before=await image(h),trace=[];
  const a=await actual(h,f,{trace});assert.deepEqual(await a.run(),{deleted:true});
  const after=await image(h);assertDeleted(before,after,f);traceSuccess(trace,account);
  assert.equal(a.effects.appleRevoke,1);assert.deepEqual(a.effects.cleanup,[['spotify-0','spotify-1']]);
  await narrow(h,true);
 });
 for(const rate of ['matching','nonmatching','empty'])await caseTest('historical registry actual restricted delete reaches exact 42501 and populated rollback; '+rate,async t=>{
  const h=await make(t);await schema(h,{historical:true,footprint:'observed'});
  const f=await seed(h,{rate}),before=await image(h),trace=[];const a=await actual(h,f,{trace});
  await narrow(h,false);await assert.rejects(a.run(),permission);assert.deepEqual(await image(h),before);
  assert.ok(trace.some(e=>e.text?.startsWith('DELETE FROM listening_rooms')));
  assert.ok(trace.some(e=>e.text?.startsWith('UPDATE listening_rooms')));
  assert.equal(trace.at(-1).event,'ROLLBACK');assert.equal(a.effects.appleRevoke,1);assert.deepEqual(a.effects.cleanup,[]);
  for(const e of trace.filter(e=>e.text))assert.equal(e.currentUser,account);
 });
 await caseTest('original owner positive control remains separate from restricted qualification',async t=>{
  const h=await make(t);await schema(h,{historical:true});const f=await seed(h),before=await image(h),trace=[];
  const a=await actual(h,f,{owner:true,trace});assert.deepEqual(await a.run(),{deleted:true});assertDeleted(before,await image(h),f);traceSuccess(trace,null);
 });
 await caseTest('036 exact populated ACL delta, no rewrite, repeat and remove-only-new-column actual-method regression',async t=>{
  const h=await make(t);await schema(h,{historical:true,footprint:'observed'});const f=await seed(h);
  const before=await image(h),old=await acl(h),auth=await narrow(h,false);
  const physical=async()=>(await h.query('SELECT user_id,bucket,ctid::text AS ctid,xmin::text AS xmin FROM public.listening_rate_windows ORDER BY user_id,bucket')).rows;
  const tuples=await physical();await h.query(body(await sqlFile(correction)));const next=await acl(h);
  const delta=next.filter(r=>!old.some(o=>JSON.stringify(o)===JSON.stringify(r)));
  assert.equal(delta.length,1);assert.equal(delta[0].nspname,'public');assert.equal(delta[0].relname,'listening_rate_windows');assert.equal(delta[0].scope,'column');
  assert.equal(delta[0].column_name,'user_id');assert.equal(delta[0].grantee,(await one(h,'SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1',[account])).oid);
  assert.equal(delta[0].privilege_type,'SELECT');assert.equal(delta[0].is_grantable,false);
  assert.deepEqual(next.filter(r=>!delta.includes(r)),old);assert.deepEqual(await authority(h),auth);
  await narrow(h,true);await h.query(body(await sqlFile(correction)));assert.deepEqual(await acl(h),next);
  assert.deepEqual(await image(h),before);assert.deepEqual(await physical(),tuples);
  await h.query('REVOKE SELECT(user_id) ON public.listening_rate_windows FROM '+account);await narrow(h,false);
  const a=await actual(h,f);await assert.rejects(a.run(),permission);assert.deepEqual(await image(h),before);
  await h.query(body(await sqlFile(correction)));const good=await actual(h,f);assert.deepEqual(await good.run(),{deleted:true});assertDeleted(before,await image(h),f);
 });
 for(const fault of ['last-SQL-failure','unexpected-exact-session','session-deadline','credential-deadline','key-bundle-drift'])
 await caseTest('after successful scrub/persist actual final failure rolls back the entire populated SQL image; '+fault,async t=>{
  const h=await make(t);await schema(h,{footprint:'observed'});const f=await seed(h);
  if(fault.endsWith('deadline'))await h.query('UPDATE public.'+(fault==='session-deadline'?'app_auth_sessions':'library_tokens')+" SET expires_at=clock_timestamp()+interval '2 seconds' WHERE digest=$1",[fault==='session-deadline'?sha(f.bearers[0]):f.credentials[0]]);
  const before=await image(h),trace=[];let injected=false;
  const a=await actual(h,f,{trace,beforeSQL:async(text,raw)=>{
   if(fault.endsWith('deadline')&&text.includes('AS source_live')){
    const table=fault==='session-deadline'?'app_auth_sessions':'library_tokens',deadline=before[table].find(r=>r.digest===(fault==='session-deadline'?sha(f.bearers[0]):f.credentials[0])).expires_at;
    await raw.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.01)',[deadline]);injected=true;
   }
  },afterSQL:async(text,raw)=>{
   if(injected||!text.startsWith('INSERT INTO spotify_outbox'))return;
   if(fault.endsWith('deadline'))return;
   injected=true;
   if(fault==='last-SQL-failure')await raw.query('SELECT 1/0');
   else await h.ownerInjection(raw,async()=>{
    if(fault==='key-bundle-drift')await raw.query("UPDATE public.app_attest_keys SET bundle_id='test.changed' WHERE key_id=$1",[f.keys[0]]);
    else await raw.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",[sha(f.bearers[0]),f.keys[0],f.credentials[0],policy.audience]);
   });
  }});
  await assert.rejects(a.run(),fault==='last-SQL-failure'?e=>e.code==='spotify_revocation_unavailable':{code:'app_access_revoked'});
  assert.equal(injected,true);assert.ok(trace.some(e=>e.text?.startsWith('DELETE FROM listening_rate_windows')));
  assert.ok(trace.some(e=>e.text?.startsWith('UPDATE spotify_connections')));
  assert.equal(trace.at(-1).event,'ROLLBACK');assert.deepEqual(await image(h),before);assert.deepEqual(a.effects.cleanup,[]);assert.equal(a.effects.appleRevoke,1,'external Apple revoke is recorded, never asserted rolled back');

  // A deadline cannot be extended as an auth recovery claim. Owner fixture
  // renewal here starts a separately prepared attempt after rollback.
  if(fault.endsWith('deadline')){
   const table=fault==='session-deadline'?'app_auth_sessions':'library_tokens';
   await h.query('UPDATE public.'+table+" SET expires_at=clock_timestamp()+interval '1 hour' WHERE digest=$1",[fault==='session-deadline'?sha(f.bearers[0]):f.credentials[0]]);
  }
  const freshBefore=await image(h),fresh=await actual(h,f);assert.deepEqual(await fresh.run(),{deleted:true});assertDeleted(freshBefore,await image(h),f);
 });
 await caseTest('real runner fresh/upgrade/checksum/repeat and after-grant-before-receipt rollback',async t=>{
  const h=await make(t);await schema(h,{historical:true});const f=await seed(h),before=await image(h),old=await acl(h);
  await assert.rejects(migrateLibrary(h.migrator({failReceipt:correction})),{code:'injected_036_receipt_failure'});
  assert.deepEqual(await image(h),before);assert.deepEqual(await acl(h),old);await narrow(h,false);
  assert.deepEqual(await migrateLibrary(h.migrator()),[correction]);await narrow(h,true);
  const receipts=(await h.query('SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations ORDER BY name')).rows;
  assert.deepEqual(receipts.map(r=>r.name),[...migrationNames,'029-listening-sessions.sql'].sort());for(const r of receipts)assert.equal(r.sha256,sha(await sqlFile(r.name)));
  assert.deepEqual(await migrateLibrary(h.migrator()),[]);assert.deepEqual((await h.query('SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations ORDER BY name')).rows,receipts);
  await h.query("UPDATE public.library_schema_migrations SET sha256='changed' WHERE name=$1",[correction]);
  const changed=await image(h);await assert.rejects(migrateLibrary(h.migrator()),{code:'migration_changed'});assert.deepEqual(await image(h),changed);
  assert.equal((await one(h,"SELECT to_regnamespace('listening_v2')::text AS name")).name,null);
  assert.ok(!migrationNames.some(n=>/^(029|030|031|033|034|035)-/.test(n)));
 });
 await caseTest('existing historical repair receipt remains unchanged and the neutral upgrade adds no authority',async t=>{
  const h=await make(t);await schema(h,{historical:true});await seed(h);
  await h.query('GRANT SELECT(user_id) ON public.listening_rate_windows TO '+account);
  const name='035-listening-account-delete-privileges.sql';
  await h.query('INSERT INTO public.library_schema_migrations(name,sha256) VALUES($1,$2)',[name,sha(await sqlFile(name))]);
  const receipt=await one(h,'SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations WHERE name=$1',[name]);
  const before=await image(h),old=await acl(h),oldAuthority=await authority(h);
  assert.deepEqual(await migrateLibrary(h.migrator()),[correction]);
  const after=await image(h);delete before.library_schema_migrations;delete after.library_schema_migrations;
  assert.deepEqual(after,before);assert.deepEqual(await acl(h),old);assert.deepEqual(await authority(h),oldAuthority);
  assert.deepEqual(await one(h,'SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations WHERE name=$1',[name]),receipt);
  assert.deepEqual(await migrateLibrary(h.migrator()),[]);await narrow(h,true);
 });
 await caseTest('role absence creates no role; genuinely late-after-all-receipts remains source-writer negative',async t=>{
  const h=await make(t,{roles:false});await schema(h);const f=await seed(h);const before=await image(h),roles=await authority(h);
  assert.equal(roles.roles.some(r=>[account,runtime].includes(r.rolname)),false);
  await h.query(body(await sqlFile(correction)));assert.deepEqual(await authority(h),roles);assert.deepEqual(await image(h),before);
  await h.createRoles();const calls=[];await replayMembershipRoleGrants({query:async text=>{calls.push(text);return h.query(text);}});assert.equal(calls.length,1);
  // No invisible 027/029 repair and no role inheritance in this genuine writer path.
  for(const relation of ['spotify_connections','spotify_snapshot_capabilities','spotify_outbox','listening_rooms'])assert.equal((await one(h,'SELECT pg_catalog.has_table_privilege($1,$2,\'SELECT\') AS allowed',[account,'public.'+relation])).allowed,false,relation);
  assert.equal((await one(h,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows','user_id','SELECT') AS allowed",[account])).allowed,true);
  assert.equal((await one(h,"SELECT pg_catalog.has_table_privilege($1,'public.listening_rate_windows','DELETE') AS allowed",[account])).allowed,false);
  const lateBefore=await image(h),a=await actual(h,f);await assert.rejects(a.run(),{code:'spotify_revocation_unavailable'});assert.deepEqual(await image(h),lateBefore);assert.deepEqual(a.effects.cleanup,[]);
 });
 await caseTest('fresh runner failure before 036 receipt rolls schema and grants back together',async t=>{
  const h=await make(t),old=await authority(h);
  await assert.rejects(migrateLibrary(h.migrator({failReceipt:correction})),{code:'injected_036_receipt_failure'});
  assert.deepEqual(await one(h,"SELECT to_regclass('public.library_users')::text AS users,to_regclass('public.library_schema_migrations')::text AS receipts"),{users:null,receipts:null});
  assert.deepEqual(await authority(h),old);
  assert.deepEqual(await migrateLibrary(h.migrator()),migrationNames);
  assert.equal((await one(h,"SELECT to_regclass('public.listening_rate_windows')::text AS name")).name,null);
 });
 await caseTest('late replay with EXPLICIT independently established historical 027/029 prerequisites can delete',async t=>{
  const h=await make(t,{roles:false});await schema(h);const f=await seed(h);await h.createRoles();
  // This is a separate compatible footprint, NEVER the genuine source-writer
  // negative above. Establish and label the actual omitted old prerequisites.
  for(const name of ['027-spotify-background.sql']){
   const blocks=(await sqlFile(name)).match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g);assert.equal(blocks.length,1);await h.query(blocks[0]);
  }
  await historicalAccountGrants(h);await replayMembershipRoleGrants(h);await narrow(h,true);
  const before=await image(h),a=await actual(h,f);assert.deepEqual(await a.run(),{deleted:true});assertDeleted(before,await image(h),f);
 });
 await caseTest('all optional V1 listening tables absent is compatible; partial present schema refuses',async t=>{
  const h=await make(t);await schema(h,{historical:true});const baseline=await authority(h),before=await acl(h);
  await h.tx(null,async raw=>{
   await raw.query('DROP TABLE public.listening_commands,public.listening_outbox,public.listening_rooms,public.listening_rate_windows');
   await raw.query(body(await sqlFile(correction)));
   await replayMembershipRoleGrants(raw); // Real partial accounts.test.js footprint.
   assert.equal((await one(raw,"SELECT to_regclass('public.listening_rooms')::text AS name")).name,null);
  });
  assert.deepEqual(await authority(h),{...baseline,owners:baseline.owners.filter(r=>!r.relname.startsWith('listening_'))});
  assert.equal((await acl(h)).some(r=>r.relname==='listening_rate_windows'),false);
  assert.ok(before.length>0);
 });
 const malformedChanges=[
  'ALTER TABLE public.library_users RENAME TO delete_users_original',
  'DROP TABLE public.listening_rate_windows',
  'ALTER TABLE public.listening_rate_windows RENAME TO rate_original; CREATE VIEW public.listening_rate_windows AS SELECT * FROM public.rate_original',
  'ALTER TABLE public.listening_rate_windows ALTER COLUMN user_id TYPE varchar(128)',
  'ALTER TABLE public.listening_rate_windows ALTER COLUMN count DROP NOT NULL',
  'ALTER TABLE public.listening_rate_windows ADD COLUMN extra text',
  'ALTER TABLE public.listening_rate_windows DROP CONSTRAINT listening_rate_windows_pkey',
  'ALTER TABLE public.listening_rate_windows DROP CONSTRAINT listening_rate_windows_user_id_fkey',
  'DROP INDEX public.listening_members; ALTER TABLE public.listening_rooms ALTER COLUMN data TYPE text USING data::text',
  'DROP TABLE public.listening_commands',
  'ALTER TABLE public.listening_rate_windows ENABLE ROW LEVEL SECURITY',
  'CREATE TABLE public.rate_child() INHERITS(public.listening_rate_windows)'
 ];
 for(const change of malformedChanges)await caseTest('036 refuses malformed optional schema atomically: '+change,async t=>{
  const h=await make(t);await schema(h,{historical:true});await seed(h);const before=await image(h),old=await acl(h);
  const indexBefore=await one(h,"SELECT pg_get_indexdef('public.listening_members'::regclass) AS definition");
  await assert.rejects(h.tx(null,async raw=>{await raw.query(change);await raw.query(body(await sqlFile(correction)));}),malformed);
  assert.deepEqual(await image(h),before);assert.deepEqual(await acl(h),old);
  await assert.rejects(h.tx(null,async raw=>{
   await raw.query('REVOKE UPDATE(disabled) ON public.library_users FROM '+account);await raw.query(change);
   await replayMembershipRoleGrants(raw);
  }),change==='ALTER TABLE public.library_users RENAME TO delete_users_original'?{code:'42P01'}:malformed);
  assert.deepEqual(await image(h),before);assert.deepEqual(await acl(h),old);
  assert.deepEqual(await one(h,"SELECT pg_get_indexdef('public.listening_members'::regclass) AS definition"),indexBefore);
 });
 await caseTest('036 upgrade refuses unresolved expected parent without receipt or ACL changes',async t=>{
  const h=await make(t);await schema(h,{historical:true});await seed(h);
  const before=await image(h),old=await acl(h);
  await assert.rejects(h.tx(null,async raw=>{
   await raw.query('ALTER TABLE public.library_users RENAME TO delete_users_original');
   // Actual runner in the existing owner transaction: old receipts skip old
   // bodies, so only 036 can refuse this unresolved expected FK target.
   await migrateLibrary({transaction:fn=>fn(raw)});
  }),malformed);
  assert.deepEqual(await image(h),before);assert.deepEqual(await acl(h),old);
  assert.equal((await one(h,'SELECT count(*)::int AS n FROM public.library_schema_migrations WHERE name=$1',[correction])).n,0);
 });
 await caseTest('036 hostile search_path and shadows remain untouched, direct and replay repeat',async t=>{
  const h=await make(t);await schema(h,{historical:true});await seed(h);const before=await image(h);
  await h.query('CREATE SCHEMA delete_shadow');
  for(const table of ['listening_rooms','listening_commands','listening_outbox','listening_rate_windows'])await h.query('CREATE TABLE delete_shadow.'+table+'(marker text)');
  await h.tx(null,async raw=>{
   await raw.query('SET LOCAL search_path=delete_shadow,public,pg_catalog');
   await raw.query(body(await sqlFile(correction)));await raw.query(body(await sqlFile(correction)));
   await replayMembershipRoleGrants(raw);
   assert.equal((await one(raw,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows','user_id','SELECT') AS allowed",[account])).allowed,true);
   assert.equal((await one(raw,"SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='delete_shadow' AND (c.relacl IS NOT NULL OR a.attacl IS NOT NULL)")).n,0);
  });
  assert.deepEqual(await image(h),before);
 });
 await caseTest('one atomic replay statement: malformed retained schema rolls back prior replay rights',async t=>{
  const h=await make(t);await schema(h,{historical:true,footprint:'observed'});await seed(h);
  await h.query('REVOKE UPDATE(disabled) ON public.library_users FROM '+account);
  const before=await image(h),old=await acl(h),calls=[];
  await assert.rejects(h.tx(null,async raw=>{
   await raw.query('ALTER TABLE public.listening_rate_windows ALTER COLUMN count DROP NOT NULL');
   await replayMembershipRoleGrants({query:async text=>{calls.push(text);return raw.query(text);}});
  }),malformed);
  assert.equal(calls.length,1);assert.match(calls[0],/^DO \$membership_role_replay\$\nBEGIN\n/);
  for(const name of ['025-memberships.sql','028-selected-lyrics-learning.sql','032-auth-token-row-locks.sql']){
   const block=(await sqlFile(name)).match(/DO \$\$ (BEGIN[\s\S]*?END) \$\$;/g).filter(text=>text.includes('pg_roles')&&text.includes('GRANT '));assert.equal(block.length,1);
   assert.ok(calls[0].includes(block[0].slice('DO $$ '.length,-' $$;'.length)+';'));
  }
  const priorGrant=calls[0].indexOf('UPDATE(disabled,auth_count');
  assert.ok(priorGrant>=0&&priorGrant<calls[0].indexOf('listening_account_delete_catalog_mismatch'));
  assert.doesNotMatch(calls[0],/\b(?:ALTER TABLE|CREATE (?:TABLE|SCHEMA|ROLE)|INSERT INTO|DELETE FROM|TRUNCATE)\b/);
  assert.doesNotMatch(calls[0],/sessions_install_metadata_privileges|v2_install_/);
  assert.deepEqual(await acl(h),old);assert.deepEqual(await image(h),before);await narrow(h,false);
 });
}

await runCases((name,fn)=>{test(name,fn);},make);
