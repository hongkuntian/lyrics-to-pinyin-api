import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {activateMembership} from '../helpers/membership.js';
import {createSongLibraryService} from '../../api/song-library.js';
import {admitLibraryTranslation,MembershipStore} from '../../api/utils/membership/store.js';
import {retryTranslation} from '../../api/utils/song-library/translation-retry.js';
import {digest} from '../../api/utils/song-library/store.js';
import {languagePolicy} from '../../api/utils/song-library/languages.js';

// Starter songs are free (docs/memberships.md). Every test asserts the starter
// document and an ordinary document side by side, so a regression in either
// direction fails: a starter song that asks for payment, or a free ride for
// any other song.
const pool=JSON.parse(await readFile(new URL('../../api/data/starter-songs.json',import.meta.url),'utf8'));
const poolIDs=new Set(Object.values(pool.languages).flat().flatMap(song=>song.recordings.map(row=>row.catalog_id)));
const request=(row,storefront)=>({catalog_id:row.catalog_id,artist:row.artist,title:row.title,album:row.album,duration:row.duration,...(storefront?{storefront}:{})});
const first=pool.languages.cmn[0],second=pool.languages.ja[0];
// The app asks with the listener's own storefront, which the pool file never lists.
const starter=request(first.recordings[0],'us'),streamed=request(second.recordings[0],'gb');
// Not a pool catalog id, in a storefront the pool does list.
const ordinary={catalog_id:'990000001',artist:'Test artist',title:'Ordinary song',album:'Ordinary album',duration:15,storefront:'ca'};
assert.equal(first.recordings.some(row=>row.storefront==='us'),false);assert.equal(second.recordings.some(row=>row.storefront==='gb'),false);
assert.equal(poolIDs.has(ordinary.catalog_id),false);assert.ok(first.recordings.some(row=>row.storefront==='ca'));

const lyrics=(title,line)=>({song:{id:'source-'+title,title:{original:title},artist:{original:'Test artist'},language:'zh',romanization_system:'pinyin'},
  lines:[{original:line,romanized:'x',timestamp:0}],metadata:{source:'test',selection_revision:'test'},quality:{synced:true,partial:false,instrumental:false}});
const text={[starter.catalog_id]:'把今天唱成一首歌',[streamed.catalog_id]:'后天还想听你唱',[ordinary.catalog_id]:'明天也要一起唱'};
const sources=Object.fromEntries(Object.entries(text).map(([id,line])=>[id,lyrics('Song '+id,line)]));
const generateFn=async(doc,observer)=>{
  const lines=doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:'Sing it.',text:'Sing it.',speakerID:null,startsTurn:false}));
  for(const line of lines)observer?.onLine?.(line);
  return {content:{lines,sourceNotes:[],rejectedNotes:[]},actualMicros:1000,response:{id:'translation'}};
};
const lineFn=async(doc,translation,selections)=>({content:{items:selections.map(s=>({id:s.id,meaning:'Meaning',context:'Here.',grammar:'',uncertainty:'',sourceQuote:s.text}))},actualMicros:700,response:{id:'line'}});
const explainFn=async(doc,translation,selection)=>({content:{meaning:'Meaning',context:'Here.',grammar:'Grammar.',uncertainty:'',sourceQuote:selection.text},actualMicros:500,response:{id:'phrase'}});
const studied=doc=>({explanationLanguage:'en',documentID:doc.id,sourceHash:doc.sourceHash,studyText:{layer:'original',revisionID:doc.id,occurrenceID:'L0001'}});
const selection=(doc,lower,upper)=>({offsetUnit:'grapheme',ranges:[{lower,upper}],textHash:digest([...doc.response.lines[0].original].slice(lower,upper).join(''))});
const lineHelp=doc=>({action:'explain_line',contractVersion:1,...studied(doc),manifest:[{id:'w0-1',selection:selection(doc,0,1)},{id:'w1-3',selection:selection(doc,1,3)}]});
const phraseHelp=doc=>({action:'explain',contractVersion:2,...studied(doc),selection:selection(doc,3,5)});

