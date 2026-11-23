import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {STARTER_LANGUAGES,STARTER_SONG_IDS,STARTER_CATALOG_IDS,shuffled,starterSongs,starterEvent,isStarterDocument,isStarterDocumentRow} from '../../api/utils/song-library/starter-songs.js';
import {makeDocument,recordingRequest,catalogRecordingKey} from '../../api/utils/song-library/document.js';

// Contract: SONG_LIBRARY.md, "Starter songs".
const pool=JSON.parse(await readFile(new URL('../../api/data/starter-songs.json',import.meta.url),'utf8'));
const invalid={code:'invalid_request',status:400};
const response={song:{id:'source-1',title:{original:'Original song'},artist:{original:'Test artist'},language:'zh',romanization_system:'pinyin'},
  lines:[{original:'一起唱',romanized:'yī qǐ chàng',timestamp:0}],metadata:{source:'test',selection_revision:'unit'},quality:{synced:true,partial:false,instrumental:false}};

test('the pool holds 46 songs in six languages, each a valid lyric request with an id the totals table accepts',()=>{
  assert.equal(pool.version,1);
  assert.deepEqual(STARTER_LANGUAGES,['cmn','yue','ja','ko','es','fr']);
  const songs=Object.values(pool.languages).flat();
  assert.equal(songs.length,46);assert.equal(new Set(songs.map(song=>song.id)).size,46);
  assert.deepEqual([...STARTER_SONG_IDS].sort(),songs.map(song=>song.id).sort());
  assert.equal(STARTER_CATALOG_IDS.length,48);
  for(const song of songs) {
    assert.deepEqual(Object.keys(song),['id','title','artist','year','recordings']);
    // db/040-starter-song-totals.sql: char_length(song_id) BETWEEN 1 AND 64.
    assert.match(song.id,/^[a-z]{2,3}-\d{1,20}$/);assert.ok(song.id.length<=64);
    assert.ok(Number.isInteger(song.year));assert.ok(song.recordings.length>=1);
    for(const row of song.recordings) {
      assert.deepEqual(Object.keys(row),['catalog_id','storefront','artist','title','album','duration']);
      assert.deepEqual(recordingRequest(row),row);assert.match(row.storefront,/^[a-z]{2}$/);assert.equal(typeof row.album,'string');
    }
  }
});

test('starters rejects anything but 1 to 6 distinct pool language keys',()=>{
  for(const languages of [undefined,null,'cmn',{0:'cmn',length:1},[],[...STARTER_LANGUAGES,'cmn'],['cmn','cmn'],['zh'],['CMN'],['cmn',''],[1],[null],[['cmn']],
    ['__proto__'],['constructor'],['toString'],['cmn','en']])
    assert.throws(()=>starterSongs(languages),invalid,JSON.stringify(languages));
  assert.equal(starterSongs(STARTER_LANGUAGES).length,6);
  assert.equal(starterSongs(['fr']).length,1);
});

test('starters keeps the request order and returns every pool song of each language exactly once',()=>{
  const order=['ko','cmn','fr','yue','es','ja'],reply=starterSongs(order);
  assert.deepEqual(reply.map(entry=>entry.language),order);
  for(const entry of reply) {
    assert.deepEqual(Object.keys(entry),['language','songs']);
    assert.deepEqual(entry.songs.map(song=>song.id).sort(),pool.languages[entry.language].map(song=>song.id).sort());
    assert.equal(new Set(entry.songs.map(song=>song.id)).size,entry.songs.length);
    for(const song of entry.songs)assert.deepEqual(song,pool.languages[entry.language].find(row=>row.id===song.id));
  }
  // The reply is a copy: a caller cannot change the pool.
  reply[0].songs[0].recordings[0].catalog_id='changed';reply[0].songs.length=0;
  assert.equal(starterSongs(['ko'])[0].songs.length,pool.languages.ko.length);
  assert.ok(starterSongs(['ko'])[0].songs.every(song=>song.recordings.every(row=>row.catalog_id!=='changed')));
});

test('the order comes from the injected random source, deterministically',()=>{
  const ids=language=>pool.languages[language].map(song=>song.id);
  // Always the last index: every element stays where it is.
  assert.deepEqual(starterSongs(['cmn','ja'],n=>n-1).map(entry=>entry.songs.map(song=>song.id)),[ids('cmn'),ids('ja')]);
  // Always the first index: the pool rotates left by one.
  const rotated=starterSongs(['cmn'],()=>0)[0].songs.map(song=>song.id);
  assert.deepEqual(rotated,[...ids('cmn').slice(1),ids('cmn')[0]]);
  assert.deepEqual(starterSongs(['cmn'],()=>0)[0].songs.map(song=>song.id),rotated);
  // Each language asks for its own indexes: n, n-1, ... 2.
  const asked=[];starterSongs(['yue','es'],n=>{asked.push(n);return 0;});
  const descending=n=>Array.from({length:n-1},(_,i)=>n-i);
  assert.deepEqual(asked,[...descending(pool.languages.yue.length),...descending(pool.languages.es.length)]);
  for(const bad of [()=>-1,n=>n,()=>0.5,()=>NaN,()=>'0'])assert.throws(()=>starterSongs(['cmn'],bad),/invalid_random_source/);
});

