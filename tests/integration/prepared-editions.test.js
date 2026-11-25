import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {bundle} from '../helpers/prepared-edition.js';
import {PreparedEditionStore} from '../../api/utils/prepared-editions/store.js';
import {POOL,editionIdentity} from '../../api/utils/prepared-editions/core.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
const reply=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
async function setup(t){
 const {db,store}=await libraryDB();t.after(()=>db.close());
 const sql=await readFile(new URL('../../db/041-prepared-editions.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 const preparedStore=new PreparedEditionStore(store.db);
 const handler=createSongLibraryHandler({store,preparedStore,authStore:{authenticate:async()=>({id:'reader-a',isGuest:true})},
 loadLyrics:()=>assert.fail('lyric acquisition'),generateFn:()=>assert.fail('paid translation'),explainFn:()=>assert.fail('paid study'),translationAccess:()=>assert.fail('unlock'),waitUntilFn:()=>assert.fail('background work'),logger:{error(){}}});
 const call=async(body,authorized=true)=>{const r=reply();await handler({method:'POST',headers:authorized?{authorization:'Bearer lyrica_s_test_session'}:{},body},r);return r;};
 return {db,store,preparedStore,call};
}
const pinned=(b,p,extra={})=>({editionID:b.editionID,generation:p.generation,use:'read',...extra});
const ledger=async db=>Promise.all(['library_spend_operations','translation_jobs','study_explanations','membership_usage','membership_grants','starter_song_totals'].map(async table=>[table,(await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n]));
test('guest at zero allowance reads every prepared artifact without generation, unlock or selection analytics',async t=>{
 const {db,preparedStore,call}=await setup(t),b=bundle(),p=await preparedStore.publish(b),before=await ledger(db);
 const list=await call({action:'prepared_starters',languages:['cmn']});assert.equal(list.code,200);assert.equal(list.body.preparedStarters[0].songs.length,1);
 const lookup=await call({action:'prepared_lookup',variant:b.variants[0],use:'read'});assert.equal(lookup.body.edition.language,'cmn');assert.equal(lookup.body.edition.title,'Test song');
 const grant=await call({action:'prepared_grant',...pinned(b,p)});assert.equal(grant.code,200);assert.equal(grant.body.grant.onlineRequired,true);
 for(const [index,a] of b.artifacts.entries()){
  // Sweep all artifacts across simulated minute windows; retain the real limiter.
  if(index%25===0)await db.query("UPDATE library_rate_windows SET count=0 WHERE user_id='reader-a'");
  const r=await call({action:'prepared_artifact',...pinned(b,p),artifactID:a.id});
  assert.equal(r.code,200);assert.deepEqual(r.body.artifact,a);assert.equal(r.headers['Cache-Control'],'private, no-store');
 }
 assert.deepEqual(await ledger(db),before);
 assert.ok((await db.query("SELECT sum(count)::int AS n FROM library_rate_windows WHERE user_id='reader-a'")).rows[0].n>0);
 assert.equal((await call({action:'prepared_grant',...pinned(b,p)},false)).code,401);
});
test('exact mappings, source replacement, generation pin, unknown market and withdrawal fail closed',async t=>{
 const {preparedStore,call}=await setup(t),b=bundle();
 b.variants.push({...b.variants[0],storefront:'tw'});b.recordingEvidence.variants=b.variants;const p=await preparedStore.publish(b);
 assert.equal((await call({action:'prepared_lookup',variant:b.variants[1],use:'play'})).body.state,'ready');
 assert.deepEqual((await call({action:'prepared_lookup',variant:{...b.variants[0],storefront:'de'},use:'read'})).body,{version:1,state:'unprepared'});
 assert.equal((await call({action:'prepared_grant',...pinned(b,p,{use:'play'})})).code,400);
 assert.equal((await call({action:'prepared_artifact',...pinned(b,p,{use:'play',variant:{...b.variants[0],storefront:'de'}}),artifactID:b.artifacts[0].id})).code,403);
 assert.equal((await call({action:'prepared_grant',...pinned(b,{generation:'999'})})).body.code,'publication_changed');
 const w=await preparedStore.withdraw(b.editionID,p.generation);
 assert.equal((await call({action:'prepared_lookup',variant:b.variants[0],use:'read'})).body.code,'prepared_unavailable');
 assert.equal((await call({action:'prepared_artifact',...pinned(b,p),artifactID:b.artifacts[0].id})).body.code,'prepared_unavailable');
 await assert.rejects(preparedStore.publish(b,{expectedGeneration:p.generation,expectedHead:p.generation}),{code:'publication_changed'});
 b.rights.worldwide=false;b.rights.territories=['CA'];
 const p2=await preparedStore.publish(b,{expectedGeneration:w.generation,expectedHead:w.generation});
 // Client storefront is NOT permission for a territorial edition, even CA.
 assert.equal((await call({action:'prepared_lookup',variant:b.variants[0],use:'read'})).body.code,'prepared_unavailable');
 assert.deepEqual((await call({action:'prepared_starters',languages:['cmn'],catalogStorefront:'ca'})).body.preparedStarters[0].songs,[]);
 const changed=bundle();changed.artifacts[0].content.readingRevision='c'.repeat(64);
 const {artifact}=await import('../../api/utils/prepared-editions/core.js');changed.artifacts[0]=artifact('document',changed.artifacts[0].content);
 changed.coverage.requiredArtifactIDs=changed.artifacts.map(a=>a.id);changed.editionID=editionIdentity(changed);
 const p3=await preparedStore.publish(changed,{expectedHead:p2.generation});
 assert.equal((await call({action:'prepared_grant',...pinned(b,p2)})).body.code,'prepared_unavailable');
 assert.equal((await call({action:'prepared_lookup',variant:b.variants[0],use:'read'})).body.grant.generation,p3.generation);
});
test('list retains all eligible pool candidates in approved order and permits independent read without an Apple store',async t=>{
 const {preparedStore,call}=await setup(t);let head=null;
 for(const song of POOL.cmn.slice(0,4).reverse()){
  const b=bundle({song});
  head=(await preparedStore.publish(b,{expectedHead:head})).generation;
 }
 const res=await call({action:'prepared_starters',languages:['cmn']});assert.deepEqual(res.body.preparedStarters[0].songs.map(s=>s.songID),POOL.cmn.slice(0,4).map(s=>s.id));
 const ca=await call({action:'prepared_starters',languages:['cmn'],catalogStorefront:'ca'});assert.ok(ca.body.preparedStarters[0].songs.every(s=>s.variants.every(v=>v.storefront==='ca')));
 const first=res.body.preparedStarters[0].songs[0];assert.equal((await call({action:'prepared_grant',editionID:first.editionID,generation:first.generation,use:'read'})).code,200);
});
test('untrusted fields, wrong artifacts and exhausted read rate never run paid or publisher paths',async t=>{
 const {db,preparedStore,call}=await setup(t),b=bundle(),p=await preparedStore.publish(b);
 for(const body of [
  {action:'prepared_grant',...pinned(b,p),allowGeneration:true},
  {action:'prepared_grant',...pinned(b,p),territory:'CA'},
  {action:'prepared_artifact',...pinned(b,p),artifactID:b.artifacts[0].id,documentID:b.documentID},
  {action:'prepared_lookup',variant:{...b.variants[0],title:'unrelated'},use:'read'},
  {action:'prepared_starters',languages:['cmn'],catalogStorefront:'CA'}
 ])assert.equal((await call(body)).code,400);
 assert.equal((await call({action:'prepared_artifact',...pinned(b,p),artifactID:'f'.repeat(64)})).body.code,'artifact_unavailable');
 await db.query("UPDATE library_rate_windows SET count=60 WHERE user_id='reader-a'");
 assert.equal((await call({action:'prepared_grant',...pinned(b,p)})).code,429);
});
test('publication migration and late-role replay grant runtime reads only; no public publisher or budget access',async t=>{
 const {PGlite}=await import('@electric-sql/pglite'),{migrateLibrary}=await import('../../scripts/library-migrations.js');
 const db=new PGlite();t.after(()=>db.close());
 await migrateLibrary({transaction:fn=>db.transaction(tx=>fn({query:async(sql,args)=>args?tx.query(sql,args):(await tx.exec(sql)).at(-1)}))});
 await db.exec('CREATE ROLE lyrica_runtime_v1 NOLOGIN');
 const {replayMembershipRoleGrants}=await import('../../scripts/membership-role-grants.js');await replayMembershipRoleGrants({query:text=>db.exec(text)});
 for(const table of ['prepared_editions','prepared_edition_variants']){
  assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',['lyrica_runtime_v1',table,'SELECT'])).rows[0].ok,true);
  for(const p of ['INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',['lyrica_runtime_v1',table,p])).rows[0].ok,false);
 }
 for(const table of ['prepared_generation_runs','prepared_generation_attempts'])for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',['lyrica_runtime_v1',table,p])).rows[0].ok,false);
});
test('runtime DB projections return metadata/descriptors or exactly one requested artifact, never the full corpus for a list',async t=>{
 const {preparedStore}=await setup(t),b=bundle(),p=await preparedStore.publish(b);
 const listed=await preparedStore.all();assert.equal(listed[0].bundle.artifacts,undefined);
 const lookup=await preparedStore.lookup(b.variants[0]);assert.ok(lookup.bundle.artifacts.every(a=>a.content===undefined));
 const one=await preparedStore.edition(b.editionID,{artifactID:b.artifacts[0].id});assert.equal(one.bundle.artifacts.length,1);assert.deepEqual(one.bundle.artifacts[0],b.artifacts[0]);
 await preparedStore.withdraw(b.editionID,p.generation);assert.deepEqual(await preparedStore.all(),[]);
 assert.equal((await preparedStore.lookup(b.variants[0])).state,'withdrawn');
});