async function setup(t,options={}) {
  const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];
  const service=patch=>createSongLibraryService({store,selectionRevision:'test',loadLyrics:async recording=>sources[recording.catalog_id],generateFn,lineFn,explainFn,
    apiKey:'test',waitUntilFn:task=>pending.push(task),logger:{error(){}},...options,...patch});
  const caller=handler=>async(body,token='token-a')=>{
    const res=new EventEmitter();Object.assign(res,{code:200,headers:{},frames:[],setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},
      json(value){this.body=value;return this;},write(frame){this.frames.push(JSON.parse(frame));return true;},end(){this.ended=true;},destroy(){this.emit('close');}});
    await handler({method:'POST',lyricaUser:await store.authenticate(token),body},res);return res;
  };
  const call=caller(service());
  // reader-a keeps the default beta kind and prepares shared translations.
  // reader-b is a plain free account: a guest, not beta, not unlimited, no entitlement.
  await db.query("UPDATE library_users SET access_kind='guest' WHERE id='reader-b'");
  const membership=new MembershipStore(store.db);
  const account=await membership.snapshot('reader-b');
  assert.deepEqual([account.account.kind,account.tier,account.isBeta,account.generationUnlimited,account.libraryTranslations.remaining],['guest','free',false,false,3]);
  const open=async recording=>{const doc=(await call({action:'lyrics',recording})).body.document;return {doc,ref:{documentID:doc.id,sourceHash:doc.sourceHash}};};
  const settle=async()=>{await Promise.all(pending.splice(0));};
  const count=async(table,where='true')=>(await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;
  // Membership ledger rows written for the free account.
  const ledger=async()=>({usage:await count('membership_usage',"user_id='reader-b'"),grants:await count('membership_grants',"user_id='reader-b'")});
  const refused=(res,status,code)=>{assert.equal(res.code,status,JSON.stringify(res.body));assert.equal(res.body.code,code);assert.equal(res.body.translation,undefined);};
  return {db,store,call,instance:patch=>caller(service(patch)),open,settle,count,ledger,refused,membership};
}
// The beta account prepares a shared translation for the document.
async function prepare(f,ref) {
  const res=await f.call({action:'translate',...ref,allowGeneration:true});
  if(res.code===202) {await f.settle();return res.body.job.id;}
  assert.equal(res.body.state,'ready');return null;
}

test('a free account reads a starter song\'s saved translation without an unlock; any other song stays locked',async t=>{
  const f=await setup(t),s=await f.open(starter),o=await f.open(ordinary);
  const starterJob=await prepare(f,s.ref),ordinaryJob=await prepare(f,o.ref);
  for(const body of [{action:'current',...s.ref},{action:'translate',...s.ref},{action:'current',...s.ref,target:'en'},{action:'translate',...s.ref,resumeOnly:true}]) {
    const res=await f.call(body,'token-b');
    assert.equal(res.code,200);assert.equal(res.body.state,'ready',body.action);assert.equal(res.body.translation.lines[0].text,'Sing it.');
  }
  const status=await f.call({action:'status',jobID:starterJob},'token-b');
  assert.equal(status.body.state,'ready');assert.equal(status.body.translation.lines[0].text,'Sing it.');
  for(const body of [{action:'current',...o.ref},{action:'translate',...o.ref},{action:'status',jobID:ordinaryJob}]) {
    const res=await f.call(body,'token-b');
    assert.equal(res.code,200);assert.equal(res.body.state,'locked',body.action);assert.equal(res.body.translation,undefined);
  }
  // Nothing was spent or recorded for the starter song.
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
  assert.deepEqual((await f.membership.snapshot('reader-b')).libraryTranslations,{unlimited:false,limit:3,used:0,remaining:3,nextAvailableAt:null});
  // An unlock sent for a starter song is accepted and still spends nothing.
  assert.equal((await f.call({action:'current',...s.ref,unlock:true},'token-b')).body.state,'ready');
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
  // The ordinary song opens only through an unlock, which uses one weekly read.
  assert.equal((await f.call({action:'current',...o.ref,unlock:true},'token-b')).body.state,'ready');
  assert.deepEqual(await f.ledger(),{usage:1,grants:1});
  assert.equal((await f.membership.snapshot('reader-b')).libraryTranslations.used,1);
  assert.equal(Number((await f.store.usage()).jobs),2);
});

