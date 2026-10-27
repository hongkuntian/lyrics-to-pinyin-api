// MANUAL, AUTHORED ONLY. No skip or external database fallback. Root supplies
// an already running, owned Unix-only qualification cluster and approved commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {open,lstat,realpath,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
let AccountStore,AppAuthStore,migrateLibrary,migrationNames,replayMembershipRoleGrants;
async function preflight(){
 const expected=process.env.LYRA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT;
 assert.match(expected??'',/^[a-f0-9]{40}$/);assert.equal(git('rev-parse','HEAD'),expected);
 git('merge-base','--is-ancestor','5b12df46048a212a56b8b0cc146a80492f49481f',expected);
 assert.equal(git('status','--porcelain=v1','--untracked-files=normal','--','.',':(exclude)node_modules'),'');
 // Exact approved clean Git object pins ALL maintained bytes. Do not require a
 // future 035 blob before the actual-method red can reach baseline SQL.
 assert.deepEqual(Object.keys(process.env).filter(k=>/^PG/.test(k)),[]);
 const path=process.env.LYRA_TEST_POSTGRES_MANIFEST,uid=process.getuid();assert.ok(isAbsolute(path??''));
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let marker;
 try{const s=await fd.stat();assert.ok(s.isFile());assert.equal(s.uid,uid);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);assert.ok(s.size>0&&s.size<=16384);marker=JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}
 assert.equal(marker.purpose,'lyrica-sessions-v2-local-qualification');assert.equal(marker.ownerUID,uid);assert.equal(marker.active,true);assert.equal(marker.TCPListening,false);assert.equal(marker.sourceCommit,expected);
 assert.match(marker.systemIdentifier??'',/^[1-9][0-9]{0,19}$/);assert.match(marker.socketDirectory??'',/^\/tmp\/lyrica-sessions-pg-[A-Za-z0-9_-]+$/);assert.ok(isAbsolute(marker.dataDirectory??''));
 for(const path of [marker.socketDirectory,marker.dataDirectory]){const s=await lstat(path);assert.ok(s.isDirectory()&&!s.isSymbolicLink());assert.equal(s.uid,uid);assert.equal(s.mode&0o077,0);}
 assert.ok(Number.isInteger(marker.port)&&marker.port>1024&&marker.port<65536);assert.match(marker.user??'',/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
 const socket=await lstat(resolve(marker.socketDirectory,'.s.PGSQL.'+marker.port));assert.ok(socket.isSocket()&&!socket.isSymbolicLink());assert.equal(socket.uid,uid);return marker;
}

