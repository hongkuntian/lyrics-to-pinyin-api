// MANUAL ONLY. Original harness followed frozen 034. LT01 assertions were
// sealed before the proposed privilege correction; Root owns semantic red/green.
// Root applies maintained sources and pins an independently approved candidate.
// Row simulations below are not terminal-store, source, enrollment or Release proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {open,lstat,realpath,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

const BASE='fefc00d1cac8f49ddb84972cb7d4ed4b6394052f';
const SOURCE_PINS=/* ROOT refresh only changed independently reviewed inputs. */ {
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
 "db/029-listening-sessions.sql": "fe9adc6d732edbc9175ed4a2823f6e84821f760099bcf72957da6a8a7a09afc8",
 "db/030-listening-v2-schema.sql": "4cd413d4fe3d38ab62695ec8898e9532326e85e8d60c9a5f358dc9b911f5e0c6",
 "db/031-listening-v2-lifecycle-support.sql": "111032345679f02d00fb0df0d85ba8d11d48fc836159fffe316908007912e9ec",
 "db/032-auth-token-row-locks.sql": "c19650a29438ebeea186203d954fee8e144a65ca6d42ad91bc38c18f1f7e5df6",
 "db/033-listening-v2-lifecycle-composition.sql": "71b57b21ae4555d3d76da9b9936342238926fa8059117e68aa41a40a7e628678",
 "api/utils/listening-v2/protocol.js": "4369c15340ea2e4a11a1afbab3407541103a816e015f7ad355243a2d18885fee",
 "api/utils/listening-v2/errors.js": "dac70423b7f56295f3b6d1fed410a87edda06432dbf8fd892ed84e98170d049c",
 "api/utils/listening-v2/auth-context.js": "6d674aea80278c68aee2fa167da714c4987ff0530be44ff095544056b9671da6",
 "api/utils/listening-v2/privacy-writers.js": "9c6db7c5bd3c3cc4bff34c1b46cc53ca68d6571a443d33bbcf26eb0b98954f34",
 "api/utils/app-auth/store.js": "2692755072094fb0907dd0721396c38f0190cf0a595f2c40dd16400f7dbbc6aa",
 "api/utils/membership/accounts.js": "15a7fa51080bb68081a193c7e4c7c0bd72126ecf602b796518b21ecc473465ab",
 "tests/postgres/auth-token-lock-roles.test.js": "1be3eec67027e3d5eeef6925483dd33213cb68d0501f0398e0d8defa610d8cbd",
 "tests/postgres/listening-v2-auth-writers.test.js": "9838194eb27c4e1e08cfe50f7f9a8fe4290835c77911417ca74459398e337f44",
 "tests/postgres/listening-v2-transactions.test.js": "1587283e9bb14f9da535a2c1b713b115d83a73b54d55ba2126c4206fcd9845da",
 "scripts/library-migrations.js": "b2bcfb3ea471555c048f9258b45f745f8ef56cbdfcda08cbbdd2ed0d1e40b422",
 "scripts/membership-role-grants.js": "6c92eaf3fb68a69c66d2d182afacebfce87cdf8ed5d9d98c659c2c9c95dd8117",
 "db/034-listening-v2-output-terminal-support.sql": "28dbfb344fc782a35c96ea896f6c17092607280f193eed166b5dfc13b8776cab",
 "api/utils/listening-v2/terminal-codec.js": "602c60e226caf67dbff8991f62afb5c59f245a0d859a42d0993aa456e9b76301",
 "tests/unit/listening-v2-terminal-codec.test.js": "e1ce66ffc4932f9253aad01840d33b6f41552e76cc4ce03558ab5e994dee52f5",
 "tests/integration/listening-v2-output-terminal-schema.test.js": "f72dc50b9892cb4f41ff34632c2bc1d918f00046f1c90f00ab589217394c11b8",
 "docs/design/sessions-v2-output-terminal.md": "064da7ed3e07237dc028098a5257bd207e6dc9ab09bb842e9d89983133002522",
 "docs/design/sessions-v2-storage-schema.md": "74505c3ff057410dad4cbac5cb068e362c2a40ecd460b6299a7bf636a3720780"
};
const root=fileURLToPath(new URL('../../',import.meta.url));
const migration='db/034-listening-v2-output-terminal-support.sql';
const runtime='lyra_runtime_v1',account='lyra_account_v1',roles=[runtime,account];
const runID=randomUUID().replaceAll('-',''),tag='lyrica-output-terminal:'+runID;
const appName=label=>'lyrica-terminal-'+runID.slice(0,12)+'-'+label;
const DAY=86400000,MAX=9007199254740991,UUID='ffffffff-ffff-ffff-ffff-ffffffffffff';
const sha=value=>createHash('sha256').update(value).digest('hex');
const sql=name=>readFile(new URL('../../'+name,import.meta.url),'utf8');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const first=async(db,text,args=[])=>(await db.query(text,args)).rows[0];
const code=(promise,expected)=>assert.rejects(promise,{code:expected});
const aggregate=(errors,label)=>errors.length===1?errors[0]:new AggregateError(errors,label);
const numeric=value=>{assert.match(String(value),/^(0|[1-9][0-9]*)$/);assert.ok(BigInt(value)<=BigInt(MAX));return Number(value);};
// Same observed public runtime footprint as committed auth-token-lock-roles,
// not a claimed current deployed ACL. Account keeps actual 025/027/028/029 grants.
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

