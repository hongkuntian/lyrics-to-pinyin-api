import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createSongLibraryService,lyricLoader} from '../../api/song-library.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {lyricResponseLifetimeMs} from '../../api/utils/lyric-selection.js';
import {validVocalTiming} from '../../api/utils/vocal-timing.js';
import {libraryDB} from '../helpers/library-db.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const raw=JSON.parse(readFileSync(new URL('../fixtures/shaonian-performer-timing.json',import.meta.url)));
const recording={catalog_id:'615959497',storefront:'us',title:'少年',artist:'Michael Wong & Gary Chaw',album:'1996-2006 the Greatest Hits',duration:253.24};
function service() {
 const api={name:'QQMusicAPI',supportsVocalTiming:true,
  searchSong:async()=>({id:4932646,title:'少年',artist:'光良/曹格',creditedArtistNames:['光良','曹格'],album:'童话',duration:253,source:'qq'}),
  getLyrics:async()=>structuredClone(raw)};
 return createMusicRomanizeService({redis:null,speculativeDiscovery:false,getAvailableAPIsFn:()=>[api],
  lookupListeningReviewedRecordingFn:async()=>null,lookupReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:async()=>[{...recording,artist:'光良/曹格'}],logger:{info(){},error(){}}});
}

test('Shaonian measured words survive acquisition, pinyin, durable save and public reload',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());let loads=0;
 const load=lyricLoader(service()),handler=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,
  loadLyrics:async(...args)=>{loads++;return load(...args);},logger:{info(){},error(){}}});
 const call=async()=>{const req=createMockReq({body:{action:'lyrics',recording}}),res=createMockRes();
  req.lyricaUser=await store.authenticate('token-a');await handler(req,res);assert.equal(res.statusCode,200,JSON.stringify(res.body));return res.body.document;};
 const fresh=await call();
 assert.deepEqual(fresh.response.lines.map(l=>l.original),raw.lines.map(l=>l.text.slice(2)));
 fresh.response.lines.forEach((line,i)=>{
  assert.ok(validVocalTiming(line,{duration:253}));assert.ok(line.romanized);
  assert.deepEqual(line.vocalTiming,{...raw.lines[i].vocalTiming,
   segments:raw.lines[i].vocalTiming.segments.filter(s=>s.utf16Start>=2).map(s=>({...s,utf16Start:s.utf16Start-2}))});
 });
 assert.equal(fresh.response.metadata.lyric_timing.revision,raw.timingSource.revision);
 assert.ok(fresh.structure.occurrences.every(o=>o.sourcePrefix===''&&!o.startsTurn));
 assert.equal((await call()).id,fresh.id);assert.equal(loads,1);

 // Recreate the previously delivered damage in a distinct immutable document.
 // The normal stale lookup must recover it without a manual refresh or rewrite.
 const damaged=structuredClone(fresh.response);
 delete damaged.lines[0].vocalTiming;
 damaged.metadata.word_timing_upgrade_supported=true;
 const old=makeDocument(recording,damaged,SELECTION_REVISION);
 assert.notEqual(old.id,fresh.id);
 await store.saveDocument(old,{replaceID:fresh.id});
 assert.equal(lyricResponseLifetimeMs(damaged),300000);
 await db.query("UPDATE lyric_requests SET checked_at=NOW()-INTERVAL '6 minutes' WHERE request_key=$1",[requestKey(recording)]);
 const recovered=await call();
 assert.equal(loads,2);
 assert.equal(recovered.id,fresh.id);
 assert.deepEqual(recovered.response.lines,fresh.response.lines);
 assert.deepEqual((await store.document(old.id)).response.lines,old.response.lines);
 assert.equal((await store.documentForRequest(requestKey(recording),SELECTION_REVISION)).id,fresh.id);
});