test('at its weekly limit, or with its allowance held, a free account still reads starter songs and no other',async t=>{
  const f=await setup(t),s=await f.open(starter),o=await f.open(ordinary);
  await prepare(f,s.ref);await prepare(f,o.ref);
  for(const id of ['other-1','other-2','other-3'])await admitLibraryTranslation(f.db,'reader-b',id,{unlock:true});
  f.refused(await f.call({action:'current',...o.ref,unlock:true},'token-b'),403,'library_translation_limit');
  assert.equal((await f.call({action:'current',...o.ref},'token-b')).body.state,'locked');
  for(const unlock of [undefined,true])assert.equal((await f.call({action:'current',...s.ref,...(unlock?{unlock}:{})},'token-b')).body.state,'ready');
  assert.deepEqual(await f.ledger(),{usage:3,grants:1});

  const held=await setup(t),hs=await held.open(starter),ho=await held.open(ordinary);
  await prepare(held,hs.ref);await prepare(held,ho.ref);
  await held.db.query("UPDATE library_users SET free_allowance_held_until=now()+interval '7 days' WHERE id='reader-b'");
  held.refused(await held.call({action:'current',...ho.ref,unlock:true},'token-b'),403,'library_translation_limit');
  assert.equal((await held.call({action:'translate',...hs.ref},'token-b')).body.state,'ready');
  assert.deepEqual(await held.ledger(),{usage:0,grants:0});
});

test('a pool catalog id is a starter document in every storefront; another catalog id in a pool storefront is not',async t=>{
  const f=await setup(t);
  // The same song has two catalog ids in the pool file; both are starter songs.
  const paired=pool.languages.cmn.find(song=>new Set(song.recordings.map(row=>row.catalog_id)).size===2);
  assert.ok(paired);
  const starters=[starter,request(first.recordings[0],first.recordings[0].storefront),request(first.recordings[0]),request(first.recordings[0],'de'),
    ...paired.recordings.map(row=>request(row,'au'))];
  const others=[ordinary,{...ordinary,storefront:'tw'},{...ordinary,catalog_id:starter.catalog_id+'0'},{...ordinary,catalog_id:starter.catalog_id.slice(1)}];
  for(const recording of [...starters,...others])sources[recording.catalog_id]??=lyrics('Song '+recording.catalog_id,'每首歌都有一行词'+recording.catalog_id);
  const documents=new Set();
  for(const [recordings,state] of [[starters,'ready'],[others,'locked']])for(const recording of recordings) {
    const {doc,ref}=await f.open(recording);documents.add(doc.id);
    await prepare(f,ref);
    const res=await f.call({action:'current',...ref},'token-b');
    assert.equal(res.code,200);assert.equal(res.body.state,state,recording.catalog_id+':'+recording.storefront);
    assert.equal(Boolean(res.body.translation),state==='ready');
  }
  // Each request made its own stored document: nothing above came from the request body.
  assert.equal(documents.size,starters.length+others.length);
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
});