async function preflight(){
 const expected=process.env.LYRA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT;
 assert.match(expected??'',/^[a-f0-9]{40}$/,'Root must supply the independently approved exact combined commit');
 assert.equal(git('rev-parse','HEAD'),expected,'runner HEAD must be Root approved input');
 git('merge-base','--is-ancestor',BASE,expected);
 assert.equal(git('status','--porcelain=v1','--untracked-files=normal','--','.',':(exclude)node_modules'),'','REFUSE source/index or nonignored untracked mismatch; Root separately pins the installed dependency tree');
 const proposed=['tests/postgres/listening-v2-output-terminal.test.js','docs/design/sessions-v2-output-terminal-postgres.md'];
 git('ls-files','--error-unmatch',...Object.keys(SOURCE_PINS),...proposed);
 for(const [path,pin] of Object.entries(SOURCE_PINS))assert.equal(sha(await sql(path)),pin,'source pin: '+path);
 const registry=await sql('scripts/library-migrations.js');
 assert.ok(!registry.includes('034-listening-v2-output-terminal-support.sql'),'034 must stay unregistered');
 assert.ok(isAbsolute(process.env.LYRA_TEST_POSTGRES_MANIFEST??''),'missing manifest REFUSES; never skip');
 // A fully explicit pg config follows; also refuse ambient PG* to expose mistakes.
 assert.deepEqual(Object.keys(process.env).filter(k=>/^PG/.test(k)),[],'remove ambient PG* before manual run');
 const path=process.env.LYRA_TEST_POSTGRES_MANIFEST,uid=process.getuid();
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let marker;
 try{
  const s=await fd.stat();
  assert.ok(s.isFile());assert.equal(s.uid,uid);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);
  assert.ok(s.size>0&&s.size<=16384,'bounded local marker only');
  marker=JSON.parse(await fd.readFile('utf8'));
 }finally{await fd.close();}
 assert.equal(marker.purpose,'lyrica-sessions-v2-local-qualification');
 assert.equal(marker.ownerUID,uid);assert.equal(marker.active,true);assert.equal(marker.TCPListening,false);
 assert.equal(marker.sourceCommit,expected,'manifest cannot choose its own approved source');
 assert.match(marker.systemIdentifier??'',/^[1-9][0-9]{0,19}$/,'Root records actual local pg_control_system identity');
 assert.match(marker.socketDirectory??'',/^\/tmp\/lyrica-sessions-pg-[A-Za-z0-9_-]+$/);
 assert.ok(isAbsolute(marker.dataDirectory??''));
 for(const path of [marker.socketDirectory,marker.dataDirectory]){
  const s=await lstat(path);
  assert.ok(s.isDirectory()&&!s.isSymbolicLink());assert.equal(s.uid,uid);assert.equal(s.mode&0o077,0);
 }
 assert.ok(Number.isInteger(marker.port)&&marker.port>1024&&marker.port<65536);
 assert.match(marker.user??'',/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
 const socket=await lstat(resolve(marker.socketDirectory,'.s.PGSQL.'+marker.port));
 assert.ok(socket.isSocket()&&!socket.isSymbolicLink());assert.equal(socket.uid,uid);
 return marker;
}
async function bounded(promise,ms,label){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
 finally{clearTimeout(timer);}
}
function signal(){
 let enter,release;
 const waiting=new Promise(r=>{enter=r;}),released=new Promise(r=>{release=r;});
 return {waiting,release,enter,async point(value){enter(value);await bounded(released,10000,'owned barrier timed out');}};
}
async function entered(hold,pending){
 return bounded(Promise.race([hold.waiting,pending.then(r=>{throw r.error??new Error('contender completed before barrier');})]),
  2500,'barrier not entered');
}

