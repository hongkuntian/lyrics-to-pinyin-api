import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {validVocalTiming,vocalCoverage} from '../../api/utils/vocal-timing.js';
import {createSongLibraryService,lyricLoader} from '../../api/song-library.js';
import {yrcService,appleRequest,spotifyRequest} from '../helpers/netease-yrc.js';
import {libraryDB} from '../helpers/library-db.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {validateSchema} from '../contracts/schema-validator.js';

const fixture=JSON.parse(readFileSync(new URL('../fixtures/qrc-millisecond-boundaries.json',import.meta.url)));
const schema=JSON.parse(readFileSync(new URL('../../contracts/song-library.schema.json',import.meta.url)));
const cues=response=>response.lines.reduce((n,l)=>n+(l.vocalTiming?.segments.length??0),0);
for(const [platform,recording] of [
 ['apple',{...appleRequest,duration:185.008}],
 ['spotify',{...spotifyRequest,metadata:{...spotifyRequest.metadata,duration_ms:185008}}],
])test(`${platform}: QQ boundary cues survive acquisition, explicit refresh and durable reopen`,async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());
 let sparse=true,loads=0;
 const all=parseQRC(fixture.qrc,{songId:'42',duration:fixture.duration,durationResolution:1});
 const api={name:'QQMusicAPI',supportsVocalTiming:true,
  searchSong:async()=>({id:'42',source:'qq',title:appleRequest.title,artist:appleRequest.artist,creditedArtistNames:[appleRequest.artist],album:appleRequest.album,duration:fixture.duration}),
  getLyrics:async()=>{
   const value=structuredClone(all);
   // Simulate the previously saved sparse document, then exercise a fresh full acquisition.
   if(sparse)for(const line of value.lines)delete line.vocalTiming;
   return value;
  }};
 const source=yrcService({getAvailableAPIsFn:()=>[api],getMusicAPIFn:()=>api});
 const loader=lyricLoader(source.service),service=createSongLibraryService({store,loadLyrics:async(...args)=>{loads++;return loader(...args);},logger:{info(){},error(){}}});
 const call=async refresh=>{const req=createMockReq({body:{action:'lyrics',recording,...(refresh?{refresh:true}:{})}});req.lyricaUser={id:'reader-a'};
  const res=createMockRes();await service(req,res);assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.deepEqual(validateSchema(schema,res.body),[]);return res.body.document;};
 const old=await call(false),saved=await store.document(old.id);assert.equal(cues(old.response),0);
 sparse=false;const next=await call(true);assert.notEqual(next.id,old.id);
 assert.equal(next.response.metadata.lyric_timing.source,'qq:42:qrc');
 assert.equal(cues(next.response),fixture.expected.cues);assert.equal(next.response.lines.length,fixture.expected.rows);
 assert.deepEqual(vocalCoverage(next.response.lines,{duration:fixture.duration,durationResolution:1}),{covered:fixture.expected.meaningfulGraphemes,total:fixture.expected.meaningfulGraphemes,complete:true});
 for(const line of next.response.lines)assert.equal(validVocalTiming(line,{duration:fixture.duration,durationResolution:1}),true);
 const reopened=await call(false);assert.equal(reopened.id,next.id);assert.deepEqual(reopened.response.lines,next.response.lines);assert.equal(loads,2);
 assert.deepEqual((await store.document(old.id)).response,saved.response);
});