test('a free account starts a starter song\'s translation without Pro or a Generate tap; any other song still refuses',async t=>{
  const f=await setup(t),s=await f.open(starter),o=await f.open(ordinary);
  f.refused(await f.call({action:'translate',...o.ref},'token-b'),409,'generation_required');
  f.refused(await f.call({action:'translate',...o.ref,allowGeneration:true},'token-b'),403,'membership_required');
  f.refused(await f.call({action:'translate',...o.ref,allowGeneration:true,delivery:'progressive-v1'},'token-b'),403,'membership_required');
  assert.equal(await f.count('translation_jobs'),0);

  const started=await f.call({action:'translate',...s.ref},'token-b');
  assert.equal(started.code,202);assert.equal(started.body.state,'preparing');assert.equal(started.body.job.documentID,s.doc.id);
  await f.settle();
  const ready=await f.call({action:'current',...s.ref},'token-b');
  assert.equal(ready.body.state,'ready');assert.equal(ready.body.translation.lines[0].text,'Sing it.');
  assert.deepEqual((await f.db.query('SELECT user_id,state,document_id FROM translation_jobs')).rows,[{user_id:'reader-b',state:'ready',document_id:s.doc.id}]);
  // No allowance, grant or weekly read was touched; the money is still accounted.
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
  assert.equal(Number((await f.store.usage()).jobs),1);assert.equal(Number((await f.store.budget()).daily),1000);

  // Draft lines stream to the free account for a starter song.
  const g=await f.open(streamed);
  const stream=await f.call({action:'translate',...g.ref,delivery:'progressive-v1'},'token-b');
  assert.deepEqual(stream.frames.map(frame=>frame.event),['start','line','complete']);assert.equal(stream.frames[2].translation.lines[0].text,'Sing it.');
  await f.settle();
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
  // The ordinary song is exactly as before.
  f.refused(await f.call({action:'translate',...o.ref},'token-b'),409,'generation_required');
  f.refused(await f.call({action:'translate',...o.ref,allowGeneration:true},'token-b'),403,'membership_required');
  assert.equal(await f.count('translation_jobs',`document_id='${o.doc.id}'`),0);
});

test('a free account gets word help on a starter song; any other song still refuses',async t=>{
  const f=await setup(t),s=await f.open(starter),o=await f.open(ordinary);
  for(const body of [lineHelp(o.doc),phraseHelp(o.doc)]) {
    f.refused(await f.call(body,'token-b'),409,'generation_required');
    f.refused(await f.call({...body,allowGeneration:true},'token-b'),403,'membership_required');
  }
  assert.equal(await f.count('study_explanations'),0);

  const line=await f.call(lineHelp(s.doc),'token-b');
  assert.equal(line.code,202);assert.equal(line.body.state,'preparing');await f.settle();
  const batch=await f.call({...lineHelp(s.doc),readOnly:true},'token-b');
  assert.equal(batch.body.state,'ready');assert.deepEqual(batch.body.batch.items.map(item=>item.sourceQuote),['把','今天']);
  const phrase=await f.call(phraseHelp(s.doc),'token-b');
  assert.equal(phrase.code,202);assert.equal(phrase.body.state,'preparing');await f.settle();
  const explained=await f.call(phraseHelp(s.doc),'token-b');
  assert.equal(explained.body.state,'ready');assert.equal(explained.body.explanation.sourceQuote,'唱成');
  assert.deepEqual((await f.db.query('SELECT user_id,state,document_id FROM study_explanations ORDER BY recipe')).rows,
    [{user_id:'reader-b',state:'ready',document_id:s.doc.id},{user_id:'reader-b',state:'ready',document_id:s.doc.id}]);
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
  assert.equal(Number((await f.store.budget()).daily),1200);

  for(const body of [lineHelp(o.doc),phraseHelp(o.doc)]) {
    f.refused(await f.call(body,'token-b'),409,'generation_required');
    f.refused(await f.call({...body,allowGeneration:true},'token-b'),403,'membership_required');
  }
  assert.equal(await f.count('study_explanations',`document_id='${o.doc.id}'`),0);
});

test('a member\'s monthly allowance is not used by starter songs and still is by any other song',async t=>{
  const f=await setup(t),s=await f.open(starter),o=await f.open(ordinary);
  await activateMembership(f.store.db,'reader-b');
  const used=async()=>{const {allowances}=await f.membership.snapshot('reader-b');return [allowances.translation.used,allowances.study.used];};
  assert.equal((await f.call({action:'translate',...s.ref},'token-b')).code,202);await f.settle();
  assert.equal((await f.call(lineHelp(s.doc),'token-b')).code,202);await f.settle();
  assert.equal((await f.call(phraseHelp(s.doc),'token-b')).code,202);await f.settle();
  assert.deepEqual(await used(),[0,0]);assert.deepEqual(await f.ledger(),{usage:0,grants:0});

  f.refused(await f.call({action:'translate',...o.ref},'token-b'),409,'generation_required');
  assert.equal((await f.call({action:'translate',...o.ref,allowGeneration:true},'token-b')).code,202);await f.settle();
  assert.equal((await f.call({...lineHelp(o.doc),allowGeneration:true},'token-b')).code,202);await f.settle();
  assert.deepEqual(await used(),[1,1]);assert.deepEqual(await f.ledger(),{usage:2,grants:2});
});