test('the shuffle is an unbiased Fisher–Yates: every index sequence gives a different permutation',()=>{
  const seen=new Map();
  for(let a=0;a<4;a++)for(let b=0;b<3;b++)for(let c=0;c<2;c++) {
    const picks=[a,b,c],bounds=[],input=['w','x','y','z'];
    const order=shuffled(input,n=>{bounds.push(n);return picks[bounds.length-1];}).join('');
    assert.deepEqual(bounds,[4,3,2]);assert.deepEqual(input,['w','x','y','z']);
    seen.set(order,(seen.get(order)??0)+1);
  }
  assert.equal(seen.size,24);assert.ok([...seen.values()].every(count=>count===1));
  // The default source yields a permutation too.
  assert.deepEqual(shuffled([1,2,3,4,5]).sort(),[1,2,3,4,5]);
  assert.deepEqual(shuffled([]),[]);assert.deepEqual(shuffled(['only']),['only']);
});

test('starter_event takes exactly one of shown (1 to 24 distinct pool ids) or picked (one pool id)',()=>{
  const [first,second]=STARTER_SONG_IDS;
  assert.deepEqual(starterEvent({action:'starter_event',shown:[second,first]}),{ids:[second,first],shown:1,picked:0});
  assert.deepEqual(starterEvent({action:'starter_event',picked:first}),{ids:[first],shown:0,picked:1});
  assert.equal(starterEvent({shown:STARTER_SONG_IDS.slice(0,24)}).ids.length,24);
  for(const input of [{},{shown:[first],picked:second},{shown:[first],picked:null},{shown:null},{shown:[]},{shown:first},{shown:STARTER_SONG_IDS.slice(0,25)},
    {shown:[first,first]},{shown:[first,'cmn-0']},{shown:[first,7]},{shown:[[first]]},{shown:{0:first,length:1}},{shown:['__proto__']},
    {picked:null},{picked:''},{picked:'cmn-0'},{picked:[first]},{picked:7},{picked:{id:first}},{picked:first.toUpperCase()}])
    assert.throws(()=>starterEvent({action:'starter_event',...input}),invalid,JSON.stringify(input));
});

test('a starter document is a stored Apple Music document for a pool catalog id in any storefront',()=>{
  const rows=Object.values(pool.languages).flat().flatMap(song=>song.recordings);
  // The stored key is the one makeDocument writes at lyrics time.
  for(const row of rows) {
    const doc=makeDocument(row,response,'unit',{});
    assert.equal(doc.recordingKey,catalogRecordingKey(row.catalog_id,row.storefront));
    assert.equal(isStarterDocument(doc),true,row.catalog_id);
    assert.equal(isStarterDocumentRow({recording_key:doc.recordingKey,source_capsule:null,selected_source:null}),true);
  }
  // The listener's own storefront, which the pool file never lists, and none at all.
  for(const id of STARTER_CATALOG_IDS)for(const storefront of ['us','gb','au','de','zz',undefined]) {
    const {artist,title,album,duration}=rows.find(row=>row.catalog_id===id);
    const doc=makeDocument({catalog_id:id,artist,title,album,duration,...(storefront?{storefront}:{})},response,'unit',{});
    assert.equal(isStarterDocument(doc),true,id+':'+storefront);
  }
  // Every storefront a lyrics request can carry (recordingRequest: absent or two lowercase letters).
  const letters='abcdefghijklmnopqrstuvwxyz';
  for(const a of letters)for(const b of letters) {
    assert.deepEqual(recordingRequest({...rows[0],storefront:a+b}).storefront,a+b);
    assert.equal(isStarterDocument({recordingKey:catalogRecordingKey(rows[0].catalog_id,a+b)}),true,a+b);
  }
  for(const storefront of ['US','usa','u','u1','é','',' us'])assert.throws(()=>recordingRequest({...rows[0],storefront}),{code:'invalid_recording'});
  // Another catalog id is not, even in a storefront the pool uses.
  for(const id of ['123','990000001',STARTER_CATALOG_IDS[0]+'0',STARTER_CATALOG_IDS[0].slice(1)])for(const storefront of ['ca','tw','us',undefined]) {
    const doc=makeDocument({catalog_id:id,artist:'Test artist',title:'Original song',duration:15,...(storefront?{storefront}:{})},response,'unit',{});
    assert.equal(isStarterDocument(doc),false,id+':'+storefront);
    assert.equal(isStarterDocumentRow({recording_key:doc.recordingKey}),false);
  }
  // Spotify and selected-source documents never are, whatever key they carry.
  const key=catalogRecordingKey(STARTER_CATALOG_IDS[0],'ca');
  assert.equal(isStarterDocument({recordingKey:key}),true);
  for(const doc of [{recordingKey:key,sourceCapsule:{provider:'lrclib'}},{recordingKey:key,selectedSourceCapsule:{provider:'lrclib'}},{recordingKey:key,selectedSource:{version:1}},
    {recordingKey:STARTER_CATALOG_IDS[0]},{recordingKey:undefined},{},null,undefined])assert.equal(isStarterDocument(doc),false);
  assert.equal(isStarterDocumentRow({recording_key:key}),true);
  for(const row of [{recording_key:key,source_capsule:{provider:'lrclib'}},{recording_key:key,selected_source:{provider:'lrclib'}},{recording_key:'recording-one'},{},null,undefined])
    assert.equal(isStarterDocumentRow(row),false);
});
