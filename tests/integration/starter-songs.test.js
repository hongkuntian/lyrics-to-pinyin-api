import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {createSongLibraryService,createSongLibraryHandler} from '../../api/song-library.js';

// Contract: SONG_LIBRARY.md, "Starter songs". Real handler and store on PGlite.
const pool=JSON.parse(await readFile(new URL('../../api/data/starter-songs.json',import.meta.url),'utf8'));
const ids=language=>pool.languages[language].map(song=>song.id);
const reply=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
const totals=async db=>(await db.query('SELECT song_id,shown::int AS shown,picked::int AS picked FROM starter_song_totals ORDER BY song_id')).rows;

async function setup(t,options={}) {
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const handler=createSongLibraryService({store,selectionRevision:'test',loadLyrics:()=>assert.fail('lyrics lookup'),generateFn:()=>assert.fail('generation'),
    apiKey:'test',waitUntilFn:()=>assert.fail('background work'),logger:{error(){}},...options});
  const call=async(body,token='token-a')=>{const res=reply();await handler({method:'POST',lyricaUser:await store.authenticate(token),body},res);return res;};
  return {db,store,call};
}

test('starters returns each requested language\'s whole pool in a server-chosen order and writes nothing',async t=>{
  // Always the first index rotates each pool left by one.
  const {db,call}=await setup(t,{randomIndex:()=>0});
  const before=(await db.query("SELECT count(*)::int AS n FROM library_spend_operations")).rows[0].n;
  const res=await call({action:'starters',languages:['ja','cmn']});
  assert.equal(res.code,200);assert.equal(res.headers['Cache-Control'],'private, no-store');
  assert.deepEqual(Object.keys(res.body),['version','starters']);assert.equal(res.body.version,1);
  assert.deepEqual(res.body.starters.map(entry=>entry.language),['ja','cmn']);
  for(const entry of res.body.starters) {
    assert.deepEqual(entry.songs.map(song=>song.id),[...ids(entry.language).slice(1),ids(entry.language)[0]]);
    for(const song of entry.songs)assert.deepEqual(song,pool.languages[entry.language].find(row=>row.id===song.id));
  }
  assert.deepEqual((await call({action:'starters',languages:['ja','cmn']})).body,res.body);
  assert.deepEqual(await totals(db),[]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM library_spend_operations")).rows[0].n,before);
  for(const table of ['translation_jobs','study_explanations','membership_usage','membership_grants'])
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,table);
});

test('the default order is random: every pool song once, and repeated calls differ',async t=>{
  const {call}=await setup(t);
  const orders=new Set();
  for(let i=0;i<12;i++) {
    const {starters}=(await call({action:'starters',languages:['ko']})).body;
    assert.deepEqual(starters[0].songs.map(song=>song.id).sort(),ids('ko').sort());
    orders.add(starters[0].songs.map(song=>song.id).join());
  }
  // 12 draws of 8! orders: a repeat of one single order is a broken source.
  assert.ok(orders.size>1);
});

test('starters and starter_event reject malformed requests and unknown keys without writing',async t=>{
  const {db,call}=await setup(t);
  const [first,second]=ids('cmn');
  for(const body of [{action:'starters'},{action:'starters',languages:[]},{action:'starters',languages:'cmn'},{action:'starters',languages:['cmn','cmn']},
    {action:'starters',languages:['en']},{action:'starters',languages:['cmn','yue','ja','ko','es','fr','cmn']},{action:'starters',languages:['cmn'],count:3},
    {action:'starters',languages:['cmn'],shown:[first]},{action:'starters',languages:['cmn'],recording:{}},
    {action:'starter_event'},{action:'starter_event',shown:[first],picked:second},{action:'starter_event',shown:[]},{action:'starter_event',shown:[first,first]},
    {action:'starter_event',shown:[first,'cmn-0']},{action:'starter_event',shown:first},{action:'starter_event',picked:[first]},{action:'starter_event',picked:'cmn-0'},
    {action:'starter_event',picked:7},{action:'starter_event',shown:[first],languages:['cmn']},{action:'starter_event',picked:first,userID:'reader-a'},
    {action:'starter_event',picked:first,documentID:'x'},{action:'starter_events',picked:first}]) {
    const res=await call(body);
    assert.equal(res.code,400,JSON.stringify(body));assert.deepEqual(res.body,{version:1,code:'invalid_request'});
  }
  assert.deepEqual(await totals(db),[]);
  const unauthenticated=reply();
  await createSongLibraryService({store:{},logger:{error(){}}})({method:'POST',body:{action:'starter_event',picked:first}},unauthenticated);
  assert.equal(unauthenticated.code,401);
});

