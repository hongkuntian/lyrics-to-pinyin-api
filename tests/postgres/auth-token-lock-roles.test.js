import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const migration='032-auth-token-row-locks.sql',runtime='lyra_runtime_v1',account='lyra_account_v1';
const runID=randomUUID().replaceAll('-',''),provenance=`lyrica-auth-token-lock:${runID}`;
const names=name=>`lyrica-token-${runID.slice(0,12)}-${name}`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const sourcePins={
 "api/processors/base.js": "66902bafa3238e4ff0848a7e7e8290d2ac5bcb75eb3942eafc6cc2d46ce00361",
 "api/processors/cantonese.js": "6d509e194a9c7dc49604ce31af42f95cbd87af0b3f4dff968ff5bee806bedfbf",
 "api/processors/chinese.js": "7440066fd424b922a9658df9efe332325c6e6ce34688159fdb0077c12ac2991c",
 "api/processors/index.js": "4bdb6872d4fafb90395ea04d5b481022a0ce3d596922b17aa78137dbd08b2dfb",
 "api/processors/japanese.js": "6a987aaa76e9e3a8a5516fc04c6ac61792e0c099b7f9f8b7c7231d7e9b4af28a",
 "api/processors/korean.js": "b2bd8eb25881412f820ad1a042eb2210578f16bf82519b7281235fb207f1f5e0",
 "api/processors/russian.js": "676d886fe13f937416883510a774f6abb37224f05692d409a9eb77802265292b",
 "api/utils/app-auth/admin.js": "c761e922197537e01da90b46021c4a8836275aadb33291e8722d96b2a0e30996",
 "api/utils/app-auth/store.js": "2692755072094fb0907dd0721396c38f0190cf0a595f2c40dd16400f7dbbc6aa",
 "api/utils/app-auth/verification.js": "203e2e2a59706162e8987320b57be12a4dbf98d3784fce5b4298099f0a848995",
 "api/utils/artist-alias-recovery.js": "3923f42d71751faf06f458674418c4159288865efd9b2ce0ae9d68c23e87cba0",
 "api/utils/language-detection.js": "5f617664f96fdf7b3aa0ce2bad6e33dde5a8b0594b247cd89a21fcfaef986c32",
 "api/utils/lyric-annotations.js": "ef8dba6edf66b7ff8fff15480501d3f268f86be979799c4b3efefdf16025e9b1",
 "api/utils/lyric-language.js": "ec0430b309c243d8f29c7a308969168672e726c3401709ef689f77ce5b91ce1d",
 "api/utils/lyric-notices.js": "81a09582bd460a94115518f243e8f964110baec31b13a67df351ec7730e55bde",
 "api/utils/lyric-quality.js": "c7ddea52aa758f02d8aa16ad15b645d2f28c0ccda9102bec77dc24f73c983f29",
 "api/utils/lyric-selection.js": "d0c80e76cd0916779edcb09b49712c5487c65f098399eaa4d331744eafc4048f",
 "api/utils/membership/accounts.js": "15a7fa51080bb68081a193c7e4c7c0bd72126ecf602b796518b21ecc473465ab",
 "api/utils/membership/device-check.js": "54d74516eccb46cb24761f138c4603cdf16d138c63c3f326b9a7466c28a19868",
 "api/utils/membership/policy.js": "6c1b4108727491797ce9a65156cb9e18ba8e48818aaba477b1b1fa69e25a47c5",
 "api/utils/membership/store.js": "34e73488f3e8d88b1cd0007a73771c3383318dd02f5c8b500ab300b172a63d9b",
 "api/utils/netease-title-evidence.js": "ec2ded79cb5734d2be40113f3cd7077241b5a41e032750f875d1b82d341d4fae",
 "api/utils/pronunciation-aids.js": "0f7c0e1fb45010210ad0098f58e52757e6cda8d30eea415d8b3c5c2b58b6b74c",
 "api/utils/recording-match.js": "f20196665ed00e9469f8f3b681ba2b26f76a8ef0d39b6dc7adebca233ba8179b",
 "api/utils/recording-script.js": "4f505253efcaceb04ba2b63af2df498c9be346f340b9ccbdd54283d8c167a666",
 "api/utils/rejected-lyrics.js": "01297cb109616c43da5d6381287b7e6111b9cf2a14703c99d2883671b92664f9",
 "api/utils/song-library/apple-vocal-timing.js": "67b5570328fcd6a2954c8a3c2f3e20b630234529a4a4e82e04ef5ca5cd733d24",
 "api/utils/song-library/database.js": "e537fc85e5d1f09638c4887a4a1951a3d982220c7a3a0067b378fcfdc044272e",
 "api/utils/song-library/languages.js": "3489ba02f532998d95896da9f3beec00620d6ac2798a683689de54994ed7fe58",
 "api/utils/song-library/model-context.js": "4de1a67ef866aab10e7b9417a71a8f5904417d9477f7463a60757d77b635a397",
 "api/utils/song-library/model-policy.js": "5dbd33b0cf6a556f11820e962d1cc890fa4103743995748b686bde22dded632c",
 "api/utils/song-library/revisions.js": "809e8132b0813efc4274b41fa7dcf4ed3f698d145fc68a4ee3306fcdaccd8012",
 "api/utils/song-library/selected-source.js": "fe993072bd8163ceca045e9f68c291f05d9bc8f12a4e8bca299831d7be25ad80",
 "api/utils/song-library/spending.js": "4f392c103c4d63c7fff2d98638c131da0419babd3ea269053765ffc635f3d236",
 "api/utils/song-library/spotify-recording.js": "ea733865ea2f5ed50dba8c4f5d3f9225eefb8f2d949b0468c33e010fe3b71781",
 "api/utils/song-library/store.js": "1a10a7dfc7a8c5e971047330b7b4211395b2950dbedbd71fd81a75068b6ba618",
 "api/utils/song-library/translation-identity.js": "7bba350b842eb301b970d4858ab8cbca98aadd2820397a3404d7e1448452895e",
 "api/utils/song-library/translation-reuse.js": "32067bf9dbb392f0645727d5380a2e5eadfba98aaee77fe4a448408177533d4a",
 "api/utils/song-library/translation-source.js": "050bdc5035a73aff19efbba73b29d767f798797c7851b6921e65eb121389a95a",
 "api/utils/song-library/translation.js": "d7386398269f0cea0f9e8df11adb9c362d6135922ea4ec6b5b04e0e874da87d0",
 "api/utils/vocal-timing.js": "7bc05fae8cb02f5d406088dc262622fb310d07e602553357eb1c488feb347e81",
 "db/001-song-library.sql": "f1386620cf96a317ccb76f03593f74d5b2fe21150bd7ec8a6858dac853c42fd3",
 "db/002-dashboard-views.sql": "221eba47bf1bf05a90e6d49e6cd64a944c66fca0a13c9bc6318c5be487f1c2a3",
 "db/003-correction-foundation.sql": "ef52d21ef6d6a8c1221c139ff6dbae8c075515637f2ee596534a81891266630e",
 "db/004-correction-dashboard.sql": "7f78506bc39f5fa437eeeda4322b2fa7d9bf584d6230c5400a63cb3638c2894b",
 "db/005-correction-batches.sql": "e751730197e1109b0ec2593faf5dc378baf00578d55633a9a77704362c78a507",
 "db/006-batch-dashboard.sql": "f49c6bfde322027a3b2a6fc41bf227b52d0a0db22954cd840ffde09a164e6835",
 "db/007-correction-publication.sql": "eb9263e4b5d52f266a02a79f0ff06f613fabf270cf5f1230078aa148948a77ed",
 "db/008-publication-dashboard.sql": "1755dea90d0338d7aacec039901f6707e43d1fb028936b6ec20f1bd4d412b1b7",
 "db/009-study-explanations.sql": "2d3326a97246ad0ee2015a2843c57d076b70392c4bc9f94d4afd7cd11150a0ef",
 "db/010-dashboard-controls.sql": "5cdee6aaebb5290221efda316745775817056fed897c156066ffa3b39f142eab",
 "db/011-operational-alerts.sql": "8238d5e613ad5f05999ef9b651d05597e6ef772e6a494bc2b3676d61a64cfa6b",
 "db/012-multilingual-content.sql": "3b4438417159e06e85c2c114e0b4c8acc5f8be537e100dc7f15b1fb1b51d307f",
 "db/013-pronunciation-aids.sql": "10433ac0a88a54e50ebf834ad21dbab01088ee24c8cd3a2dc5778afdc1581e0b",
 "db/014-lyric-source-refresh.sql": "0fd218163ca0b755ad979d25ae2ff526230969e9d7e2bb873cae6dd91a0da554",
 "db/015-gpt6-luna.sql": "f69cdb06e342c3d069da02be420e573d5e2cc88b91be6be7c8f5adfa8248fb9a",
 "db/016-personal-unlimited-access.sql": "1256ad7d4854a4999483db51c9c8ca1f39c999cfa1a7e99a754e0850b32b5499",
 "db/017-translation-reuse.sql": "5f86f6bbc71b3ceccafccfaf6cdbcb2c4306a815c953bc65bfe6b5b8f85641fe",
 "db/018-translation-attempts.sql": "ce3c685c31ae85b4f4c6bbf12b7fa1ae6605b3d57ff6158a8e9a527a6f0da590",
 "db/019-translation-reuse-dashboard.sql": "7fb48cd33d9f307c7f1b01d1d20723d3ed9f6aa10c6f6422c34381f22a75e430",
 "db/020-catalog-recording-bindings.sql": "c12946ca4fe6b8da6e7df1ea51b80ab33869d46fc8ca78d763513304236c4de1",
 "db/021-app-auth.sql": "8f553ef1224c91537d37ebf73d9de759aa11967a3f5cff2a27e22ea318751071",
 "db/022-live-lyrics-push.sql": "279f34f35934607b4e7d40eb9d29c6f1821fa3b488abfd1910896d0e0ecbb2aa",
 "db/023-live-lyrics-runtime.sql": "c1b2bf6f4381d111cbb63b48073e52961f661e01799f43d75769de3248a90fb2",
 "db/024-live-lyrics-cleanup.sql": "a7e09318d6e9611e1884d874d250e89b5a8c10b98a19cb1c0667d8c4e98de8f4",
 "db/025-memberships.sql": "4dd6728c74dbb855e063dd8aa80590c02b0da653cfa0df36900933013c31e780",
 "db/026-spotify-recordings.sql": "021f00794aff62b6f1d33206790f83891dd6ea259f27dde685834beecd864256",
 "db/027-spotify-background.sql": "75bf8f52f2dad2fac88fb8af8d2af11e773fc1324e84a7577e92bdd8cf14aae5",
 "db/028-selected-lyrics-learning.sql": "010de0b73bf215dcd53d51b55f69a4e2943483d7aa948a574bbf1318d9f44966",
 "db/032-auth-token-row-locks.sql": "c19650a29438ebeea186203d954fee8e144a65ca6d42ad91bc38c18f1f7e5df6",
 "db/039-anonymous-accounts.sql": "9d20589ef9be723596db663cd3eee4c3f84b320deffa7dd4a6191e8a2e178ed1",
 "scripts/library-migrations.js": "b2bcfb3ea471555c048f9258b45f745f8ef56cbdfcda08cbbdd2ed0d1e40b422",
 "scripts/membership-role-grants.js": "6c92eaf3fb68a69c66d2d182afacebfce87cdf8ed5d9d98c659c2c9c95dd8117"
};
// Explicit changed-input pin refresh comes ONLY from Root's supplied clean
// immutable commit, never hashes accepted from the current working files.
const refreshPinPaths=["api/utils/app-auth/admin.js","api/utils/app-auth/store.js","api/utils/app-auth/auth-context.js","api/utils/app-auth/errors.js","api/utils/membership/accounts.js","api/utils/membership/account-data-privacy.js","api/utils/song-library/store.js","scripts/library-migrations.js","scripts/membership-role-grants.js","db/036-account-data-privacy.sql"];
const gitRoot=fileURLToPath(new URL('../../',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:gitRoot,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
const correction='036-account-data-privacy.sql',namespace='037-lyrica-namespace.sql',retirement='038-retire-spotify-observer.sql',anonymous='039-anonymous-accounts.sql',starters='040-starter-song-totals.sql';
const aclMetadataSHA256='7ee564f93b162fc2b75d6ed791622414c2e44449ff776cc61705644b433e1972';
const existingTokenFields=['digest','user_id','revoked','created_at','expires_at'];
const observed={
 app_attest_keys:['SELECT','INSERT','UPDATE'],
 app_auth_challenges:['SELECT','INSERT','UPDATE','DELETE'],
 app_auth_sessions:['SELECT','INSERT','UPDATE','DELETE'],
 library_settings:['SELECT'],library_tokens:['SELECT'],library_users:['SELECT'],membership_settings:['SELECT'],
 spotify_connections:['SELECT','INSERT','UPDATE','DELETE'],
 spotify_outbox:['SELECT','INSERT','UPDATE','DELETE'],
 spotify_snapshot_capabilities:['SELECT','INSERT','UPDATE','DELETE']
};
const observedUpdates={library_users:['auth_window','auth_count','refresh_window','refresh_count'],
 library_settings:['enabled','review_enabled'],membership_settings:['id']};
// 039 grants the runtime login EXECUTE on its bounded expiry slide. 039 names
// the post-037 role (lyrica_runtime_v1); this pre-037 fixture models that
// grant for lyra_runtime_v1 once 039 has created the function.
const observedFunctions=['public.slide_guest_credential_expiry(text)'];
// Columns 039 adds and the Sign in with Apple relation it drops.
const anonymousColumns=['library_users.app_account_token','library_users.free_allowance_held_until','membership_settings.relay_access'];
const policy={audience:'token-lock-pg-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
let pg,AppAuthStore,AccountStore,createCurrentAuthContext,migrateLibrary,migrateWithAnonymous,migrationNames,replayMembershipRoleGrants;
let admin,adminConnected=false,config,clusterLease=false;
const ownedRoles=[],databases=new Set();
const combine=(errors,label)=>errors.length===1?errors[0]:new AggregateError(errors,label);
const denied=promise=>assert.rejects(promise,{code:'42501'});
const drift=error=>error.code==='23514'&&/auth_token_lock_.*catalog_mismatch/.test(error.message);

async function manifest(){
 // Complete local-file validation precedes imports of application modules and
 // every connection attempt. No DATABASE_URL, password file or .env is read.
 const approved=process.env.LYRICA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT;
 assert.match(approved??'',/^[a-f0-9]{40}$/);assert.equal(git('rev-parse','HEAD'),approved);
 assert.equal(git('status','--porcelain=v1','--untracked-files=normal','--','.',':(exclude)node_modules'),'');
 git('merge-base','--is-ancestor','5b12df46048a212a56b8b0cc146a80492f49481f',approved);
 const path=process.env.LYRICA_TEST_POSTGRES_MANIFEST,uid=process.getuid();
 assert.ok(path&&isAbsolute(path),'explicit current-user-owned local manifest required');
 const file=await lstat(path);assert.ok(file.isFile()&&!file.isSymbolicLink());assert.equal(file.uid,uid);
 assert.equal(file.mode&0o077,0,'manifest must be private');
 const marker=JSON.parse(await readFile(path,'utf8'));
 assert.equal(marker.purpose,'lyrica-auth-local-qualification');assert.equal(marker.ownerUID,uid);
 assert.equal(marker.active,true);assert.equal(marker.TCPListening,false);
 assert.match(marker.socketDirectory,/^\/tmp\/lyrica-auth-pg-[A-Za-z0-9_-]+$/);
 const socket=await lstat(marker.socketDirectory);
 assert.ok(socket.isDirectory()&&!socket.isSymbolicLink());assert.equal(socket.uid,uid);assert.equal(socket.mode&0o077,0);
 assert.ok(isAbsolute(marker.dataDirectory));
 const data=await lstat(marker.dataDirectory);
 assert.ok(data.isDirectory()&&!data.isSymbolicLink());assert.equal(data.uid,uid);assert.equal(data.mode&0o077,0);
 assert.ok(Number.isInteger(marker.port)&&marker.port>1024&&marker.port<65536);
 assert.ok(typeof marker.user==='string'&&marker.user.length>0);
 for(const [path,expected] of Object.entries(sourcePins))if(!refreshPinPaths.includes(path))
  assert.equal(sha(await readFile(new URL('../../'+path,import.meta.url))),expected,'immutable source: '+path);
 for(const path of refreshPinPaths){
  const expected=sha(execFileSync('git',['show',approved+':'+path],{cwd:gitRoot,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}));
  assert.equal(sha(await readFile(new URL('../../'+path,import.meta.url))),expected,'Root-approved refreshed source: '+path);
 }
 return marker;
}
async function connect(){
 const marker=await manifest();
 ({default:pg}=await import('pg'));
 ({AppAuthStore}=await import('../../api/utils/app-auth/store.js'));
 ({AccountStore}=await import('../../api/utils/membership/accounts.js'));
 ({createCurrentAuthContext}=await import('../../api/utils/app-auth/auth-context.js'));
 const registered=await import('../../scripts/library-migrations.js');migrationNames=registered.migrationNames;
 // The historical 032 prefix (late replay/drift) never applies 036-040. The
 // restricted-method scenarios add 039, which session issuance now needs
 // (slide_guest_credential_expiry); 036-038 and 040 (starter-song totals,
 // unused by auth) stay outside this pre-037 fixture.
 const through=excluded=>async database=>{
  const saved=[...migrationNames];migrationNames.splice(0,migrationNames.length,...saved.filter(n=>!excluded.includes(n)));
  try{return await registered.migrateLibrary(database);}
  finally{migrationNames.splice(0,migrationNames.length,...saved);}
 };
 migrateLibrary=through([correction,namespace,retirement,anonymous,starters]);
 migrateWithAnonymous=through([correction,namespace,retirement,starters]);
 ({replayMembershipRoleGrants}=await import('../helpers/historical-role-grants.js'));
 config={host:marker.socketDirectory,port:marker.port,user:marker.user,password:'',ssl:false,
  connectionTimeoutMillis:3000,statement_timeout:8000,lock_timeout:3000,idle_in_transaction_session_timeout:15000,
  options:'-c timezone=UTC',application_name:names('owner')};
 admin=new pg.Client({...config,database:'postgres'});await admin.connect();adminConnected=true;
 assert.equal((await admin.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
 assert.equal((await admin.query('SELECT inet_server_addr() IS NULL AS unix_only')).rows[0].unix_only,true);
 assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory),await realpath(marker.dataDirectory));
 assert.equal(Number((await admin.query('SHOW port')).rows[0].port),marker.port);
 assert.equal((await admin.query('SELECT current_user AS owner')).rows[0].owner,marker.user);
 assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,true,
  'isolated cluster bootstrap owner required; application roles remain non-superuser');
 assert.equal((await admin.query('SHOW fsync')).rows[0].fsync,'on');
 assert.equal((await admin.query('SHOW synchronous_commit')).rows[0].synchronous_commit,'on');
 assert.equal((await admin.query('SHOW TimeZone')).rows[0].TimeZone,'UTC');
 const version=Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
 assert.ok(version>=170000,'Root must qualify on PostgreSQL 17+; report the actual version');
 // This postgres-database advisory lease protects cooperating harness invocations
 // using the fixed names required by the unmodified conditional migrations.
 clusterLease=(await admin.query('SELECT pg_try_advisory_lock(71309,32026) AS owned')).rows[0].owned;
 assert.equal(clusterLease,true,'shared-name fixture lease is already owned');
 await requireAbsentRoles();
 return {serverVersionNum:version,serverVersion:(await admin.query('SHOW server_version')).rows[0].server_version,
  observedMetadataVersion:180006,aclMetadataSHA256,timezone:'UTC'};
}
async function requireAbsentRoles(){
 const rows=(await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[runtime,account]])).rows;
 assert.deepEqual(rows,[],'fixed conditional role names must be absent; never alter/drop a preexisting role, even a safe one');
}
async function createRoles(){
 await requireAbsentRoles();
 await admin.query('BEGIN');
 try{
  for(const name of [runtime,account]){
   await admin.query(`CREATE ROLE ${name} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
   await admin.query(`COMMENT ON ROLE ${name} IS '${provenance}'`);
   const row=(await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[name])).rows[0];
   ownedRoles.push({name,oid:row.oid});
  }
  await admin.query('COMMIT');
 }catch(error){await admin.query('ROLLBACK');throw error;}
 await assertRoles();
}
async function assertRoles(){
 for(const {name,oid} of ownedRoles){
  const row=(await admin.query(`SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
   shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1`,[name])).rows[0];
  assert.deepEqual(row,{oid,rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,
   rolreplication:false,rolbypassrls:false,marker:provenance});
  assert.deepEqual((await admin.query('SELECT roleid,member FROM pg_auth_members WHERE roleid=$1 OR member=$1',[oid])).rows,[]);
 }
}
async function bounded(promise,ms,label){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
 finally{clearTimeout(timer);}
}
async function newDatabase(){
 const name='lyrica_auth_token_'+randomUUID().replaceAll('-','');assert.match(name,/^lyrica_auth_token_[a-f0-9]{32}$/);
 const h={name,created:false,oid:null,pool:null,poolEnded:false,borrowed:new Set(),operations:new Set(),holds:new Set(),scopes:new Set(),pids:new Map(),poolErrors:[]};
 databases.add(h);
 await admin.query('CREATE DATABASE '+name+' TEMPLATE template0 ENCODING \'UTF8\'');h.created=true;
 // Record ownership immediately after CREATE; this name is never caller supplied.
 h.oid=(await admin.query('SELECT oid FROM pg_database WHERE datname=$1',[name])).rows[0].oid;
 await admin.query(`COMMENT ON DATABASE ${name} IS '${provenance}'`);
 h.pool=new pg.Pool({...config,database:name,max:6,idleTimeoutMillis:1000});h.pool.on('error',error=>h.poolErrors.push(error));
 h.acquire=async()=>{
  const client=await h.pool.connect();const lease={client,released:false,release(error){if(!this.released){this.released=true;h.borrowed.delete(this);client.release(error);}}};
  h.borrowed.add(lease);return lease;
 };
 h.release=async lease=>{
  if(!lease||lease.released)return;let failure;
  try{await lease.client.query('ROLLBACK');}catch(error){failure=error;throw error;}finally{lease.release(failure);}
 };
 h.db=(label,{role=null,afterSQL,trace=[],failReceipt=false}={})=>{
  assert.ok(role===null||[runtime,account].includes(role));
  const transaction=async fn=>{
   const lease=await h.acquire();const errors=[];let value;
   try{
    await lease.client.query('BEGIN');
    await lease.client.query("SELECT set_config('application_name',$1,true)",[names(label)]);
    await lease.client.query("SET LOCAL timezone='UTC'");
    if(role)await lease.client.query('SET LOCAL ROLE '+role);
    h.pids.set(label,(await lease.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const tx={query:async(text,args=[])=>{
     trace.push({text,args});
     if(failReceipt&&/^INSERT INTO library_schema_migrations/.test(text)&&args[0]===migration)
      throw Object.assign(new Error('injected_032_receipt_failure'),{code:'injected_032_receipt_failure'});
     const result=await lease.client.query(text,args);
     // The exact runner emits 5s. Execute it unchanged, then cap it back to
     // the existing harness's stricter 3s BEFORE any migration lock or DDL.
     if(text==="SET LOCAL lock_timeout='5s'"){
      trace.push({text:"SET LOCAL lock_timeout='3s'",args:[]});
      await lease.client.query("SET LOCAL lock_timeout='3s'");
     }
     if(afterSQL)await afterSQL(text,lease.client,args,result);
     return result;
    }};
    value=await fn(tx);await lease.client.query('COMMIT');
   }catch(error){errors.push(error);}
   finally{try{await h.release(lease);}catch(error){errors.push(error);}}
   if(errors.length)throw combine(errors,'transaction and release failed');return value;
  };
  return {transaction,query:(text,args)=>transaction(tx=>tx.query(text,args))};
 };
 h.query=(text,args)=>h.db('owner-query').query(text,args);
 h.outcome=promise=>{
  const p=promise.then(value=>({value}),error=>({error}));h.operations.add(p);
  void p.then(()=>h.operations.delete(p));return p;
 };
 h.barrier=()=>{
  let enter,release;const waiting=new Promise(r=>{enter=r;}),released=new Promise(r=>{release=r;});
  const hold={waiting,release:()=>{release();h.holds.delete(hold);},async point(){enter();await bounded(released,10000,'mutation hold timed out');}};
  h.holds.add(hold);return hold;
 };
 return h;
}
async function entered(hold,pending){
 await bounded(Promise.race([hold.waiting,pending.then(r=>{throw r.error??new Error('completed before barrier');})]),2500,'barrier was not entered');
}
async function blocked(h,label,blocker){
 assert.ok(Number.isInteger(blocker));const end=Date.now()+2000;
 while(Date.now()<end){
  const rows=(await admin.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers
   FROM pg_stat_activity WHERE datname=$1 AND application_name=$2`,[h.name,names(label)])).rows;
  assert.ok(rows.length<=1);const row=rows[0];
  if(row?.wait_event_type==='Lock'&&row.blockers.includes(blocker)){assert.notEqual(row.pid,blocker);return row;}
  await delay(10);
 }
 assert.fail('real pg_blocking_pids + Lock barrier not observed: '+label);
}
async function quiescent(h){
 assert.equal(h.operations.size,0);assert.equal(h.holds.size,0);assert.equal(h.scopes.size,0);assert.equal(h.borrowed.size,0);
 assert.equal(h.pool.waitingCount,0);assert.equal(h.pool.totalCount,h.pool.idleCount);assert.deepEqual(h.poolErrors,[]);
 assert.deepEqual((await admin.query(`SELECT pid,state FROM pg_stat_activity WHERE datname=$1
  AND state IN ('idle in transaction','idle in transaction (aborted)')`,[h.name])).rows,[]);
}
async function dispose(h){
 const errors=[];
 for(const hold of [...h.holds])hold.release();
 for(const scope of [...h.scopes])try{await scope();}catch(error){errors.push(error);}
 await Promise.all([...h.operations]);
 if(h.pool&&!h.poolEnded){
  try{await quiescent(h);}catch(error){errors.push(error);}
  for(const lease of [...h.borrowed])try{await h.release(lease);}catch(error){errors.push(error);}
  if(h.pool.waitingCount===0&&h.pool.totalCount===h.pool.idleCount)try{await h.pool.end();h.poolEnded=true;}catch(error){errors.push(error);}
  else errors.push(new Error('unaccounted pool borrower; refusing pool.end'));
 }
 if(h.created){
  try{
   const row=(await admin.query("SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[h.name])).rows[0];
   assert.equal(row?.oid,h.oid);assert.equal(row?.marker,provenance,'refuse foreign database cleanup');
   await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datid=$1 AND pid<>pg_backend_pid()',[h.oid]);
   await admin.query('DROP DATABASE '+h.name);h.created=false;
  }catch(error){errors.push(error);}
 }
 if(!h.created)databases.delete(h);
 if(errors.length)throw combine(errors,'database cleanup failed');
}
async function usingDatabase(fn){
 const h=await newDatabase();const errors=[];
 try{await fn(h);}catch(error){errors.push(error);}
 finally{try{await dispose(h);}catch(error){errors.push(error);}}
 if(errors.length)throw combine(errors,'scenario and cleanup failed');
}
async function baseline(h){
 const saved=[...migrationNames],publicNames=saved.filter(name=>Number(name.slice(0,3))<=28);
 assert.deepEqual(publicNames.map(name=>Number(name.slice(0,3))),Array.from({length:28},(_,i)=>i+1));
 assert.deepEqual(saved,[...publicNames,migration,correction,namespace,retirement,anonymous,starters],'exact current registry; original harness selects only through 032');
 migrationNames.splice(0,migrationNames.length,...publicNames);
 try{assert.deepEqual(await migrateLibrary(h.db('baseline')),publicNames);}
 finally{migrationNames.splice(0,migrationNames.length,...saved);}
 assert.equal((await h.query("SELECT to_regnamespace('listening_v2')::text AS name")).rows[0].name,null);
 for(const row of (await receipts(h)).filter(row=>row.name!==migration))assert.equal(row.sha256,sourcePins['db/'+row.name]);
}
const receipts=async h=>(await h.query('SELECT name,sha256,applied_at::text AS applied_at FROM library_schema_migrations ORDER BY name')).rows;
const tokens=async h=>(await h.query(`SELECT digest,user_id,revoked,created_at::text AS created_at,expires_at::text AS expires_at
 FROM public.library_tokens ORDER BY digest`)).rows;
const tuples=async h=>(await h.query('SELECT digest,ctid::text AS ctid,xmin::text AS xmin FROM public.library_tokens ORDER BY digest')).rows;
async function acls(h){return (await h.query(`SELECT c.oid::regclass::text AS relation,c.relacl::text AS table_acl,a.attname,a.attacl::text AS column_acl
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind='r' ORDER BY relation,a.attnum`)).rows;}
async function reconstructObserved(h){
 // Only this randomized DB; strip any additional conditional fixture grants.
 await h.query('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM '+runtime);
 // REVOKE(table) does not remove column ACLs: enumerate and revoke those too.
 const columns=(await h.query(`SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL`)).rows;
 for(const {relname,attname} of columns){
  assert.match(relname,/^[a-z_]+$/);assert.match(attname,/^[a-z_]+$/);
  await h.query(`REVOKE ALL PRIVILEGES (${attname}) ON public.${relname} FROM ${runtime}`);
 }
 await h.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await h.query('GRANT USAGE ON SCHEMA public TO '+runtime);
 for(const [relation,privileges] of Object.entries(observed)){
  assert.equal((await h.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',['public.'+relation])).rows[0]?.relrowsecurity,false);
  await h.query(`GRANT ${privileges.join(',')} ON public.${relation} TO ${runtime}`);
 }
 for(const [relation,columns] of Object.entries(observedUpdates))await h.query(`GRANT UPDATE(${columns.join(',')}) ON public.${relation} TO ${runtime}`);
}
async function leastPrivilege(h,anchor){
 const privileges=(await h.query(`SELECT has_table_privilege($1,'public.library_tokens','SELECT') AS sel,
 has_table_privilege($1,'public.library_tokens','UPDATE') AS upd,has_any_column_privilege($1,'public.library_tokens','UPDATE') AS any_upd,
 has_table_privilege($1,'public.library_tokens','INSERT') AS ins,has_table_privilege($1,'public.library_tokens','DELETE') AS del,
 has_table_privilege($1,'public.library_tokens','TRUNCATE') AS trunc,has_schema_privilege($1,'public','CREATE') AS create_schema`,[runtime])).rows[0];
 assert.deepEqual(privileges,{sel:true,upd:false,any_upd:anchor,ins:false,del:false,trunc:false,create_schema:false});
 for(const field of existingTokenFields)for(const action of ['UPDATE','INSERT'])assert.equal((await h.query(
  "SELECT has_column_privilege($1,'public.library_tokens',$2,$3) AS allowed",[runtime,field,action])).rows[0].allowed,false);
 if(anchor)assert.equal((await h.query("SELECT has_column_privilege($1,'public.library_tokens','auth_lock_anchor','UPDATE') AS allowed",[runtime])).rows[0].allowed,true);
 // Verify every observed column, including no blanket disabled/access grants.
 for(const relation of Object.keys(observed)){
  for(const action of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await h.query(
   'SELECT has_table_privilege($1,$2,$3) AS allowed',[runtime,'public.'+relation,action])).rows[0].allowed,
   observed[relation].includes(action),relation+':'+action);
  for(const row of (await h.query(`SELECT a.attname,has_column_privilege($1,a.attrelid,a.attname,'UPDATE') AS allowed
   FROM pg_attribute a WHERE a.attrelid=$2::regclass AND a.attnum>0 AND NOT a.attisdropped`,[runtime,'public.'+relation])).rows){
   const expected=observed[relation].includes('UPDATE')||(observedUpdates[relation]??[]).includes(row.attname)||
    relation==='library_tokens'&&row.attname==='auth_lock_anchor'&&anchor;
   assert.equal(row.allowed,expected,relation+'.'+row.attname);
  }
 }
 await assertRoles();
}
async function catalog(h){
 const rows=(await h.query(`SELECT a.atttypid='pg_catalog.bool'::regtype AS bool,a.atttypmod,a.attndims,a.attnotnull,a.attgenerated,a.attidentity,
 a.attislocal,a.attinhcount,c.contype,pg_get_expr(d.adbin,d.adrelid,false) AS def,c.convalidated,c.connoinherit,c.conislocal,c.coninhcount,
 c.condeferrable,c.condeferred,c.conkey=ARRAY[a.attnum]::smallint[] AS exact_key,pg_get_expr(c.conbin,c.conrelid,false) AS check_expr
 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 JOIN pg_constraint c ON c.conrelid=a.attrelid AND c.conname='library_tokens_auth_lock_anchor_false'
 WHERE a.attrelid='public.library_tokens'::regclass AND a.attname='auth_lock_anchor' AND a.attnum>0 AND NOT a.attisdropped`)).rows;
 assert.deepEqual(rows,[{bool:true,atttypmod:-1,attndims:0,attnotnull:true,attgenerated:'',attidentity:'',attislocal:true,attinhcount:0,contype:'c',
 def:'false',convalidated:true,connoinherit:false,conislocal:true,coninhcount:0,condeferrable:false,condeferred:false,exact_key:true,check_expr:'(auth_lock_anchor IS FALSE)'}]);
}
async function lockWitness(h,accepted){
 const db=h.db('restricted-lock',{role:runtime});
 const zero=()=>db.query('SELECT digest FROM public.library_tokens WHERE false FOR UPDATE');
 const populated=()=>db.query('SELECT digest FROM public.library_tokens WHERE digest=$1 FOR UPDATE',['fixture-token']);
 if(accepted){assert.deepEqual((await zero()).rows,[]);assert.deepEqual((await populated()).rows,[{digest:'fixture-token'}]);}
 else{await denied(zero());await denied(populated());}
}
async function tokenFixture(h){
 await h.query("INSERT INTO library_users(id) VALUES('fixture-user')");
 await h.query("INSERT INTO library_tokens(digest,user_id,created_at,expires_at) VALUES('fixture-token','fixture-user','2026-01-01 01:02:03.123456+00','2099-01-02 03:04:05.654321+00')");
}
async function lateReplay(h){
 await baseline(h);await tokenFixture(h);await requireAbsentRoles();
 assert.deepEqual(await migrateLibrary(h.db('role-absent-upgrade')),[migration]);await requireAbsentRoles();
 await catalog(h);const prior=await receipts(h),before=await tokens(h),physical=await tuples(h);
 await createRoles();await reconstructObserved(h);await leastPrivilege(h,false);await lockWitness(h,false);
 const trace=[];
 await h.db('replay',{trace}).transaction(tx=>replayMembershipRoleGrants(tx));
 const acl=await acls(h);
 await h.db('replay-again',{trace}).transaction(tx=>replayMembershipRoleGrants(tx));
 assert.deepEqual(await acls(h),acl);assert.deepEqual(await receipts(h),prior);
 assert.deepEqual(await tokens(h),before);assert.deepEqual(await tuples(h),physical);
 const exact=await readFile(new URL('../../db/'+migration,import.meta.url),'utf8');
 const block=exact.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g)?.filter(text=>text.includes('pg_roles')&&text.includes('GRANT '));
 assert.equal(block?.length,1);
 const body=block[0].slice('DO $$ '.length,-' $$;'.length)+';';
 assert.equal(trace.length,2,'one atomic statement per actual replay call');
 for(const {text} of trace){
  assert.equal(text.split(body).length-1,1,'unchanged 032 body occurs exactly once per replay');
  assert.match(text,/^DO \$membership_role_replay\$\nBEGIN\n/);
  assert.ok(text.endsWith('\nEND $membership_role_replay$;'));
  assert.doesNotMatch(text,/\b(?:ALTER TABLE|CREATE (?:TABLE|SCHEMA|ROLE)|INSERT INTO|DELETE FROM|TRUNCATE)\b/);}
 await lockWitness(h,true);await leastPrivilege(h,true);
 // Cover actual PG rollback semantics with meaningful missing/default/check
 // drift, rather than copying every embedded-engine catalog permutation.
 for(const change of [
  'ALTER TABLE public.library_tokens DROP COLUMN auth_lock_anchor',
  'ALTER TABLE public.library_tokens ALTER COLUMN auth_lock_anchor SET DEFAULT true',
  'ALTER TABLE public.library_tokens DROP CONSTRAINT library_tokens_auth_lock_anchor_false'
 ]){
  const old=await acls(h);
  await assert.rejects(h.db('drift-replay').transaction(async tx=>{
   await tx.query(change);
   if(!change.includes('DROP COLUMN'))await tx.query('REVOKE UPDATE(auth_lock_anchor) ON public.library_tokens FROM '+runtime);
   await replayMembershipRoleGrants(tx);
  }),drift);
  assert.deepEqual(await acls(h),old);assert.deepEqual(await receipts(h),prior);await catalog(h);
 }
}
const cryptoFixtures={attestFn:()=>({publicKey:'external-crypto-fixture',receipt:Buffer.from('fixture')}),
 assertionFn:({assertion})=>Number(assertion.toString())};
const auth=db=>new AppAuthStore(db,{policy,...cryptoFixtures});
const accounts=db=>new AccountStore(db,{policy,attestFn:cryptoFixtures.attestFn});
async function seed(h,label){
 const id='auth-fixture-'+randomUUID(),credential='fixture-'+randomUUID(),key=Buffer.from(sha(id),'hex').toString('base64');
 await h.query("INSERT INTO library_users(id,access_kind) VALUES($1,'guest')",[id]);
 await h.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,'2099-01-02 03:04:05.123456+00')",[sha(credential),id]);
 const a=auth(h.db(label,{role:runtime})),bundleID=policy.bundles[0];
 const registration=await a.challenge(credential,{keyID:key,bundleID,purpose:'register'});
 assert.deepEqual(await a.register(credential,{keyID:key,bundleID,...registration,attestation:'Zml4dHVyZQ=='}),{registered:true});
 const challenge=await a.challenge(credential,{keyID:key,bundleID,purpose:'session'});
 const issued=await a.session(credential,{keyID:key,bundleID,...challenge,assertion:'MQ=='});
 const user=await a.authenticate(issued.token);
 assert.deepEqual(user,{id,keyID:key,bundleID,credentialDigest:sha(credential)});
 const context=createCurrentAuthContext({authStore:a,environment:'test'});
 const authentication=await context.prepare(issued.token);
 return {a,user,key,credential,bearer:issued.token,context,authentication};
}
async function current(f,db,authorized=()=>{}){
 return db.transaction(async tx=>{
  const discovery=await f.context.discover({tx,authentication:f.authentication});
  const scope=await f.context.lock({tx,discovery});await scope.revalidate({tx});
  authorized();return scope.principalID;
 });
}
async function noRoomWrites(h){
 assert.equal((await h.query("SELECT to_regnamespace('listening_v2')::text AS name")).rows[0].name,null);
 const rows=(await h.query(`SELECT to_regclass('public.listening_rooms')::text AS rooms,
  to_regclass('public.listening_commands')::text AS commands,to_regclass('public.listening_outbox')::text AS outbox`)).rows;
 assert.deepEqual(rows,[{rooms:null,commands:null,outbox:null}]);
}
async function authRace(h,order,observerFailure=false){
 const f=await seed(h,'race-seed'),hold=h.barrier(),pending=[],errors=[],trace=[];
 const sentinel=new Error('injected lock observer failure');let reading,writing,authorized=0,draining;
 const drain=()=>draining??=(async()=>{hold.release();try{await Promise.all(pending);}finally{h.scopes.delete(drain);}})();h.scopes.add(drain);
 try{
  if(order==='revocation-first'){
   const writer=accounts(h.db('writer',{role:account,afterSQL:text=>/^UPDATE library_tokens SET revoked/.test(text)?hold.point():undefined}));
   const authentication=await writer.prepareWriterAuthentication(f.bearer);
   writing=h.outcome(writer.delete(f.user,authentication));pending.push(writing);
   await entered(hold,writing);
   reading=h.outcome(current(f,h.db('current',{role:runtime,trace}),()=>authorized++));pending.push(reading);
   await blocked(h,'current',h.pids.get('writer'));
  }else{
   reading=h.outcome(current(f,h.db('current',{role:runtime,trace,afterSQL:text=>/FROM public\.app_auth_sessions WHERE digest=\$1 FOR UPDATE/.test(text)?hold.point():undefined}),()=>authorized++));pending.push(reading);
   await entered(hold,reading);
   const writer=accounts(h.db('writer',{role:account}));
   const authentication=await writer.prepareWriterAuthentication(f.bearer);
   writing=h.outcome(writer.delete(f.user,authentication));pending.push(writing);
   await blocked(h,'writer',h.pids.get('current'));
  }
  if(observerFailure)throw sentinel;
 }catch(error){errors.push(error);}
 finally{
  await drain();
  // Validation is part of drainage, even after observer failure. A sentinel
  // must never hide a contender's real SQL/rollback/commit error.
  try{
   assert.ok(reading&&writing,'both actual contenders must start');
   assert.equal((await writing).error,undefined);
   assert.deepEqual((await writing).value,{deleted:true});
   if(order==='revocation-first'){assert.equal((await reading).error?.code,'unauthorized');assert.equal(authorized,0);}
   else{assert.equal((await reading).error,undefined);assert.equal((await reading).value,f.user.id);assert.equal(authorized,1);}
   for(const {text} of trace)assert.doesNotMatch(text,/^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE)\b/i,'current-auth boundary must execute no reducer/writer SQL');
   await assert.rejects(current(f,h.db('post-replay',{role:runtime})),{code:'unauthorized'});
   await assert.rejects(f.context.prepare(f.bearer),{code:'unauthorized'});
   await assert.rejects(f.a.authenticate(f.bearer),{code:'session_expired'});
   await noRoomWrites(h);await quiescent(h);
  }catch(error){errors.push(error);}
 }
 if(errors.length)throw combine(errors,'observer/contender/drainage failure');
 return sentinel;
}
async function grantObservedFunctions(h){
 for(const fn of observedFunctions)await h.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${runtime}`);
 for(const fn of observedFunctions){
  assert.equal((await h.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS ok",[runtime,fn])).rows[0].ok,true);
  assert.equal((await h.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS ok",[account,fn])).rows[0].ok,false);
 }
}
async function upgradeAndMethods(h,t){
 await baseline(h);await tokenFixture(h);await reconstructObserved(h);await leastPrivilege(h,false);await lockWitness(h,false);
 const before=await tokens(h),prior=await receipts(h),oldACL=await acls(h);
 await assert.rejects(migrateLibrary(h.db('failed-receipt',{failReceipt:true})),{code:'injected_032_receipt_failure'});
 assert.deepEqual(await receipts(h),prior);assert.deepEqual(await tokens(h),before);assert.deepEqual(await acls(h),oldACL);
 assert.equal((await h.query("SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='public.library_tokens'::regclass AND attname='auth_lock_anchor' AND NOT attisdropped")).rows[0].n,0);
 const migrationTrace=[];
 assert.deepEqual(await migrateWithAnonymous(h.db('upgrade',{trace:migrationTrace})),[migration,anonymous]);
 const timeoutIndex=migrationTrace.findIndex(call=>call.text==="SET LOCAL lock_timeout='5s'");
 assert.ok(timeoutIndex>=0);assert.equal(migrationTrace[timeoutIndex+1].text,"SET LOCAL lock_timeout='3s'");
 assert.equal(migrationTrace[timeoutIndex+2].text,'SELECT pg_advisory_xact_lock(71309,1)');
 await catalog(h);await leastPrivilege(h,true);await lockWitness(h,true);
 // 039 adds columns and drops account_identities; every other ACL is unchanged.
 assert.deepEqual((await acls(h)).filter(row=>row.attname!=='auth_lock_anchor'&&!anonymousColumns.includes(row.relation+'.'+row.attname)),
  oldACL.filter(row=>row.relation!=='account_identities'));
 const row=(await receipts(h)).find(row=>row.name===migration);assert.equal(row.sha256,sourcePins['db/'+migration]);
 assert.equal((await receipts(h)).find(row=>row.name===anonymous).sha256,sourcePins['db/'+anonymous]);
 await grantObservedFunctions(h);
 t.diagnostic(JSON.stringify({migration,receiptSHA256:row.sha256,actualMethodsUseSETROLE:true,unregistered:['030','031']}));
 const receiptState=await receipts(h);assert.deepEqual(await migrateWithAnonymous(h.db('idempotent-runner')),[]);assert.deepEqual(await receipts(h),receiptState);
 const db=h.db('denials',{role:runtime});
 for(const field of existingTokenFields){
  await denied(db.query(`UPDATE public.library_tokens SET ${field}=${field} WHERE false`));
  await denied(db.query(`UPDATE public.library_tokens SET ${field}=${field} WHERE digest='fixture-token'`));
 }
 await denied(db.query("INSERT INTO public.library_tokens(digest,user_id) SELECT 'forbidden','fixture-user' WHERE false"));
 await denied(db.query('DELETE FROM public.library_tokens WHERE false'));
 await assert.rejects(db.query("UPDATE public.library_tokens SET auth_lock_anchor=true WHERE digest='fixture-token'"),{code:'23514'});
 await assert.rejects(db.query("UPDATE public.library_tokens SET auth_lock_anchor=NULL WHERE digest='fixture-token'"),{code:'23502'});
 await assert.rejects(db.transaction(async tx=>{
  assert.deepEqual((await tx.query("UPDATE public.library_tokens SET auth_lock_anchor=false WHERE digest='fixture-token' RETURNING auth_lock_anchor")).rows,[{auth_lock_anchor:false}]);
  throw Object.assign(new Error('rollback permitted same-value probe'),{code:'probe_rollback'});
 }),{code:'probe_rollback'});
 assert.deepEqual(await tokens(h),before);
 const settings=(await h.query("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('TimeZone') AS timezone")).rows[0];
 assert.deepEqual(settings,{statement:'8s',lock:'3s',idle:'15s',timezone:'UTC'});
 // Account privileges are precisely the actual 025/027/028 conditional
 // grants from the baseline, with no runtime metadata copied to that role.
 assert.equal((await h.query("SELECT has_column_privilege($1,'public.library_tokens','revoked','UPDATE') AS allowed",[account])).rows[0].allowed,true);
 await t.test('restricted actual challenge/register/session/authenticate/current-auth',async()=>{
  const f=await seed(h,'actual-auth');
  assert.equal(await current(f,h.db('auth-current',{role:runtime})),f.user.id);
  const challenge=await f.a.challenge(f.credential,{keyID:f.key,bundleID:f.user.bundleID,purpose:'session'});
  const next=await f.a.session(f.credential,{keyID:f.key,bundleID:f.user.bundleID,...challenge,assertion:'Mg=='});
  await assert.rejects(f.a.authenticate(f.bearer),{code:'session_expired'});
  await assert.rejects(current(f,h.db('old-exact-bearer',{role:runtime})),{code:'unauthorized'});
  const fresh={...f,authentication:await f.context.prepare(next.token)};
  assert.equal(await current(fresh,h.db('new-exact-bearer',{role:runtime})),f.user.id);
  await noRoomWrites(h);await quiescent(h);
 });
 for(const order of ['revocation-first','auth-first']){
  await t.test('actual restricted current-auth frontier versus AccountStore.delete: '+order,async()=>authRace(h,order));
  await t.test('outer-finally drains both contenders after observer failure: '+order,async()=>{
   await assert.rejects(authRace(h,order,true),error=>error.message==='injected lock observer failure');await quiescent(h);
  });
 }
}

test('manual actual PostgreSQL token-lock and restricted auth frontier qualification',{timeout:90000},async t=>{
 const errors=[];
 try{
  const metadata=await connect();t.diagnostic(JSON.stringify({scope:'local synthetic restricted roles; command/receipt gate deferred',...metadata}));
  let lateQualified=false;
  await t.test('actual registered 032, absent role, late replay and fail-closed drift',{timeout:30000},async()=>{await usingDatabase(lateReplay);lateQualified=true;});
  assert.equal(lateQualified,true,'late replay/drift group failed; dependent method gate refuses');
  // Node subtest failure does not throw from t.test; refuse dependent work if
  // role setup did not finish, while the encompassing finally still cleans up.
  assert.equal(ownedRoles.length,2,'late-role scenario must provision owned aliases');await assertRoles();
  await t.test('001-028 baseline -> 032/036 -> actual restricted methods and two-client races',{timeout:45000},sub=>usingDatabase(h=>upgradeAndMethods(h,sub)));
 }catch(error){errors.push(error);}
 finally{
  for(const h of [...databases])try{await dispose(h);}catch(error){errors.push(error);}
  if(admin){
   try{
    if(adminConnected){
     // Database drops remove all DB-local grants. Global roles are removed
     // ONLY if exact task provenance/OID/attributes still match. Never DROP OWNED.
     for(const {name,oid} of [...ownedRoles].reverse()){
      const row=(await admin.query("SELECT oid,shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",[name])).rows[0];
      if(!row)continue;
      assert.equal(row.oid,oid);assert.equal(row.marker,provenance,'refuse foreign role cleanup');
      await assertRoles();await admin.query('DROP ROLE '+name);
      ownedRoles.splice(ownedRoles.findIndex(role=>role.name===name),1);
     }
     if(clusterLease)await admin.query('SELECT pg_advisory_unlock(71309,32026)');
    }
   }catch(error){errors.push(error);}
   finally{try{await admin.end();}catch(error){errors.push(error);}}
  }
 }
 if(errors.length)throw combine(errors,'qualification/setup/cleanup failure');
});