test('a starter song keeps every other check: spending caps, the kill switch, language policy and source identity',async t=>{
  const f=await setup(t),s=await f.open(starter);
  const attempts=[{action:'translate',...s.ref},lineHelp(s.doc),phraseHelp(s.doc)];
  const each=async(call,status,code)=>{for(const body of attempts)f.refused(await call(body,'token-b'),status,code);};
  await f.store.configure({enabled:false,dailyMicros:1_000_000,monthlyMicros:5_000_000});
  await each(f.call,503,'generation_disabled');
  await f.store.configure({enabled:true,dailyMicros:1,monthlyMicros:5_000_000});
  await each(f.call,429,'budget_exhausted');
  await f.store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000});
  await f.db.query('UPDATE library_settings SET emergency_daily_micros=1 WHERE id=1');
  await each(f.call,429,'emergency_budget_exhausted');
  await f.db.query('UPDATE library_settings SET emergency_daily_micros=5000000 WHERE id=1');
  await each(f.instance({languagePolicy:languagePolicy({translation:[],explanation:[]})}),422,'unsupported_direction');
  await each(f.instance({apiKey:''}),503,'generation_not_configured');
  for(const body of attempts)f.refused(await f.call({...body,sourceHash:'changed'},'token-b'),409,'source_changed');
  assert.equal(await f.count('translation_jobs'),0);assert.equal(await f.count('study_explanations'),0);
  assert.equal(Number((await f.store.budget()).daily),0);

  // One piece of work per account at a time, starter song or not.
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const slow=f.instance({generateFn:async(...args)=>{await gate;return generateFn(...args);}});
  assert.equal((await slow({action:'translate',...s.ref},'token-b')).code,202);
  f.refused(await f.call(lineHelp(s.doc),'token-b'),429,'user_busy');
  release();await f.settle();
  assert.equal((await f.call(lineHelp(s.doc),'token-b')).code,202);await f.settle();
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
});

test('an operator can retry a free account\'s failed starter translation; any other song still needs membership',async t=>{
  const f=await setup(t),s=await f.open(starter),o=await f.open(ordinary);
  const args=jobID=>({jobID,expectedAttempt:1,requestKey:'recovery-'+jobID,actor:'operator',reason:'Retry after a known failure'});
  const failed=async(userID,documentID)=>{
    const {job}=await f.store.reserve({userID,documentID,target:'en',recipe:'fixture',reservedMicros:30_000});
    await f.store.claim(job.id);await f.store.fail(job.id,'provider_incomplete',800,{id:'first'});return job.id;
  };
  // The free account may start only the starter song; the beta account starts the other.
  await assert.rejects(f.store.reserve({userID:'reader-b',documentID:o.doc.id,target:'en',recipe:'fixture',reservedMicros:30_000}),{code:'generation_required'});
  const starterJob=await failed('reader-b',s.doc.id),ordinaryJob=await failed('reader-a',o.doc.id);
  await f.db.query("UPDATE library_users SET access_kind='guest' WHERE id='reader-a'");
  await assert.rejects(retryTranslation(f.db,args(ordinaryJob)),{code:'membership_required',status:403});
  assert.deepEqual(await retryTranslation(f.db,args(starterJob)),{jobID:starterJob,attempt:2});
  assert.equal((await f.store.job(starterJob)).state,'queued');assert.equal((await f.store.job(ordinaryJob)).state,'failed');
  assert.deepEqual(await f.ledger(),{usage:0,grants:0});
  assert.equal(await f.count('membership_usage'),0);
});