// AUTHORED, UNEXECUTED. Shared source text is intentionally copied into the two
// maintained test postimages; no extra maintained helper/import is required.
const correction='035-listening-account-delete-privileges.sql';
const account='lyra_account_v1',runtime='lyra_runtime_v1';
const policy={audience:'delete-privilege-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const bundleID=policy.bundles[0];
const sha=value=>createHash('sha256').update(value).digest('hex');
const sqlFile=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
// Retained 030/031 begin with comments. Strip their actual outer transaction
// so setup commits before each rollback probe instead of leaving PGlite in it.
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
async function schema(h,{historical=false,metadata=false,footprint='minimal'}={}){
 if(historical)await selectedMigrate(h,legacyNames());else await migrateLibrary(h.migrator());
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
 if(metadata)for(const name of ['030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql',
  '033-listening-v2-lifecycle-composition.sql','034-listening-v2-output-terminal-support.sql'])
  await h.query(body(await sqlFile(name)));
}
const imageTables=['library_users','library_tokens','app_attest_keys','app_auth_sessions','app_auth_challenges',
 'account_identities','account_nonces','account_rate_windows','listening_rooms','listening_commands','listening_outbox',
 'listening_rate_windows','selected_source_access','lyric_documents','live_lyrics_push_receipts','correction_reports',
 'membership_subscriptions','membership_grants','membership_usage','membership_preview_claims','membership_relay_usage',
 'spotify_connections','spotify_snapshot_capabilities','spotify_outbox','library_schema_migrations'];
async function image(h){
 const result={};for(const table of imageTables)result[table]=(await h.query('SELECT to_jsonb(t)::text AS image FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows.map(r=>JSON.parse(r.image));
 if((await one(h,"SELECT to_regnamespace('listening_v2')::text AS name")).name)
  for(const table of ['rooms','output_guards','privacy_personas','returning_grants','command_receipts','semantic_events','outbox','private_profile_assets'])
   result['v2.'+table]=(await h.query('SELECT to_jsonb(t)::text AS image FROM listening_v2.'+table+' t ORDER BY to_jsonb(t)::text')).rows;
 return result;
}
async function seed(h,{metadata=false,known=false,rate='matching'}={}){
 const id='delete-target',other='delete-other',keys=[1,2,3].map(n=>Buffer.alloc(32,n).toString('base64'));
 const credentials=['target-c1','target-c2','other-c'].map(sha),bearers=['lyra_s_target_exact','lyra_s_target_sibling','lyra_s_other'];
 const rooms=[1,2,3,4].map(n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'));
 const appToken='11111111-1111-1111-1111-111111111111',grant='22222222-2222-2222-2222-222222222222';
 await h.query("INSERT INTO public.library_users(id,access_kind) VALUES($1,'apple'),($2,'apple')",[id,other]);
 for(let i=0;i<3;i++){
  const owner=i===2?other:id;
  await h.query("INSERT INTO public.library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[credentials[i],owner]);
  await h.query(`INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt${metadata?',sessions_install_binding_version':''})
   VALUES($1,$2,$3,$4,'development','fixture-public-key',$5${metadata?',$6':''})`,[keys[i],owner,policy.audience,bundleID,Buffer.from('fixture-receipt'),...(metadata?[known?1:null]:[])]);
  await h.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",[sha(bearers[i]),keys[i],credentials[i],policy.audience]);
 }
 await h.query('INSERT INTO public.account_identities(subject_hash,user_id,app_account_token,apple_client_id,refresh_token_encrypted) VALUES($1,$2,$3,$4,$5)',[sha('apple-subject'),id,appToken,bundleID,'encrypted-Apple-fixture']);
 for(let i=0;i<4;i++){
  const owner=i<2?id:other,members=i===2?[{userID:id,name:'Target',shareName:true,other:'preserved'},{userID:other,name:'Other',shareName:true}]:[{userID:owner,name:'Owner',shareName:true}];
  const data={members,recordings:[{provider:'appleMusic',catalogID:'exact-retained-id'}],unchanged:['opaque',i]};
  await h.query("INSERT INTO public.listening_rooms(id,environment,owner_id,status,invite_hash,code_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7)",[rooms[i],i===3?'development':'test',owner,i===1?'ended':'active','invite-'+i,'code-'+i,data]);
  await h.query('INSERT INTO public.listening_commands(room_id,command_id,actor_id,fingerprint,accepted_revision) VALUES($1,$2,$3,$4,1)',[rooms[i],randomUUID(),owner,'command-'+i]);
  await h.query('INSERT INTO public.listening_outbox(id,room_id,ordinal,due_at_ms) VALUES($1,$2,1,0)',['room-job-'+i,rooms[i]]);
 }
 for(const owner of rate==='empty'?[]:rate==='nonmatching'?[other]:[id,other])for(const bucket of ['read','write'])
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
 const retained=after.listening_rooms;assert.equal(retained.length,2);
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
 for(const key of Object.keys(before).filter(k=>k.startsWith('v2.')))assert.deepEqual(after[key],before[key]);
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
async function metadataWithheld(h){
 const present=(await one(h,"SELECT count(*)::int AS n FROM pg_catalog.pg_attribute WHERE attrelid='public.app_attest_keys'::regclass AND attname='sessions_authority_generation' AND NOT attisdropped")).n;
 if(!present)return;
 for(const role of [runtime,account])for(const field of ['sessions_install_binding_version','sessions_authority_generation'])for(const p of ['INSERT','UPDATE'])
  assert.equal((await one(h,"SELECT pg_catalog.has_column_privilege($1,'public.app_attest_keys',$2,$3) AS allowed",[role,field,p])).allowed,false,role+':'+field+':'+p);
}
async function runCases(caseTest,make){
 // FIRST discriminating case: no read/import of 035 outside the actual registry.
 // Applying this unchanged test to 5b12 builds the real historical restricted
 // caller and reaches AccountStore.delete's 42501, rather than ENOENT/import red.
 for(const config of [{metadata:false,footprint:'minimal'},{metadata:true,footprint:'minimal'},
  {metadata:true,footprint:'observed'},{metadata:true,footprint:'observed',known:true}])
 await caseTest('actual registered migrator -> populated restricted AccountStore.delete success '+JSON.stringify(config),async t=>{
  const h=await make(t);await schema(h,config);const f=await seed(h,config),before=await image(h),trace=[];
  const a=await actual(h,f,{trace});assert.deepEqual(await a.run(),{deleted:true});
  const after=await image(h);assertDeleted(before,after,f);traceSuccess(trace,account);
  assert.equal(a.effects.appleRevoke,1);assert.deepEqual(a.effects.cleanup,[['spotify-0','spotify-1']]);
  await metadataWithheld(h);await narrow(h,true);
 });
 for(const rate of ['matching','nonmatching','empty'])await caseTest('historical registry actual restricted delete reaches exact 42501 and populated rollback; '+rate,async t=>{
  const h=await make(t);await schema(h,{historical:true,metadata:true,footprint:'observed'});
  const f=await seed(h,{metadata:true,rate}),before=await image(h),trace=[];const a=await actual(h,f,{trace});
  await narrow(h,false);await assert.rejects(a.run(),permission);assert.deepEqual(await image(h),before);
  assert.ok(trace.some(e=>e.text?.startsWith('DELETE FROM listening_rooms')));
  assert.ok(trace.some(e=>e.text?.startsWith('UPDATE listening_rooms')));
  assert.equal(trace.at(-1).event,'ROLLBACK');assert.equal(a.effects.appleRevoke,1);assert.deepEqual(a.effects.cleanup,[]);
  for(const e of trace.filter(e=>e.text))assert.equal(e.currentUser,account);
 });
 await caseTest('original owner positive control remains separate from restricted qualification',async t=>{
  const h=await make(t);await schema(h,{historical:true,metadata:true});const f=await seed(h,{metadata:true,known:true}),before=await image(h),trace=[];
  const a=await actual(h,f,{owner:true,trace});assert.deepEqual(await a.run(),{deleted:true});assertDeleted(before,await image(h),f);traceSuccess(trace,null);
 });
 await caseTest('035 exact populated ACL delta, no rewrite, repeat and remove-only-new-column actual-method regression',async t=>{
  const h=await make(t);await schema(h,{historical:true,metadata:true,footprint:'observed'});const f=await seed(h,{metadata:true});
  const before=await image(h),old=await acl(h),auth=await narrow(h,false);
  const physical=async()=>(await h.query('SELECT user_id,bucket,ctid::text AS ctid,xmin::text AS xmin FROM public.listening_rate_windows ORDER BY user_id,bucket')).rows;
  const tuples=await physical();await h.query(body(await sqlFile(correction)));const next=await acl(h);
  const delta=next.filter(r=>!old.some(o=>JSON.stringify(o)===JSON.stringify(r)));
  assert.equal(delta.length,1);assert.equal(delta[0].nspname,'public');assert.equal(delta[0].relname,'listening_rate_windows');assert.equal(delta[0].scope,'column');
  assert.equal(delta[0].column_name,'user_id');assert.equal(delta[0].grantee,(await one(h,'SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1',[account])).oid);
  assert.equal(delta[0].privilege_type,'SELECT');assert.equal(delta[0].is_grantable,false);
  assert.deepEqual(next.filter(r=>!delta.includes(r)),old);assert.deepEqual(await authority(h),auth);
  await narrow(h,true);await metadataWithheld(h);await h.query(body(await sqlFile(correction)));assert.deepEqual(await acl(h),next);
  assert.deepEqual(await image(h),before);assert.deepEqual(await physical(),tuples);
  await h.query('REVOKE SELECT(user_id) ON public.listening_rate_windows FROM '+account);await narrow(h,false);
  const a=await actual(h,f);await assert.rejects(a.run(),permission);assert.deepEqual(await image(h),before);
  await h.query(body(await sqlFile(correction)));const good=await actual(h,f);assert.deepEqual(await good.run(),{deleted:true});assertDeleted(before,await image(h),f);
 });
 for(const fault of ['last-SQL-failure','unexpected-exact-session','session-deadline','credential-deadline','metadata-drift'])
 await caseTest('after successful scrub/persist actual final failure rolls back the entire populated SQL image; '+fault,async t=>{
  const h=await make(t);await schema(h,{metadata:true,footprint:'observed'});const f=await seed(h,{metadata:true,known:true});
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
    if(fault==='metadata-drift')await raw.query('UPDATE public.app_attest_keys SET sessions_authority_generation=sessions_authority_generation+1 WHERE key_id=$1',[f.keys[0]]);
    else await raw.query("INSERT INTO public.app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",[sha(f.bearers[0]),f.keys[0],f.credentials[0],policy.audience]);
   });
  }});
  await assert.rejects(a.run(),fault==='last-SQL-failure'?e=>e.code==='spotify_revocation_unavailable':{code:'app_access_revoked'});
  assert.equal(injected,true);assert.ok(trace.some(e=>e.text?.startsWith('DELETE FROM listening_rate_windows')));
  assert.ok(trace.some(e=>e.text?.startsWith('UPDATE spotify_connections')));
  assert.equal(trace.at(-1).event,'ROLLBACK');assert.deepEqual(await image(h),before);assert.deepEqual(a.effects.cleanup,[]);assert.equal(a.effects.appleRevoke,1,'external Apple revoke is recorded, never asserted rolled back');
  await metadataWithheld(h);
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
  await assert.rejects(migrateLibrary(h.migrator({failReceipt:correction})),{code:'injected_035_receipt_failure'});
  assert.deepEqual(await image(h),before);assert.deepEqual(await acl(h),old);await narrow(h,false);
  assert.deepEqual(await migrateLibrary(h.migrator()),[correction]);await narrow(h,true);
  const receipts=(await h.query('SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations ORDER BY name')).rows;
  assert.deepEqual(receipts.map(r=>r.name),migrationNames);for(const r of receipts)assert.equal(r.sha256,sha(await sqlFile(r.name)));
  assert.deepEqual(await migrateLibrary(h.migrator()),[]);assert.deepEqual((await h.query('SELECT name,sha256,applied_at::text AS applied_at FROM public.library_schema_migrations ORDER BY name')).rows,receipts);
  await h.query("UPDATE public.library_schema_migrations SET sha256='changed' WHERE name=$1",[correction]);
  const changed=await image(h);await assert.rejects(migrateLibrary(h.migrator()),{code:'migration_changed'});assert.deepEqual(await image(h),changed);
  assert.equal((await one(h,"SELECT to_regnamespace('listening_v2')::text AS name")).name,null);
  assert.ok(!migrationNames.some(n=>/^(030|031|033|034)-/.test(n)));
 });
 await caseTest('role absence creates no role; genuinely late-after-all-receipts remains source-writer negative',async t=>{
  const h=await make(t,{roles:false});await schema(h,{metadata:true});const f=await seed(h,{metadata:true});const before=await image(h),roles=await authority(h);
  assert.equal(roles.roles.some(r=>[account,runtime].includes(r.rolname)),false);
  await h.query(body(await sqlFile(correction)));assert.deepEqual(await authority(h),roles);assert.deepEqual(await image(h),before);
  await h.createRoles();const calls=[];await replayMembershipRoleGrants({query:async text=>{calls.push(text);return h.query(text);}});assert.equal(calls.length,1);
  // No invisible 027/029 repair and no role inheritance in this genuine writer path.
  for(const relation of ['spotify_connections','spotify_snapshot_capabilities','spotify_outbox','listening_rooms'])assert.equal((await one(h,'SELECT pg_catalog.has_table_privilege($1,$2,\'SELECT\') AS allowed',[account,'public.'+relation])).allowed,false,relation);
  assert.equal((await one(h,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows','user_id','SELECT') AS allowed",[account])).allowed,true);
  assert.equal((await one(h,"SELECT pg_catalog.has_table_privilege($1,'public.listening_rate_windows','DELETE') AS allowed",[account])).allowed,false);
  const lateBefore=await image(h),a=await actual(h,f);await assert.rejects(a.run(),{code:'spotify_revocation_unavailable'});assert.deepEqual(await image(h),lateBefore);assert.deepEqual(a.effects.cleanup,[]);await metadataWithheld(h);
 });
 await caseTest('fresh runner failure before 035 receipt rolls schema and grants back together',async t=>{
  const h=await make(t),old=await authority(h);
  await assert.rejects(migrateLibrary(h.migrator({failReceipt:correction})),{code:'injected_035_receipt_failure'});
  assert.deepEqual(await one(h,"SELECT to_regclass('public.library_users')::text AS users,to_regclass('public.library_schema_migrations')::text AS receipts"),{users:null,receipts:null});
  assert.deepEqual(await authority(h),old);
  assert.deepEqual(await migrateLibrary(h.migrator()),migrationNames);await narrow(h,true);
 });
 await caseTest('late replay with EXPLICIT independently established historical 027/029 prerequisites can delete',async t=>{
  const h=await make(t,{roles:false});await schema(h,{metadata:true});const f=await seed(h,{metadata:true});await h.createRoles();
  // This is a separate compatible footprint, NEVER the genuine source-writer
  // negative above. Establish and label the actual omitted old prerequisites.
  for(const name of ['027-spotify-background.sql','029-listening-sessions.sql']){
   const blocks=(await sqlFile(name)).match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g);assert.equal(blocks.length,1);await h.query(blocks[0]);
  }
  await replayMembershipRoleGrants(h);await metadataWithheld(h);await narrow(h,true);
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
 for(const change of malformedChanges)await caseTest('035 refuses malformed optional schema atomically: '+change,async t=>{
  const h=await make(t);await schema(h,{historical:true});await seed(h);const before=await image(h),old=await acl(h);
  const indexBefore=await one(h,"SELECT pg_get_indexdef('public.listening_members'::regclass) AS definition");
  await assert.rejects(h.tx(null,async raw=>{await raw.query(change);await raw.query(body(await sqlFile(correction)));}),malformed);
  assert.deepEqual(await image(h),before);assert.deepEqual(await acl(h),old);
  assert.deepEqual(await one(h,"SELECT pg_get_indexdef('public.listening_members'::regclass) AS definition"),indexBefore);
 });
 await caseTest('035 hostile search_path and shadows remain untouched, direct and replay repeat',async t=>{
  const h=await make(t);await schema(h,{historical:true,metadata:true});await seed(h,{metadata:true});const before=await image(h);
  await h.query('CREATE SCHEMA delete_shadow');
  for(const table of ['listening_rooms','listening_commands','listening_outbox','listening_rate_windows'])await h.query('CREATE TABLE delete_shadow.'+table+'(marker text)');
  await h.tx(null,async raw=>{
   await raw.query('SET LOCAL search_path=delete_shadow,public,pg_catalog');
   await raw.query(body(await sqlFile(correction)));await raw.query(body(await sqlFile(correction)));
   await replayMembershipRoleGrants(raw);
   assert.equal((await one(raw,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows','user_id','SELECT') AS allowed",[account])).allowed,true);
   assert.equal((await one(raw,"SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='delete_shadow' AND (c.relacl IS NOT NULL OR a.attacl IS NOT NULL)")).n,0);
  });
  assert.deepEqual(await image(h),before);await metadataWithheld(h);
 });
 await caseTest('one atomic replay statement: after-new-grant 034 refusal rolls back new and prior replay rights',async t=>{
  const h=await make(t);await schema(h,{historical:true,metadata:true,footprint:'observed'});await seed(h,{metadata:true});
  await h.query('REVOKE UPDATE(disabled) ON public.library_users FROM '+account);
  const before=await image(h),old=await acl(h),calls=[];
  await assert.rejects(h.tx(null,async raw=>{
   await raw.query('ALTER TABLE public.app_attest_keys DROP CONSTRAINT app_attest_keys_sessions_binding_version');
   await replayMembershipRoleGrants({query:async text=>{calls.push(text);return raw.query(text);}});
  }),e=>e.code==='23514'&&e.message.includes('v2_install_privilege_catalog_mismatch'));
  assert.equal(calls.length,1);assert.match(calls[0],/^DO \$membership_role_replay\$\nBEGIN\n/);
  assert.ok(calls[0].indexOf('GRANT SELECT (user_id) ON TABLE public.listening_rate_windows')<calls[0].indexOf('v2_install_privilege_catalog_mismatch'));
  for(const name of ['025-memberships.sql','028-selected-lyrics-learning.sql','032-auth-token-row-locks.sql']){
   const block=(await sqlFile(name)).match(/DO \$\$ (BEGIN[\s\S]*?END) \$\$;/g).filter(s=>s.includes('pg_roles')&&s.includes('GRANT '));assert.equal(block.length,1);
   assert.ok(calls[0].includes(block[0].slice('DO $$ '.length,-' $$;'.length)+';'));
  }
  assert.doesNotMatch(calls[0],/\b(?:ALTER TABLE|CREATE (?:TABLE|SCHEMA|ROLE)|INSERT INTO|DELETE FROM|TRUNCATE)\b/);
  assert.deepEqual(await acl(h),old);assert.deepEqual(await image(h),before);await narrow(h,false);await metadataWithheld(h);
 });
 for(const kind of ['PUBLIC','inherited','owner','owner-membership-NOINHERIT','superuser'])await caseTest('unchanged 034 residual metadata authority refusal remains atomic: '+kind,async t=>{
  const h=await make(t);await schema(h,{historical:true,metadata:true,footprint:'observed'});await seed(h,{metadata:true});const before=await image(h),old=await acl(h),authorityBefore=await authority(h);
  await assert.rejects(h.tx(null,async raw=>{
   if(kind==='PUBLIC')await raw.query('GRANT UPDATE(sessions_authority_generation) ON public.app_attest_keys TO PUBLIC');
   if(kind==='inherited'){
    const donor='delete_donor_'+randomUUID().replaceAll('-','');
    await raw.query('CREATE ROLE '+donor+' NOLOGIN NOSUPERUSER');
    await raw.query('GRANT UPDATE(sessions_authority_generation) ON public.app_attest_keys TO '+donor);
    await raw.query('ALTER ROLE '+account+' INHERIT');await raw.query('GRANT '+donor+' TO '+account);
   }
   if(kind==='owner'){await raw.query('GRANT CREATE ON SCHEMA public TO '+account);await raw.query('ALTER TABLE public.app_attest_keys OWNER TO '+account);}
   if(kind==='owner-membership-NOINHERIT'){
    const owner=(await one(raw,'SELECT session_user AS owner')).owner;assert.match(owner,/^[A-Za-z_][A-Za-z0-9_]*$/);
    await raw.query('GRANT "'+owner+'" TO '+account);await raw.query('ALTER ROLE '+account+' NOINHERIT');
    assert.equal((await one(raw,"SELECT pg_catalog.pg_has_role($1,$2,'MEMBER') AS member",[account,owner])).member,true);
   }
   if(kind==='superuser')await raw.query('ALTER ROLE '+account+' SUPERUSER');
   await replayMembershipRoleGrants(raw);
  }),e=>e.code==='23514'&&e.message.includes('v2_install_metadata_residual_privilege'));
  assert.deepEqual(await acl(h),old);assert.deepEqual(await image(h),before);assert.deepEqual(await authority(h),authorityBefore);await metadataWithheld(h);
 });
}

test('manual PostgreSQL restricted account-delete privilege matrix',{timeout:90000},async t=>{
 const marker=await preflight(); // Refuse before pg or behavioral imports.
 const {default:pg}=await import('pg');
 ({AccountStore}=await import('../../api/utils/membership/accounts.js'));
 ({AppAuthStore}=await import('../../api/utils/app-auth/store.js'));
 ({migrateLibrary,migrationNames}=await import('../../scripts/library-migrations.js'));
 ({replayMembershipRoleGrants}=await import('../../scripts/membership-role-grants.js'));
 const tag='lyrica-account-delete:'+randomUUID().replaceAll('-',''),roles=[account,runtime],ownedRoles=[],databases=new Set(),errors=[];
 const config={host:marker.socketDirectory,port:marker.port,user:marker.user,password:'',ssl:false,
  connectionTimeoutMillis:3000,statement_timeout:8000,lock_timeout:3000,idle_in_transaction_session_timeout:15000,options:'-c timezone=UTC',application_name:tag};
 const admin=new pg.Client({...config,database:'postgres'});let connected=false,lease=false,counter=0;
 const aggregate=es=>es.length===1?es[0]:new AggregateError(es,'scenario/cleanup failure');
 async function checkRole(r){
  const row=await one(admin,"SELECT oid,rolname,rolsuper,rolcanlogin,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,shobj_description(oid,'pg_authid') AS marker FROM pg_catalog.pg_roles WHERE rolname=$1",[r.name]);
  assert.deepEqual(row,{oid:r.oid,rolname:r.name,rolsuper:false,rolcanlogin:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,marker:tag});
  assert.deepEqual((await admin.query('SELECT roleid,member FROM pg_catalog.pg_auth_members WHERE roleid=$1 OR member=$1',[r.oid])).rows,[]);
 }
 async function createRoles(){
  assert.deepEqual((await admin.query('SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows,[],'never adopt preexisting fixed role names');
  for(const name of roles){
   await admin.query('CREATE ROLE '+name+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
   const r={name,oid:(await one(admin,'SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1',[name])).oid};ownedRoles.push(r);
   await admin.query("COMMENT ON ROLE "+name+" IS '"+tag+"'");await checkRole(r);
  }
 }
 async function dropRoles(){for(const r of [...ownedRoles].reverse()){await checkRole(r);await admin.query('DROP ROLE '+r.name);ownedRoles.splice(ownedRoles.indexOf(r),1);}}
 async function dispose(h){
  const es=[];
  for(const client of [...h.clients]){try{await client.query('ROLLBACK');await client.end();h.clients.delete(client);}catch(e){es.push(e);}}
  if(h.created&&h.clients.size===0){
   try{const row=await one(admin,"SELECT oid,datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,shobj_description(oid,'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=$1",[h.name]);
    assert.equal(row.owned,true);if(h.oid!==null)assert.equal(row.oid,h.oid);assert.equal(row.marker,h.tagged?tag:null);
    assert.deepEqual((await admin.query('SELECT pid FROM pg_catalog.pg_stat_activity WHERE datid=$1',[row.oid])).rows,[],'refuse foreign or undrained sessions');
    await admin.query('DROP DATABASE '+h.name);h.created=false;databases.delete(h);
   }catch(e){es.push(e);}
  }
  if(es.length)throw aggregate(es);
 }
 async function make(sub,{roles:withRoles=true}={}){
  const h={name:'lyrica_delete_'+randomUUID().replaceAll('-',''),created:false,tagged:false,oid:null,clients:new Set()};databases.add(h);
  // Register cleanup before role creation, CREATE DATABASE or any assertion.
  sub.after(async()=>{const es=[];try{await dispose(h);}catch(e){es.push(e);}if(!h.created)try{await dropRoles();}catch(e){es.push(e);}if(es.length)throw aggregate(es);});
  if(withRoles)await createRoles();
  await admin.query("CREATE DATABASE "+h.name+" TEMPLATE template0 ENCODING 'UTF8'");h.created=true;
  h.oid=(await one(admin,'SELECT oid FROM pg_catalog.pg_database WHERE datname=$1',[h.name])).oid;
  await admin.query("COMMENT ON DATABASE "+h.name+" IS '"+tag+"'");h.tagged=true;
  h.connect=async()=>{const client=new pg.Client({...config,database:h.name});h.clients.add(client);await client.connect();return client;};
  h.close=async client=>{await client.end();h.clients.delete(client);};
  h.tx=async(role,fn,{trace=[],beforeSQL,afterSQL}={})=>{
   const client=await h.connect();const es=[];let value;
   try{await client.query('BEGIN');if(role)await client.query('SET LOCAL ROLE '+role);trace.push({event:'BEGIN'});
    const tx={query:async(text,args=[])=>{
     const who=await one(client,'SELECT current_user AS role,session_user AS owner');assert.equal(who.role,role??who.owner);
     trace.push({text,currentUser:who.role,sessionUser:who.owner});if(beforeSQL)await beforeSQL(text,client,args);
     const result=await client.query(text,args);
     if(text==="SET LOCAL lock_timeout='5s'")await client.query("SET LOCAL lock_timeout='3s'");
     if(afterSQL)await afterSQL(text,client,args,result);return result;
    }};
    value=await fn(tx);await client.query('COMMIT');trace.push({event:'COMMIT'});
   }catch(e){es.push(e);try{await client.query('ROLLBACK');trace.push({event:'ROLLBACK'});}catch(e){es.push(e);}}
   finally{try{await h.close(client);}catch(e){es.push(e);}}
   if(es.length)throw aggregate(es);return value;
  };
  h.query=(text,args=[])=>h.tx(null,tx=>tx.query(text,args));
  h.adapter=(role,options={})=>({query:(text,args=[])=>h.tx(role,tx=>tx.query(text,args),options),transaction:fn=>h.tx(role,fn,options)});
  h.migrator=({failReceipt}={})=>({transaction:fn=>h.tx(null,tx=>fn({query:async(text,args=[])=>{
   if(failReceipt&&text.startsWith('INSERT INTO library_schema_migrations')&&args[0]===failReceipt)throw Object.assign(new Error('injected_035_receipt_failure'),{code:'injected_035_receipt_failure'});
   return tx.query(text,args);
  }}))});
  h.createRoles=createRoles;
  h.ownerInjection=async(raw,fn)=>{await raw.query('RESET ROLE');try{await fn();}finally{await raw.query('SET LOCAL ROLE '+account);}assert.equal((await one(raw,'SELECT current_user AS role')).role,account);};
  return h;
 }
 try{
  await admin.connect();connected=true;
  assert.deepEqual(await one(admin,'SELECT current_database() AS database,current_user AS owner,session_user AS session_owner,inet_server_addr() IS NULL AND inet_client_addr() IS NULL AS unix_only'),{database:'postgres',owner:marker.user,session_owner:marker.user,unix_only:true});
  assert.equal((await one(admin,'SHOW listen_addresses')).listen_addresses,'');assert.equal(await realpath((await one(admin,'SHOW data_directory')).data_directory),await realpath(marker.dataDirectory));
  assert.equal((await one(admin,'SELECT system_identifier::text AS id FROM pg_control_system()')).id,marker.systemIdentifier);
  assert.equal(Number((await one(admin,'SHOW port')).port),marker.port);assert.equal((await one(admin,'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user')).rolsuper,true);
  assert.equal((await one(admin,'SHOW fsync')).fsync,'on');assert.equal((await one(admin,'SHOW synchronous_commit')).synchronous_commit,'on');assert.equal((await one(admin,'SHOW TimeZone')).TimeZone,'UTC');
  assert.ok(Number((await one(admin,'SHOW server_version_num')).server_version_num)>=170000);
  lease=(await one(admin,'SELECT pg_try_advisory_lock(71309,32026) AS owned')).owned;assert.equal(lease,true);
  t.diagnostic(JSON.stringify({sourceCommit:marker.sourceCommit,serverVersion:(await one(admin,'SHOW server_version')).server_version,scope:'synthetic local restricted callers; no deployment/provider/native qualification'}));
  await runCases((name,fn)=>t.test(name,fn),make);
  await t.test('standalone pg.Client and existing transaction replay: independent-client visibility and after-grant failure',async sub=>{
   const h=await make(sub);await schema(h,{historical:true,metadata:true,footprint:'observed'});const f=await seed(h,{metadata:true});
   const read=()=>one(h,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows','user_id','SELECT') AS allowed",[account]);
   const withheld=async()=>{
    await metadataWithheld(h);
    for(const role of [account,runtime])await assert.rejects(h.adapter(role).query('UPDATE public.app_attest_keys SET sessions_authority_generation=sessions_authority_generation+1 WHERE key_id=$1',[f.keys[0]]),{code:'42501'});
   };
   const client=await h.connect(),pid=(await one(client,'SELECT pg_backend_pid() AS pid')).pid;let count=0;
   try{
    await replayMembershipRoleGrants({query:async text=>{
     const result=await client.query(text);count++;
     assert.notEqual((await one(h,'SELECT pg_backend_pid() AS pid')).pid,pid);assert.equal((await read()).allowed,true);await withheld();return result;
    }});assert.equal(count,1);
    await h.query('REVOKE SELECT(user_id) ON public.listening_rate_windows FROM '+account);
    await client.query('BEGIN');
    try{await replayMembershipRoleGrants(client);assert.equal((await one(client,"SELECT pg_catalog.has_column_privilege($1,'public.listening_rate_windows','user_id','SELECT') AS allowed",[account])).allowed,true);assert.equal((await read()).allowed,false);await withheld();await client.query('COMMIT');}
    catch(e){await client.query('ROLLBACK');throw e;}
    assert.equal((await read()).allowed,true);await withheld();
    for(const mode of ['autocommit','existing-transaction']){
     await h.query('REVOKE SELECT(user_id) ON public.listening_rate_windows FROM '+account);
     await h.query('REVOKE UPDATE(disabled) ON public.library_users FROM '+account);
     // Persist a deliberately malformed 034 catalog BEFORE the helper. Its
     // refusal is after 035's grant in the same outer DO; no split commit.
     await h.query('ALTER TABLE public.app_attest_keys DROP CONSTRAINT app_attest_keys_sessions_binding_version');
     const old=await acl(h),before=await image(h);if(mode==='existing-transaction')await client.query('BEGIN');
     try{await assert.rejects(replayMembershipRoleGrants(client),e=>e.code==='23514'&&e.message.includes('v2_install_privilege_catalog_mismatch'));}
     finally{if(mode==='existing-transaction')await client.query('ROLLBACK');}
     assert.deepEqual(await acl(h),old);assert.deepEqual(await image(h),before);assert.equal((await read()).allowed,false);await withheld();
     await h.query('ALTER TABLE public.app_attest_keys ADD CONSTRAINT app_attest_keys_sessions_binding_version CHECK(sessions_install_binding_version=1)');
    }
   }finally{await client.query('ROLLBACK');await h.close(client);}
  });
 }catch(e){errors.push(e);}
 finally{
  for(const h of [...databases])try{await dispose(h);}catch(e){errors.push(e);}
  if(connected){if(databases.size===0)try{await dropRoles();}catch(e){errors.push(e);}if(lease)try{await admin.query('SELECT pg_advisory_unlock(71309,32026)');}catch(e){errors.push(e);}}
  try{await admin.end();}catch(e){errors.push(e);}
 }
 if(errors.length)throw aggregate(errors);
});