test('shown and picked totals accumulate across calls and accounts, with nothing about the caller stored',async t=>{
  const {db,call}=await setup(t);
  const [a,b,c]=ids('ja'),d=ids('fr')[0];
  const recorded=async(body,token)=>{const res=await call(body,token);assert.equal(res.code,200);assert.deepEqual(res.body,{version:1,state:'recorded'});};
  await recorded({action:'starter_event',shown:[a,b,c]},'token-a');
  await recorded({action:'starter_event',shown:[c,d,a]},'token-b');
  await recorded({action:'starter_event',picked:a},'token-a');
  await recorded({action:'starter_event',picked:a},'token-b');
  await recorded({action:'starter_event',picked:d},'token-b');
  await recorded({action:'starter_event',shown:[b]},'token-b');
  assert.deepEqual(await totals(db),[{song_id:d,shown:1,picked:1},{song_id:a,shown:2,picked:2},{song_id:b,shown:2,picked:0},{song_id:c,shown:2,picked:0}]
    .sort((x,y)=>x.song_id<y.song_id?-1:1));
  // Concurrent reports with overlapping songs all count.
  await Promise.all(Array.from({length:8},(_,i)=>recorded({action:'starter_event',shown:i%2?[a,b,d]:[d,b,a]},i%2?'token-a':'token-b')));
  assert.deepEqual((await totals(db)).map(row=>[row.song_id,row.shown]).sort(),[[a,10],[b,10],[c,2],[d,9]].sort());

  // The table has only the song id, the two totals and one row timestamp.
  assert.deepEqual((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='starter_song_totals' ORDER BY ordinal_position")).rows.map(row=>row.column_name),
    ['song_id','shown','picked','updated_at']);
  const stored=JSON.stringify((await db.query('SELECT * FROM starter_song_totals')).rows);
  for(const secret of ['reader-a','reader-b','token-a','token-b'])assert.equal(stored.includes(secret),false,secret);
  // One row per song, however many events: no per-event record exists.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM starter_song_totals')).rows[0].n,4);
});

test('both actions sit behind the app session and the per-account rate limit',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const authStore={authenticate:async token=>{assert.equal(token,'lyrica_s_session');return {id:'reader-a'};},limit:async()=>assert.fail('refresh limit')};
  const handler=createSongLibraryHandler({store,authStore,logger:{error(){}}});
  const post=async(body,authorization)=>{const res=reply();await handler({method:'POST',headers:authorization?{authorization}:{},body},res);return res;};
  const picked=ids('es')[0];
  for(const body of [{action:'starters',languages:['es']},{action:'starter_event',picked}]) {
    for(const authorization of [undefined,'Bearer token-a','Bearer lyrica_g_credentialcredential'])assert.equal((await post(body,authorization)).code,401);
  }
  assert.deepEqual(await totals(db),[]);
  assert.equal((await post({action:'starters',languages:['es']},'Bearer lyrica_s_session')).body.starters[0].songs.length,pool.languages.es.length);
  assert.deepEqual((await post({action:'starter_event',picked},'Bearer lyrica_s_session')).body,{version:1,state:'recorded'});
  assert.deepEqual(await totals(db),[{song_id:picked,shown:0,picked:1}]);
  assert.equal((await db.query("SELECT sum(count)::int AS n FROM library_rate_windows WHERE user_id='reader-a'")).rows[0].n,2);
  // Past 60 calls a minute the account is refused before the action runs.
  await db.query("UPDATE library_rate_windows SET count=60 WHERE user_id='reader-a'");
  await db.query("INSERT INTO library_rate_windows(user_id,window_start,count) VALUES('reader-a',date_trunc('minute',now()),60),('reader-a',date_trunc('minute',now()+interval '1 minute'),60) ON CONFLICT(user_id,window_start) DO UPDATE SET count=60");
  const limited=await post({action:'starter_event',picked},'Bearer lyrica_s_session');
  assert.equal(limited.code,429);assert.equal(limited.body.code,'rate_limited');
  assert.deepEqual(await totals(db),[{song_id:picked,shown:0,picked:1}]);
});