test('manual actual PostgreSQL: disabled output-terminal representations',{timeout:90000},async t=>{
 let admin,connected=false,clusterLease=false,pg,config;
 const ownedRoles=[],databases=new Set(),errors=[];
 async function roleIdentity(role){
  return first(admin,"SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,"+
   "shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",[role.name]);
 }
 async function assertRole(role){
  assert.deepEqual(await roleIdentity(role),{oid:role.oid,rolname:role.name,rolcanlogin:false,rolsuper:false,
   rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,marker:tag});
  assert.deepEqual((await admin.query('SELECT roleid,member FROM pg_auth_members WHERE roleid=$1 OR member=$1',[role.oid])).rows,[]);
 }
 async function createRoles(){
  assert.deepEqual((await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[roles])).rows,[],
   'fixed role names must be absent: never adopt, alter or drop preexisting roles');
  await admin.query('BEGIN');
  try{
   for(const name of roles){
    await admin.query('CREATE ROLE '+name+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
    const row=await first(admin,'SELECT oid FROM pg_roles WHERE rolname=$1',[name]);
    const role={name,oid:row.oid};ownedRoles.push(role);
    await admin.query("COMMENT ON ROLE "+name+" IS '"+tag+"'");
   }
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
  for(const role of ownedRoles)await assertRole(role);
 }
 async function newDatabase(label){
  const name='lyrica_terminal_'+runID+'_'+label;
  assert.match(name,/^lyrica_terminal_[a-f0-9]{32}_(minimal|observed|late)$/);
  const h={name,created:false,tagged:false,oid:null,pool:null,ended:false,
   borrowed:new Set(),pending:new Set(),holds:new Set(),poolErrors:[]};
  databases.add(h); // Before CREATE or any setup assertion, so outer finally owns it.
  assert.equal((await first(admin,'SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',[name])).n,0);
  await admin.query("CREATE DATABASE "+name+" TEMPLATE template0 ENCODING 'UTF8'");h.created=true;
  h.oid=(await first(admin,'SELECT oid FROM pg_database WHERE datname=$1',[name])).oid;
  await admin.query("COMMENT ON DATABASE "+name+" IS '"+tag+"'");h.tagged=true;
  h.pool=new pg.Pool({...config,database:name,max:6,idleTimeoutMillis:1000});
  h.pool.on('error',error=>h.poolErrors.push(error));
  h.acquire=async()=>{
   const client=await h.pool.connect();
   const lease={client,released:false,release(error){
    if(!this.released){this.released=true;h.borrowed.delete(this);client.release(error);}
   }};
   h.borrowed.add(lease);return lease;
  };
  h.release=async lease=>{
   if(!lease||lease.released)return;
   let failure;
   try{await lease.client.query('ROLLBACK');}
   catch(error){failure=error;throw error;}
   finally{lease.release(failure);}
  };
  h.tx=async(role,label,fn,{started,afterSQL,trace=[]}={})=>{
   assert.ok(role===null||roles.includes(role));
   const lease=await h.acquire(),failures=[];
   let value;
   try{
    await lease.client.query('BEGIN');
    await lease.client.query("SELECT set_config('application_name',$1,true)",[appName(label)]);
    if(role)await lease.client.query('SET LOCAL ROLE '+role);
    const pid=(await first(lease.client,'SELECT pg_backend_pid() AS pid')).pid;
    started?.enter(pid);
    const tx={query:async(text,args=[])=>{
     trace.push(text);const result=await lease.client.query(text,args);
     if(afterSQL)await afterSQL(text,lease.client,args,result);
     return result;
    }};
    value=await fn(tx);trace.push('COMMIT');await lease.client.query('COMMIT');
   }catch(error){failures.push(error);}
   finally{try{await h.release(lease);}catch(error){failures.push(error);}}
   if(failures.length)throw aggregate(failures,'transaction/release failure');return value;
  };
  h.query=(text,args=[])=>h.tx(null,'owner',tx=>tx.query(text,args));
  h.as=(role,text,args=[])=>h.tx(role,'role',tx=>tx.query(text,args));
  h.outcome=promise=>{
   const p=promise.then(value=>({value}),error=>({error}));h.pending.add(p);
   void p.then(()=>h.pending.delete(p));return p;
  };
  return h;
 }
 async function quiescent(h){
  assert.equal(h.borrowed.size,0);assert.equal(h.pending.size,0);assert.equal(h.holds.size,0);
  assert.equal(h.pool.waitingCount,0);assert.equal(h.pool.totalCount,h.pool.idleCount);
  assert.deepEqual(h.poolErrors,[]);
  assert.deepEqual((await admin.query("SELECT pid,state FROM pg_stat_activity WHERE datname=$1 "+
   "AND state IN ('idle in transaction','idle in transaction (aborted)')",[h.name])).rows,[]);
 }
 async function dispose(h){
  const failures=[];
  // Every local race owns its full-operation promises. Release owner first;
  // drain both outcomes before ROLLBACK/release and before pool.end.
  for(const hold of [...h.holds]){hold.release();h.holds.delete(hold);}
  await Promise.all([...h.pending]);
  if(h.pool&&!h.ended){
   for(const lease of [...h.borrowed])try{await h.release(lease);}catch(error){failures.push(error);}
   try{await quiescent(h);}catch(error){failures.push(error);}
   if(h.pool.waitingCount===0&&h.pool.totalCount===h.pool.idleCount){
    try{await h.pool.end();h.ended=true;}catch(error){failures.push(error);}
   }else failures.push(new Error('unaccounted borrower: refuse database drop before pool closure'));
  }
  if(h.created&&(!h.pool||h.ended)){
   try{
    const row=await first(admin,"SELECT oid,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,"+
     "shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[h.name]);
    assert.ok(row?.owned);
    if(h.oid!==null)assert.equal(row.oid,h.oid);
    // CREATE success is tracked immediately. If setup failed before COMMENT,
    // only that exact newly created name/owner/OID with no foreign tag is eligible.
    assert.equal(row.marker,h.tagged?tag:null);
    assert.deepEqual((await admin.query('SELECT pid FROM pg_stat_activity WHERE datid=$1',[row.oid])).rows,[],
     'pools/clients must be closed; never terminate foreign or unaccounted sessions');
    await admin.query('DROP DATABASE '+h.name);h.created=false;
   }catch(error){failures.push(error);}
  }
  if(!h.created)databases.delete(h);
  if(failures.length)throw aggregate(failures,'owned database cleanup failure');
 }
 async function useDatabase(label,fn){
  let h;const failures=[];
  try{h=await newDatabase(label);await fn(h);}catch(error){failures.push(error);}
  finally{if(h)try{await dispose(h);}catch(error){failures.push(error);}}
  if(failures.length)throw aggregate(failures,'scenario/setup/cleanup failure');
 }
 async function reconstructObserved(h){
  await h.query('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM '+runtime);
  const cols=(await h.query("SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "+
   "JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND "+
   "a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL")).rows;
  for(const {relname,attname} of cols){
   assert.match(relname,/^[a-z_]+$/);assert.match(attname,/^[a-z_]+$/);
   await h.query('REVOKE ALL PRIVILEGES ('+attname+') ON public.'+relname+' FROM '+runtime);
  }
  await h.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await h.query('GRANT USAGE ON SCHEMA public TO '+runtime);
  for(const [table,privileges] of Object.entries(observed)){
   assert.equal((await first(h,"SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass",['public.'+table])).relrowsecurity,false);
   await h.query('GRANT '+privileges.join(',')+' ON public.'+table+' TO '+runtime);
  }
  for(const [table,cols] of Object.entries(observedUpdates))
   await h.query('GRANT UPDATE('+cols.join(',')+') ON public.'+table+' TO '+runtime);
  for(const table of Object.keys(observed)){
   for(const action of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']){
    const r=await first(h,'SELECT has_table_privilege($1,$2,$3) AS ok',[runtime,'public.'+table,action]);
    assert.equal(r.ok,observed[table].includes(action),table+':'+action);
   }
   const cols=(await h.query("SELECT attname,has_column_privilege($1,attrelid,attname,'UPDATE') AS ok "+
    "FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped",[runtime,'public.'+table])).rows;
   for(const c of cols)assert.equal(c.ok,observed[table].includes('UPDATE')||(observedUpdates[table]??[]).includes(c.attname),table+'.'+c.attname);
  }
 }
 async function catalog(h){
  const result={};
  const queries={
   constraints:"SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition "+
    "FROM pg_constraint WHERE connamespace IN ('public'::regnamespace,'listening_v2'::regnamespace) ORDER BY 1,2",
   indexes:"SELECT schemaname,indexname,indexdef FROM pg_indexes WHERE schemaname IN ('public','listening_v2') ORDER BY 1,2",
   columns:"SELECT n.nspname,c.relname,a.attname,a.atttypid::regtype::text AS type,a.attnotnull,a.attacl::text AS acl,"+
    "pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "+
    "JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum "+
    "WHERE n.nspname IN ('public','listening_v2') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2,a.attnum",
   functions:"SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args,p.proacl::text AS acl,"+
    "p.proowner,p.prosecdef,p.proconfig,p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "+
    "WHERE n.nspname IN ('public','listening_v2') ORDER BY 1,2,3",
   domains:"SELECT n.nspname,t.typname,t.typacl::text AS acl,t.typowner FROM pg_type t "+
    "JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='listening_v2' AND t.typtype='d' ORDER BY 1,2",
   tables:"SELECT n.nspname,c.relname,c.relacl::text AS acl,c.relowner,c.relrowsecurity FROM pg_class c "+
    "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','listening_v2') AND c.relkind='r' ORDER BY 1,2"
  };
  for(const [key,text] of Object.entries(queries))result[key]=(await h.query(text)).rows;
  return result;
 }
 const oldKeyColumns=['key_id','user_id','audience','bundle_id','environment','public_key','receipt','sign_count','revoked','created_at'];
 const metadataColumns=['sessions_install_binding_version','sessions_authority_generation'];
 async function keyRights(h){return (await h.query(`SELECT r.rolname,a.attname,p.privilege,
  has_column_privilege(r.oid,a.attrelid,a.attnum,p.privilege) AS allowed
  FROM pg_roles r CROSS JOIN pg_attribute a CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
  WHERE r.rolname=ANY($1::text[]) AND a.attrelid='public.app_attest_keys'::regclass
  AND a.attname=ANY($2::text[]) ORDER BY 1,2,3`,[roles,oldKeyColumns])).rows;}
 async function keyTableRights(h){return (await h.query(`SELECT r.rolname,p.privilege,
  has_table_privilege(r.oid,'public.app_attest_keys',p.privilege) AS allowed
  FROM pg_roles r CROSS JOIN (VALUES ('SELECT'),('DELETE'),('TRUNCATE'),('TRIGGER'),('REFERENCES')) p(privilege)
  WHERE r.rolname=ANY($1::text[]) ORDER BY 1,2`,[roles])).rows;}
 async function schema(h,footprint){
  const paths=Object.keys(SOURCE_PINS).filter(p=>/^db\/\d{3}-.+\.sql$/.test(p)).sort();
  assert.deepEqual(paths.map(p=>Number(p.slice(3,6))),Array.from({length:34},(_,i)=>i+1));
  const apply=async path=>{
   // Execute the exact maintained SQL, including its own transaction statements.
   // On any setup error the borrowed client is rolled back/released before drop.
   const lease=await h.acquire();
   const failures=[];
   try{await lease.client.query(await sql(path));}catch(error){failures.push(error);}
   finally{try{await h.release(lease);}catch(error){failures.push(error);}}
   if(failures.length)throw aggregate(failures,'DDL/setup/release failure');
  };
  // Fixed roles already exist before every conditional historical grant.
  for(const path of paths.filter(p=>Number(p.slice(3,6))<=29))await apply(path);
  if(footprint==='observed')await reconstructObserved(h);
  for(const path of paths.filter(p=>Number(p.slice(3,6))>=30&&p!==migration))await apply(path);
  const before=await catalog(h),rights=await keyRights(h),tableRights=await keyTableRights(h);await apply(migration);const after=await catalog(h);
  // Text preservation of the two intentionally replaced closed sets, in
  // addition to the real pre/post PG catalog comparison below.
  const oldDDL=await sql('db/031-listening-v2-lifecycle-support.sql'),newDDL=await sql(migration);
  const closed=(source,name)=>{
   const match=source.match(new RegExp('ADD CONSTRAINT '+name+' CHECK \\(([\\s\\S]*?)\\n\\);'));
   assert.ok(match,name);return match[1];
  };
  assert.equal(closed(newDDL,'outbox_lifecycle_kind').replace(",'authority_terminal'",""),closed(oldDDL,'outbox_lifecycle_kind'));
  const terminalBranch="\n  OR (kind='authority_terminal' AND room_id IS NULL AND guard_id IS NULL AND persona_id IS NULL AND asset_id IS NULL"+
   "\n    AND privacy_generation IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)";
  assert.equal(closed(newDDL,'outbox_lifecycle_references').replace(terminalBranch,''),closed(oldDDL,'outbox_lifecycle_references'));
  for(const old of before.constraints){
   if(old.relation==='listening_v2.outbox'&&['outbox_lifecycle_kind','outbox_lifecycle_references'].includes(old.conname))continue;
   assert.ok(after.constraints.some(r=>JSON.stringify(r)===JSON.stringify(old)),old.conname);
  }
  const comparable=(key,r)=>['columns','tables'].includes(key)&&r.nspname==='public'&&r.relname==='app_attest_keys'
   ?Object.fromEntries(Object.entries(r).filter(([field])=>field!=='acl')):r;
  for(const key of ['indexes','columns','tables','functions','domains'])
   for(const old of before[key])assert.ok(after[key].some(r=>JSON.stringify(comparable(key,r))===JSON.stringify(comparable(key,old))),key+':'+JSON.stringify(old));
  assert.equal(after.columns.length-before.columns.length,2);
  assert.deepEqual(after.tables.map(r=>comparable('tables',r)),before.tables.map(r=>comparable('tables',r)));
  assert.deepEqual(await keyRights(h),rights,'preserve actual-role effective rights on every old key column');
  assert.deepEqual(await keyTableRights(h),tableRights,'preserve old SELECT/DELETE and unrelated table privileges');
  const relations=(await h.query("SELECT tablename FROM pg_tables WHERE schemaname='listening_v2' ORDER BY 1")).rows.map(r=>r.tablename);
  assert.deepEqual(relations,['command_receipts','outbox','output_guards','privacy_personas','private_profile_assets','returning_grants','rooms','semantic_events']);
  const functions=(await h.query("SELECT p.proname,p.prosecdef,p.proconfig,p.provolatile,"+
   "EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute "+
   "FROM pg_proc p WHERE p.pronamespace='listening_v2'::regnamespace "+
   "AND p.proname IN ('terminal_payload_valid','protect_terminal_job','protect_install_metadata') ORDER BY 1")).rows;
  assert.equal(functions.length,3);
  for(const f of functions){assert.equal(f.provolatile,f.proname==='terminal_payload_valid'?'i':'v');assert.equal(f.prosecdef,false);assert.deepEqual(f.proconfig,['search_path=pg_catalog']);assert.equal(f.public_execute,false);}
  for(const role of ownedRoles)await assertRole(role);
 }
 const selectors={
  credential:{kind:'credential',value:sha('synthetic-credential')},
  installation:{kind:'installation',value:sha('synthetic-installation'),bindingVersion:1,throughGeneration:0},
  transfer:{kind:'private-transfer',targetEnvironment:'preview:other',personaID:UUID,fromGeneration:0,toGeneration:1}
 };
 const payload=(selector=selectors.credential,extra={})=>({version:2,environment:'test',selector,invalidatedAtMS:0,phase:'rooms',cursor:null,...extra});
 const clock=async h=>numeric((await first(h,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms')).ms);
 async function job(h,p=payload()){
  const at=await clock(h),id=randomUUID();
  return {environment:p.environment,job_id:id,job_key:'authority-terminal:'+id,kind:'authority_terminal',
   payload:p,created_at_ms:at,due_at_ms:at,retry_until_ms:at+600000};
 }
 async function insert(tx,j){
  // Only these initial columns: the actual account role may use this statement.
  const columns=['environment','job_id','job_key','kind','payload','created_at_ms','due_at_ms','retry_until_ms'];
  return tx.query('INSERT INTO listening_v2.outbox('+columns.join(',')+') VALUES('+
   columns.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING *',columns.map(k=>j[k]));
 }
 const get=async(h,j)=>first(h,'SELECT to_jsonb(o)::text AS image FROM listening_v2.outbox o WHERE environment=$1 AND job_id=$2',[j.environment,j.job_id]);
 const imageRow=r=>JSON.parse(r.image); // Assertions only; CAS always uses exact PG text, never this reserialization.
 const clear={claim_nonce_hash:null,claim_until_ms:null};
 function update(tx,j,changes,image=null,live=false,due=false){
  const fields=Object.keys(changes);
  const allowed=['state','attempt_count','claim_epoch','claim_nonce_hash','claim_until_ms','payload','due_at_ms','completed_at_ms','delete_after_ms'];
  assert.ok(fields.every(k=>allowed.includes(k)));
  const args=[...fields.map(k=>changes[k]),j.environment,j.job_id];
  let where='o.environment=$'+(fields.length+1)+' AND o.job_id=$'+(fields.length+2);
  if(image!==null){args.push(image);where+=' AND to_jsonb(o)=$'+args.length+'::jsonb';}
  if(live)where+=' AND extract(epoch FROM clock_timestamp())*1000<o.claim_until_ms::numeric'+
   ' AND extract(epoch FROM clock_timestamp())*1000<o.retry_until_ms::numeric';
  if(due)where+=' AND extract(epoch FROM clock_timestamp())*1000>=o.due_at_ms::numeric'+
   ' AND extract(epoch FROM clock_timestamp())*1000<o.retry_until_ms::numeric';
  return tx.query('UPDATE listening_v2.outbox o SET '+fields.map((k,i)=>k+'=$'+(i+1)).join(',')+' WHERE '+where+' RETURNING *',args);
 }
 function claimChanges(r){return {state:'claimed',attempt_count:r.attempt_count+1,claim_epoch:numeric(r.claim_epoch)+1,
  claim_nonce_hash:sha(randomUUID()),claim_until_ms:r.retry_until_ms};}
 async function claim(h,j){
  const observed=await get(h,j),r=imageRow(observed);
  const result=await h.tx(runtime,'claim',tx=>update(tx,j,claimChanges(r),observed.image,false,true));
  assert.equal(result.rowCount,1);return get(h,j);
 }
 async function fail(h,j){
  const observed=await get(h,j),r=imageRow(observed),dead=r.attempt_count===10,at=await clock(h);
  const changes={state:dead?'dead':'pending',...clear,...(dead?{completed_at_ms:at,delete_after_ms:at+DAY}:{})};
  const result=await h.tx(runtime,'failure',tx=>update(tx,j,changes,observed.image));
  assert.equal(result.rowCount,1);return get(h,j);
 }
 function progressChanges(r,cursor){return {state:'pending',...clear,attempt_count:r.attempt_count-1,payload:{...r.payload,cursor}};}
 async function progress(h,j,cursor,observed=undefined){
  observed??=await get(h,j);
  return h.tx(runtime,'progress',tx=>update(tx,j,progressChanges(imageRow(observed),cursor),observed.image,true));
 }
 async function publish(h,j){
  const observed=await get(h,j),r=imageRow(observed),at=await clock(h);
  return h.tx(runtime,'publish',tx=>update(tx,j,{state:'published',...clear,attempt_count:r.attempt_count-1,
   payload:{...r.payload,phase:'complete',cursor:null},completed_at_ms:at,delete_after_ms:at+DAY},observed.image,true));
 }
 async function blocked(h,owner,contender){
  assert.notEqual(owner,contender);assert.ok(Number.isInteger(owner)&&Number.isInteger(contender));
  const deadline=Date.now()+2000;
  while(Date.now()<deadline){
   const row=await first(admin,'SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity '+
    'WHERE datname=$1 AND pid=$2',[h.name,contender]);
   if(row?.wait_event_type==='Lock'&&row.blockers.includes(owner))return row;
   // Reobserve database facts; no sleep or scheduling order establishes acceptance.
  }
  assert.fail('exact contender PID was not Lock-blocked by exact owner PID');
 }
 async function race(h,kind,injectObserver=false){
  const j=await job(h,payload({...selectors.credential,value:sha('race-'+kind+'-'+randomUUID())}));
  let observed;
  if(kind!=='insert'){
   await h.tx(account,'seed',tx=>insert(tx,j));
   observed=kind==='claim'?await get(h,j):await claim(h,j);
  }
  const hold=signal(),start=signal(),pending=[],failures=[];
  h.holds.add(hold);
  const release=()=>{hold.release();h.holds.delete(hold);};
  let a,b,ownerPID,contenderPID,witness;
  const mutation=(tx,second)=>{
   if(kind==='insert')return insert(tx,second?{...j,job_id:second.job_id,job_key:'authority-terminal:'+second.job_id,
    payload:{...j.payload,invalidatedAtMS:1}}:j);
   const r=imageRow(observed);
   return update(tx,j,kind==='claim'?claimChanges(r):progressChanges(r,['preview:a',UUID]),observed.image,kind==='refund',kind==='claim');
  };
  try{
   const ownerStart=signal();
   a=h.outcome(h.tx(kind==='insert'?account:runtime,'owner',async tx=>{
    const result=await mutation(tx,null);await hold.point();return result;
   },{started:ownerStart}));pending.push(a);
   ownerPID=await entered(ownerStart,a);await entered(hold,a);
   const second={job_id:randomUUID()};
   b=h.outcome(h.tx(kind==='insert'?account:runtime,'contender',tx=>mutation(tx,second),{started:start}));pending.push(b);
   contenderPID=await entered(start,b);
   witness=await blocked(h,ownerPID,contenderPID);
   t.diagnostic(JSON.stringify({kind,injectObserver,ownerPID,contenderPID,wait:witness.wait_event_type,blockers:witness.blockers}));
   if(injectObserver)throw new Error('injected terminal lock observer failure');
  }catch(error){failures.push(error);}
  finally{
   release();await Promise.all(pending); // Both full transactions, not just their queries.
   const check=async fn=>{try{await fn();}catch(error){failures.push(error);}};
   await check(async()=>{
    assert.ok(a&&b,'both contenders must start');assert.equal((await a).error,undefined);
    assert.equal((await a).value.rowCount,1);
    if(kind==='insert')assert.equal((await b).error?.code,'23505');
    else{assert.equal((await b).error,undefined);assert.equal((await b).value.rowCount,0);}
   });
   await check(async()=>{
    const r=imageRow(await get(h,j));
    assert.equal(r.attempt_count,kind==='claim'?1:0);
    assert.equal(numeric(r.claim_epoch),kind==='insert'?0:1);
    assert.equal(r.state,kind==='claim'?'claimed':'pending');
    assert.equal((await first(h,"SELECT count(*)::int AS n FROM listening_v2.outbox WHERE environment=$1 AND payload->'selector'=$2::jsonb",
     [j.environment,j.payload.selector])).n,1);
   });
   await check(()=>quiescent(h));
  }
  if(failures.length)throw aggregate(failures,'observer/contender/cleanup failure');
 }

 async function representation(h,footprint,parse){
  const maximal='preview:'+'z'.repeat(120);
  for(const role of roles){
   for(const selector of Object.values(selectors)){
    const p=payload(selector);
    assert.deepEqual(parse(JSON.stringify(p)),p);
    assert.equal((await h.as(role,'SELECT listening_v2.terminal_payload_valid($1::jsonb) AS ok',[p])).rows[0].ok,true);
    assert.equal((await h.as(role,'SELECT listening_v2.terminal_payload_valid($1::jsonb) AS ok',[{...p,extra:true}])).rows[0].ok,false);
   }
   const p=payload({...selectors.transfer,targetEnvironment:maximal,fromGeneration:MAX-1,toGeneration:MAX},{
    environment:maximal,invalidatedAtMS:MAX,cursor:[maximal,UUID],repair:{rootJobID:UUID,predecessorJobID:UUID,
     originalCreatedAtMS:MAX,originalRetryUntilMS:MAX,repairOrdinal:MAX}});
   assert.deepEqual(parse(JSON.stringify(p)),p);
   const r=(await h.as(role,'SELECT listening_v2.terminal_payload_valid($1::jsonb) AS ok,octet_length($1::jsonb::text)::int AS bytes',[p])).rows[0];
   assert.equal(r.ok,true);assert.ok(r.bytes<=4096);
  }
  const id='terminal-fixture-'+randomUUID();
  await h.query("INSERT INTO library_users(id,access_kind) VALUES($1,'guest')",[id]);
  const key=Buffer.alloc(32,footprint==='observed'?7:8).toString('base64');
  const seed=(role,key,version)=>h.as(role,
   'INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt,sessions_install_binding_version) '+
   "VALUES($1,$2,'terminal-pg-test','test.lyrica','development','synthetic-not-attestation',''::bytea,$3)",[key,id,version]);
  // Explicit metadata syntax fixtures are migration-owner-only, never enrollment.
  const ownerSeed=(key,version)=>h.query(
   'INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt,sessions_install_binding_version) '+
   "VALUES($1,$2,'terminal-pg-test','test.lyrica','development','synthetic-not-attestation',''::bytea,$3)",[key,id,version]);
  const legacy='unknown-'+randomUUID();await ownerSeed(legacy,null);await ownerSeed(key,1);
  for(const role of roles){
   const privilege=(await h.query("SELECT has_table_privilege($1,'public.app_attest_keys','INSERT') AS ins,"+
    "has_table_privilege($1,'public.app_attest_keys','UPDATE') AS upd,"+
    "has_column_privilege($1,'public.app_attest_keys','sessions_authority_generation','UPDATE') AS generation,"+
    "has_column_privilege($1,'public.app_attest_keys','sessions_install_binding_version','INSERT') AS provenance",[role])).rows[0];
   assert.deepEqual(privilege,{ins:false,upd:false,generation:false,provenance:false});
   for(const column of metadataColumns)for(const action of ['INSERT','UPDATE'])
    assert.equal((await first(h,'SELECT has_column_privilege($1,$2,$3,$4) AS ok',[role,'public.app_attest_keys',column,action])).ok,false);
   await code(h.as(role,'UPDATE public.app_attest_keys SET sessions_authority_generation=1 WHERE key_id=$1',[key]),'42501');
   await code(h.as(role,'UPDATE public.app_attest_keys SET sessions_install_binding_version=NULL WHERE key_id=$1',[key]),'42501');
   await code(seed(role,Buffer.alloc(32,role===runtime?21:22).toString('base64'),1),'42501');
   const oldWrites=role===account||footprint==='observed',freshKey='lt01-old-'+role;
   const oldInsert=()=>h.as(role,'INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) '+
    "VALUES($1,$2,'terminal-pg-test','test.lyrica','development','old-column-fixture',''::bytea)",[freshKey,id]);
   if(oldWrites){
    await oldInsert();
    assert.deepEqual(await first(h,'SELECT sessions_install_binding_version AS v,sessions_authority_generation::text AS g FROM public.app_attest_keys WHERE key_id=$1',[freshKey]),{v:null,g:'0'});
    for(const column of oldKeyColumns)assert.equal((await h.as(role,'UPDATE public.app_attest_keys SET '+column+'='+column+' WHERE key_id=$1',[freshKey])).rowCount,1);
    await h.as(role,"UPDATE public.app_attest_keys SET revoked=true,public_key='',receipt=''::bytea,sign_count=1 WHERE key_id=$1",[freshKey]);
   }else await code(oldInsert(),'42501');
  }
  // Account has actual DELETE capability; 23514 therefore proves the trigger.
  assert.equal((await first(h,"SELECT has_table_privilege($1,'public.app_attest_keys','DELETE') AS ok",[account])).ok,true);
  for(const [field,value] of [['key_id','changed'],['bundle_id','changed'],['audience','changed'],['environment','production'],
   ])
   await code(h.as(account,'UPDATE public.app_attest_keys SET '+field+'=$2 WHERE key_id=$1',[key,value]),'23514');
  await code(h.query('UPDATE public.app_attest_keys SET sessions_install_binding_version=1 WHERE key_id=$1',[legacy]),'23514');
  await code(h.query('UPDATE public.app_attest_keys SET sessions_install_binding_version=NULL WHERE key_id=$1',[key]),'23514');
  await h.query('UPDATE public.app_attest_keys SET sessions_authority_generation=$2 WHERE key_id=$1',[key,MAX]);
  await code(h.query('UPDATE public.app_attest_keys SET sessions_authority_generation=0 WHERE key_id=$1',[key]),'23514');
  await code(h.query('UPDATE public.app_attest_keys SET sessions_authority_generation=$2 WHERE key_id=$1',[key,'9007199254740992']),'23514');
  await code(h.as(account,'DELETE FROM public.app_attest_keys WHERE key_id=$1',[key]),'23514');
  await h.as(account,'DELETE FROM public.app_attest_keys WHERE key_id=$1',[legacy]);
  const smoke=await job(h,payload({...selectors.installation,value:sha('role-smoke-'+footprint)}));
  await h.tx(account,'role-initial',tx=>insert(tx,smoke));
  await code(h.tx(account,'role-no-claim',tx=>update(tx,smoke,{state:'claimed'})),'42501');
  await claim(h,smoke);assert.equal((await progress(h,smoke,['test',UUID])).rowCount,1);
  await claim(h,smoke);assert.equal((await publish(h,smoke)).rowCount,1);
  const settled=imageRow(await get(h,smoke));assert.equal(settled.attempt_count,0);
  assert.equal(settled.state,'published');assert.equal(numeric(settled.claim_epoch),2);
  t.diagnostic('LT01 '+footprint+': metadata INSERT/UPDATE withheld; old-column writes and account DELETE23514 exercised. No provenance claim.');
 }
 async function rowSimulation(h){
  const j=await job(h);await h.tx(account,'initial',tx=>insert(tx,j));
  const initial=imageRow(await get(h,j));
  for(let n=1;n<=9;n++){
   const c=await claim(h,j);
   if(n===1){
    await assert.rejects(h.tx(runtime,'failed-page',async tx=>{
     assert.equal((await update(tx,j,progressChanges(imageRow(c),['preview:a',UUID]),c.image,true)).rowCount,1);
     throw new Error('synthetic processing failure before page COMMIT');
    }),{message:'synthetic processing failure before page COMMIT'});
    assert.equal((await get(h,j)).image,c.image,'page/refund rollback retains committed claim debit');
   }
   await fail(h,j);assert.equal(imageRow(await get(h,j)).attempt_count,n);
  }
  for(let n=1;n<=11;n++){
   const claimed=await claim(h,j);assert.equal(imageRow(claimed).attempt_count,10);
   const current=imageRow(claimed),cursor=[n<=6?'preview:a':'preview:z',n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000'];
   // Full-envelope mismatch in EACH named field cannot refund. No query mocks.
   if(n===1)for(const field of ['claim_nonce_hash','claim_epoch','attempt_count','created_at_ms','due_at_ms','retry_until_ms',
    'claim_until_ms','completed_at_ms','delete_after_ms','job_key','room_id','guard_id','persona_id','asset_id',
    'privacy_generation','guard_revision','send_ordinal','state','kind','environment','job_id','payload']){
    const stale={...current};
    if(field==='payload')stale.payload={...current.payload,invalidatedAtMS:1};
    else if(field==='claim_nonce_hash')stale[field]=sha('stale');
    else if(typeof stale[field]==='number')stale[field]++;
    else stale[field]=stale[field]===null?'stale':'changed';
    const result=await h.tx(runtime,'stale-full-envelope',tx=>update(tx,j,progressChanges(current,cursor),JSON.stringify(stale),true));
    assert.equal(result.rowCount,0,field);
   }
   assert.equal((await progress(h,j,cursor,claimed)).rowCount,1);
   if(n===1)assert.equal((await progress(h,j,cursor,claimed)).rowCount,0,'lost-reply replay cannot refund twice');
   const settled=imageRow(await get(h,j));assert.equal(settled.attempt_count,9);
   for(const field of ['created_at_ms','due_at_ms','retry_until_ms'])assert.equal(settled[field],initial[field]);
   assert.equal(settled.payload.invalidatedAtMS,initial.payload.invalidatedAtMS);
  }
  await claim(h,j);assert.equal((await publish(h,j)).rowCount,1);
  const done=imageRow(await get(h,j));
  assert.equal(done.attempt_count,9);assert.equal(done.state,'published');assert.equal(done.payload.phase,'complete');
  assert.equal(numeric(done.claim_epoch),21);assert.equal(done.payload.cursor,null);
  for(const field of ['created_at_ms','due_at_ms','retry_until_ms'])assert.equal(done[field],initial[field]);
  // This simulates row pages ONLY. It creates/settles no room or semantic event.
 }
 async function failuresAndHandoff(h){
  const selector={...selectors.installation,value:sha('dead-debt')};
  const j=await job(h,payload(selector));await h.tx(account,'initial',tx=>insert(tx,j));
  await claim(h,j);
  const held=await get(h,j),r=imageRow(held);
  await code(h.tx(runtime,'no-progress',tx=>update(tx,j,progressChanges(r,null),held.image,true)),'23514');
  await fail(h,j);
  for(let n=1;n<10;n++){await claim(h,j);await fail(h,j);}
  const dead=await get(h,j),d=imageRow(dead);
  assert.equal(d.state,'dead');assert.equal(d.attempt_count,10);
  await code(claim(h,j),'23514');
  await code(h.tx(runtime,'no-reopen',tx=>update(tx,j,{state:'pending',completed_at_ms:null,delete_after_ms:null})),'23514');
  await code(h.tx(runtime,'no-refund',tx=>update(tx,j,{state:'published',attempt_count:9})),'23514');
  await code(h.tx(runtime,'no-debt-rewrite',tx=>update(tx,j,{state:'published',payload:{...d.payload,phase:'complete'}})),'23514');
  const newer=await job(h,payload(selector,{invalidatedAtMS:1}));
  await code(h.tx(account,'new-timestamp',tx=>insert(tx,newer)),'23505');
  const successor=await job(h,payload(selector,{cursor:d.payload.cursor,repair:{rootJobID:j.job_id,predecessorJobID:j.job_id,
   originalCreatedAtMS:d.created_at_ms,originalRetryUntilMS:d.retry_until_ms,repairOrdinal:1}}));
  await code(h.tx(account,'no-account-repair',tx=>insert(tx,successor)),'42501');
  for(const changes of [{state:'claimed'},{attempt_count:0}])
   await code(h.tx(account,'no-account-update',tx=>update(tx,j,changes)),'42501');
  await code(h.as(account,"INSERT INTO listening_v2.semantic_events(environment) VALUES('test')"),'42501');
  await code(h.as(account,'DELETE FROM listening_v2.outbox WHERE job_id=$1',[j.job_id]),'42501');
  // Atomic ROW handoff only. No repair/source authorization or successor derivation API.
  await assert.rejects(h.tx(runtime,'handoff-rollback',async tx=>{
   assert.equal((await update(tx,j,{state:'published'},dead.image)).rowCount,1);
   await insert(tx,successor);throw new Error('injected handoff failure');
  }),{message:'injected handoff failure'});
  assert.equal((await get(h,j)).image,dead.image);assert.equal(await get(h,successor),undefined);
  await h.tx(runtime,'handoff-win',async tx=>{
   assert.equal((await update(tx,j,{state:'published'},dead.image)).rowCount,1);await insert(tx,successor);
  });
  const handed=imageRow(await get(h,j));assert.deepEqual({...handed,state:'dead'},d);
  const child=imageRow(await get(h,successor));
  assert.equal(child.attempt_count,0);assert.equal(child.state,'pending');assert.deepEqual(child.payload.repair,successor.payload.repair);
  assert.deepEqual(child.payload.selector,d.payload.selector);assert.equal(child.payload.invalidatedAtMS,d.payload.invalidatedAtMS);
  await code(h.tx(runtime,'no-delete-evidence',tx=>tx.query('DELETE FROM listening_v2.outbox WHERE job_id=$1',[j.job_id])),'23514');
  const oldPayload={version:2,environment:'test',selector:{kind:'credential',value:sha('old-privacy')},invalidatedAtMS:0,cursor:null};
  const old=await job(h,oldPayload);old.kind='privacy_dependency';old.job_key='privacy-dependency:'+old.job_id;
  await h.tx(account,'old-family',tx=>insert(tx,old));
  await h.tx(runtime,'old-claim',tx=>update(tx,old,{state:'claimed',attempt_count:1,claim_epoch:1,claim_nonce_hash:sha('old-nonce'),claim_until_ms:old.retry_until_ms}));
  await h.tx(runtime,'old-progress',tx=>update(tx,old,{state:'pending',...clear,payload:{...oldPayload,cursor:['preview:z',UUID]}}));
  assert.equal(imageRow(await get(h,old)).attempt_count,1,'old cumulative privacy accounting stays unchanged');
 }
 async function replayBoundary(h,replay){
  const id='lt01-replay-'+randomUUID(),key=Buffer.alloc(32,55).toString('base64');
  await h.query('INSERT INTO public.library_users(id) VALUES($1)',[id]);
  // Owner-only syntactic anchor. Fresh key per database; never verified enrollment.
  await h.query('INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt,sessions_install_binding_version) '+
   "VALUES($1,$2,'terminal-pg-test','test.lyrica','development','fixture-only',''::bytea,1)",[key,id]);
  const withheld=async()=>{
   for(const role of roles){
    await code(h.as(role,'UPDATE public.app_attest_keys SET sessions_authority_generation=sessions_authority_generation+1 WHERE key_id=$1',[key]),'42501');
    await code(h.as(role,'INSERT INTO public.app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt,sessions_install_binding_version) '+
     "VALUES($1,$2,'terminal-pg-test','test.lyrica','development','fixture-only',''::bytea,1)",
     [Buffer.alloc(32,role===runtime?56:57).toString('base64'),id]),'42501');
   }
  };
  const lease=await h.acquire();let statements=0;
  try{
   const ownerPID=(await first(lease.client,'SELECT pg_backend_pid() AS pid')).pid;
   await replay({query:async text=>{
    // Real pg.Client WITHOUT BEGIN: each return is an actual autocommit
    // boundary. A split 025 GRANT then corrective REVOKE exposes metadata here.
    const result=await lease.client.query(text);statements++;
    await h.tx(account,'replay-independent-client',async tx=>{
     assert.notEqual((await first(tx,'SELECT pg_backend_pid() AS pid')).pid,ownerPID);
    });
    await withheld();return result;
   }});
   assert.equal(statements,1,'the replay is one indivisible server statement');
  }finally{await h.release(lease);}
  const before=await keyRights(h);
  await h.tx(null,'replay-existing-tx',async tx=>{
   await replay(tx);await withheld(); // Distinct client while replay tx is uncommitted.
  });
  await withheld();assert.deepEqual(await keyRights(h),before);
  assert.deepEqual(await first(h,'SELECT sessions_install_binding_version AS v,sessions_authority_generation::text AS g FROM public.app_attest_keys WHERE key_id=$1',[key]),{v:1,g:'0'});
  await quiescent(h);
 }
 async function defaultOffFinalizer(h,AccountStore,AppAuthStore){
  const policy={audience:'terminal-pg-test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
  const id='terminal-method-'+randomUUID(),key=Buffer.alloc(32,31).toString('base64');
  const credential=sha('synthetic-library-'+runID),bearer='lyra_s_'+sha('synthetic-session-'+runID),session=sha(bearer);
  await h.query("INSERT INTO library_users(id,access_kind) VALUES($1,'guest')",[id]);
  await h.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')",[credential,id]);
  await h.query("INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) "+
   "VALUES($1,$2,$3,'test.lyrica','development','synthetic-not-attestation',''::bytea)",[key,id,policy.audience]);
  await h.query("INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at) "+
   "VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')",[session,key,credential,policy.audience]);
  const adapter=(role,options={})=>({
   query:(text,args)=>h.tx(role,'actual-query',tx=>tx.query(text,args),options),
   transaction:fn=>h.tx(role,'actual-writer',fn,options)
  });
  const trace=[];
  const auth=new AppAuthStore(adapter(runtime),{policy});
  const user=await auth.authenticate(bearer);
  assert.equal(user.id,id);
  let drift=true;
  const db=adapter(account,{trace,afterSQL:async(text,client)=>{
   if(drift&&/^UPDATE library_tokens SET revoked=true WHERE digest=\$1$/.test(text)){
    // Owner-only same-client fixture injection, inside the actual writer tx.
    // Restore the tested role BEFORE the real final verifier; never grant it back.
    await client.query('RESET ROLE');
    try{await client.query('UPDATE app_attest_keys SET sessions_authority_generation=sessions_authority_generation+1 WHERE key_id=$1',[key]);}
    finally{await client.query('SET LOCAL ROLE '+account);}
    assert.equal((await first(client,'SELECT current_user AS role')).role,account);
   }
  }});
  const beforeConstruction=trace.length;
  const store=new AccountStore(db,{policy,apple:Object.freeze({}),spotifyCleanupFn:async()=>{}});
  assert.equal(trace.length,beforeConstruction,'construction default-off performs no SQL');
  let handle=await store.prepareWriterAuthentication(bearer);
  await code(store.signOut(user,handle),'app_access_revoked');
  let row=await first(h,'SELECT t.revoked,k.sessions_install_binding_version AS version,k.sessions_authority_generation::text AS generation '+
   'FROM library_tokens t JOIN app_attest_keys k ON k.user_id=t.user_id WHERE t.digest=$1',[credential]);
  assert.deepEqual(row,{revoked:false,version:null,generation:'0'},'unexpected metadata drift and auth mutation roll back together');
  drift=false;trace.length=0;handle=await store.prepareWriterAuthentication(bearer);
  assert.deepEqual(await store.signOut(user,handle),{signedOut:true});
  row=await first(h,'SELECT sessions_install_binding_version AS version,sessions_authority_generation::text AS generation FROM app_attest_keys WHERE key_id=$1',[key]);
  assert.deepEqual(row,{version:null,generation:'0'});
  assert.equal(trace.at(-1),'COMMIT');assert.match(trace.at(-2),/^WITH auth_clock AS MATERIALIZED/);
  for(const text of trace)assert.doesNotMatch(text,/listening_v2\./,'default-off actual method does not activate V2 writers');
  // SQL-seeded normal auth rows, not actual App Attest enrollment or Apple IO.
 }

 try{
  const marker=await preflight(); // No pg/application import or connection before refusal gates.
  ({default:pg}=await import('pg'));
  config={host:marker.socketDirectory,port:marker.port,user:marker.user,password:'',ssl:false,
   connectionTimeoutMillis:3000,statement_timeout:8000,lock_timeout:3000,idle_in_transaction_session_timeout:15000,
   options:'-c timezone=UTC',application_name:appName('admin')};
  admin=new pg.Client({...config,database:'postgres'});await admin.connect();connected=true;
  const identity=await first(admin,'SELECT current_database() AS database,current_user AS owner,session_user AS session_owner,'+
   'inet_server_addr() IS NULL AND inet_client_addr() IS NULL AS unix_only');
  assert.deepEqual(identity,{database:'postgres',owner:marker.user,session_owner:marker.user,unix_only:true});
  assert.equal((await first(admin,'SHOW listen_addresses')).listen_addresses,'');
  assert.equal(await realpath((await first(admin,'SHOW data_directory')).data_directory),await realpath(marker.dataDirectory));
  assert.equal((await first(admin,'SELECT system_identifier::text AS id FROM pg_control_system()')).id,marker.systemIdentifier);
  assert.equal(Number((await first(admin,'SHOW port')).port),marker.port);
  assert.equal((await first(admin,'SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rolsuper,true);
  assert.equal((await first(admin,'SHOW fsync')).fsync,'on');
  assert.equal((await first(admin,'SHOW synchronous_commit')).synchronous_commit,'on');
  assert.equal((await first(admin,'SHOW TimeZone')).TimeZone,'UTC');
  const version=(await first(admin,'SHOW server_version')).server_version;
  assert.ok(Number((await first(admin,'SHOW server_version_num')).server_version_num)>=170000);
  clusterLease=(await first(admin,'SELECT pg_try_advisory_lock(71309,32026) AS owned')).owned;
  assert.equal(clusterLease,true,'another fixed-role qualification owns the cluster');
  const {parseTerminalPayload}=await import('../../api/utils/listening-v2/terminal-codec.js');
  const {AccountStore}=await import('../../api/utils/membership/accounts.js');
  const {AppAuthStore}=await import('../../api/utils/app-auth/store.js');
  const {replayMembershipRoleGrants}=await import('../../scripts/membership-role-grants.js');
  // Actual roles are provisioned only AFTER 034 in this disposable database.
  await useDatabase('late',async h=>{
   await schema(h,'late');await createRoles();
   await replayBoundary(h,replayMembershipRoleGrants);
  });
  t.diagnostic(JSON.stringify({sourceCommit:marker.sourceCommit,base:BASE,version,systemIdentifier:marker.systemIdentifier,
   scope:'local reconstructed roles and row simulations; no deployed-role/source/enrollment/semantic/Release qualification'}));
  // Sequential explicit databases distinguish minimal DDL from reconstructed ACLs.
  for(const footprint of ['minimal','observed'])await useDatabase(footprint,async h=>{
   await schema(h,footprint);await representation(h,footprint,parseTerminalPayload);
   await replayBoundary(h,replayMembershipRoleGrants);
   if(footprint==='observed'){
    await rowSimulation(h);await failuresAndHandoff(h);
    for(const kind of ['insert','claim','refund']){
     await race(h,kind);
     await assert.rejects(race(h,kind,true),{message:'injected terminal lock observer failure'});
     await quiescent(h);
    }
    await defaultOffFinalizer(h,AccountStore,AppAuthStore);
   }
   await quiescent(h);
  });
 }catch(error){errors.push(error);}
 finally{
  // Covers preflight, import, connect, roles, CREATE, DDL, observer and assertion failures.
  for(const h of [...databases])try{await dispose(h);}catch(error){errors.push(error);}
  if(admin){
   try{
    if(connected){
     // No DROP OWNED, no default/preexisting database deletion, no role adoption.
     // Database-local dependencies must be gone before dropping only created roles.
     for(const role of [...ownedRoles].reverse()){
      try{
       const row=await roleIdentity(role);
       if(!row)continue; // Rolled-back CREATE never produced a surviving role.
       await assertRole(role);await admin.query('DROP ROLE '+role.name);
      }catch(error){errors.push(error);}
     }
     if(clusterLease)await admin.query('SELECT pg_advisory_unlock(71309,32026)');
    }
   }catch(error){errors.push(error);}
   finally{try{await admin.end();}catch(error){errors.push(error);}}
  }
 }
 if(errors.length)throw aggregate(errors,'manual qualification/refusal/cleanup failure');
});
