import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {digest} from '../../api/utils/song-library/store.js';
import {recordingRequest,requestKey,makeDocument} from '../../api/utils/song-library/document.js';
import {canonicalJSON,spotifyHashes,sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {recordingScore,findRecording} from '../../api/utils/recording-match.js';
const vectors=JSON.parse(readFileSync(new URL('../fixtures/spotify-recording-vectors.json',import.meta.url)));
const minimal=vectors.fixtures[0].recording;
const request=(artists=['A & B'],extra={})=>({recordingProvider:'spotify',artist:artists.join(' & '),creditedArtistNames:artists,title:'Song',duration:240,...extra});
const candidate=(extra={})=>({id:'source',artist:'A & B',title:'Song',duration:240,...extra});
test('Spotify explicit catalog flag qualifies an explicit release marker without qualifying other editions',()=>{
 const source=candidate({album:'Album (Explicit)'}),target=request(['A & B'],{album:'Album',explicit:true});
 assert.ok(recordingScore(source,target)>=0);
 for(const explicit of [false,undefined])assert.equal(recordingScore(source,{...target,explicit}),-1);
 assert.equal(recordingScore({...source,explicit:false},target),-1);
 for(const label of ['Clean','Live','Remix','2015 Remaster','Acoustic'])assert.equal(recordingScore({...source,album:`Album (${label})`},target),-1);
 // Positive flags do not require an otherwise unlabelled provider to add a suffix.
 assert.ok(recordingScore(candidate({album:'Album'}),target)>=0);
});
test('Apple known explicitness conflicts reject before ordinary source ranking',()=>{
 const source={id:42,artist:'Test',title:'Synthetic',album:'Example',duration:120,explicit:true};
 assert.equal(recordingScore(source,{...source,explicit:false}),-1);
 assert.ok(recordingScore(source,{...source,explicit:true})>=0);
});
test('published V2 hashes and unchanged Apple request bytes match the frozen vectors',()=>{
  for(const f of vectors.fixtures) {
    const r=recordingRequest(f.recording);assert.deepEqual(r,f.recording);
    const hashes=spotifyHashes(r,f.source,f.selectionRevision);
    for(const [key,value] of Object.entries(f.hashes))assert.equal(hashes[key],value.sha256,key);
    assert.equal(requestKey(r),f.hashes.requestHash.sha256);
  }
  const legacy=JSON.parse(readFileSync(new URL('../fixtures/legacy-apple-recording-vectors.json',import.meta.url)));
  const apple=recordingRequest({catalog_id:'123',artist:'Artist',title:'Title',duration:240});
  assert.equal(JSON.stringify(apple),legacy.requestKeyCanonical);assert.deepEqual(apple,legacy.normalized);
  assert.equal(digest({catalogID:apple.catalog_id,storefront:apple.storefront}),legacy.recordingKey);
  assert.equal(requestKey({catalog_id:'123',artist:'Artist',title:'Title',duration:240}),'bdaba34af78107e842fa070fdae9c58a6f59d4cc470b50c4468d87491eb6d54e');
  assert.equal(requestKey({catalog_id:'123',artist:'Artist',title:'Title',duration:240,isrc:'USABC2600001',account_storefront:'us'}),'bdaba34af78107e842fa070fdae9c58a6f59d4cc470b50c4468d87491eb6d54e');
});
test('V2 rejects unknown, mixed, null, malformed and non-scalar inputs without trimming legal names',()=>{
  const bad=[{...minimal,version:3},{...minimal,provider:'apple'},{...minimal,catalog_id:'123'},{...minimal,item_id:'spotify:track:'+minimal.item_id},
    {...minimal,item_id:' '+minimal.item_id},{...minimal,market:null},{...minimal,requested_item_id:null},{...minimal,match:{}},
    ...[null,0,true,'240000',240.1,Infinity,7200001,-0].map(duration_ms=>({...minimal,metadata:{...minimal.metadata,duration_ms}})),
    ...['',' ','x\u0001','x\u0085','x\ud800','x'.repeat(501)].map(title=>({...minimal,metadata:{...minimal.metadata,title}})),
    ...[[],Array(33).fill('A'),['A',null]].map(artists=>({...minimal,metadata:{...minimal.metadata,artists}})),
    ...[{album:null},{isrc:null},{explicit:null},{origin:'independent_lyric_source'},{token:'secret'}].map(m=>({...minimal,metadata:{...minimal.metadata,...m}}))];
  for(const value of bad)assert.throws(()=>recordingRequest(value),{code:'invalid_recording'});
  const r={...minimal,metadata:{...minimal.metadata,title:' 🎵 Song / é ',artists:['A','A'],album:'🎵'.repeat(500)}};
  assert.deepEqual(recordingRequest(r),r);
  for(const value of [undefined,NaN,Infinity,-0,{bad:undefined},['\ud800'],new Date(),{toJSON(){return 'bad';}}])assert.throws(()=>canonicalJSON(value));
  assert.equal(canonicalJSON({z:'測試 / 🎵',a:'e\u0301'}),'{"a":"é","z":"測試 / 🎵"}');
});
test('whole credited names preserve boundaries, multiplicity, order and explicit title guests',()=>{
  assert.ok(recordingScore(candidate({creditedArtistNames:['A & B']}),request())>=0);
  assert.equal(recordingScore(candidate({creditedArtistNames:['A','B']}),request()),-1);
  assert.equal(recordingScore(candidate({creditedArtistNames:['A & B']}),request(['A','B'])),-1);
  assert.ok(recordingScore(candidate({artist:'GUEST & A & B',creditedArtistNames:['Guest','A & B']}),request(['A & B','Ｇｕｅｓｔ']))>=0);
  assert.equal(recordingScore(candidate({creditedArtistNames:['A']}),request(['A','A'])),-1);
  assert.equal(recordingScore(candidate({artist:'A',creditedArtistNames:['A']}),request(['A','Guest'])),-1);
  assert.equal(recordingScore(candidate({artist:'A',creditedArtistNames:['A']}),request(['A'],{title:'Song (feat. Guest)'})),-1);
  assert.ok(recordingScore(candidate({artist:'A & Guest',creditedArtistNames:['A','Guest']}),request(['A'],{title:'Song (feat. Guest)'}))>=0);
  assert.ok(recordingScore(candidate({artist:'Earth, Wind & Fire',creditedArtistNames:['Earth, Wind & Fire']}),request(['Earth, Wind & Fire']))>=0);
  assert.equal(recordingScore(candidate({artist:'A & B & A & B'}),request(['A & B','A','B'])),-1);
});
test('Spotify requires positive source duration, corroborates ISRC, and preserves version evidence',()=>{
  for(const duration of [undefined,null,NaN,0,244])assert.equal(recordingScore(candidate({duration}),request()),-1);
  assert.ok(recordingScore(candidate({duration:243}),request())>=0);
  assert.equal(recordingScore(candidate({isrc:'USABC2600002'}),request(['A & B'],{isrc:'USABC2600001'})),-1);
  for(const label of ['Live','Remastered','Acoustic','Radio Edit','Clean','Explicit','Remix']) {
    assert.throws(()=>findRecording([candidate({album:`Album (${label})`})],request(['A & B'],{album:'Album'})),{code:'recording_mismatch'});
    assert.equal(recordingScore(candidate({title:`Song (${label})`}),request()),-1);
  }
  assert.throws(()=>findRecording([candidate({id:'one'}),candidate({id:'two'})],request()),{reason:'duplicate_candidates'});
});

test('source revisions separate item, optional request hints, text, cue and reading changes',()=>{
  const f=vectors.fixtures[0],h=spotifyHashes(f.recording,f.source,f.selectionRevision);
  const hint=spotifyHashes(vectors.fixtures[1].recording,f.source,f.selectionRevision);
  assert.notEqual(h.requestHash,hint.requestHash);assert.equal(h.documentID,hint.documentID);assert.equal(h.timingRevision,hint.timingRevision);
  const other=spotifyHashes({...f.recording,item_id:'0123456789ABCDEFGHIJKM'},f.source,f.selectionRevision);
  assert.notEqual(other.recordingKey,h.recordingKey);assert.notEqual(other.documentID,h.documentID);assert.notEqual(other.timingRevision,h.timingRevision);assert.equal(other.sourceHash,h.sourceHash);
  const timed=structuredClone(f.source);timed.lines[0].timestamp+=1;
  const t=spotifyHashes(f.recording,timed,f.selectionRevision);assert.notEqual(t.timingRevision,h.timingRevision);assert.equal(t.textRevision,h.textRevision);assert.equal(t.readingRevision,h.readingRevision);
  const read=structuredClone(f.source);read.lines[0].romanized+='!';const r=spotifyHashes(f.recording,read,f.selectionRevision);
  assert.notEqual(r.readingRevision,h.readingRevision);assert.equal(r.timingRevision,h.timingRevision);
});

test('incidental album words are not version labels but explicit album versions still reject',()=>{
  for(const album of [undefined,null,'']) {
    assert.ok(recordingScore(candidate({album}),request(['A & B'],{album}))>=0);
  }
  for(const album of ['Live Through Tomorrow','Cover Me','Clean Slate','Reprise of Summer']) {
    assert.ok(recordingScore(candidate({album:'Studio Album',isrc:'USABC2600001'}),request(['A & B'],{album,isrc:'USABC2600001'}))>=0,album);
  }
  for(const album of ['Live at the Hall','Album (Live)','Album [Remastered 2024]','Album - Acoustic Version','Album (Radio Edit)','現場演唱會']) {
    assert.equal(recordingScore(candidate({album}),request(['A & B'],{album:'Studio Album'})),-1,album);
  }
  assert.equal(recordingScore(candidate({title:'Song (Live)',isrc:'USABC2600001'}),request(['A & B'],{isrc:'USABC2600001'})),-1);
});
