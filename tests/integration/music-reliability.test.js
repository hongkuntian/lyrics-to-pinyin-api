import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
const song={id:1,title:'晴天',artist:'周杰伦',duration:269};
const processor={name:'Fixture',romanize:async(text)=>({romanized:text})};
const api=(overrides={})=>({name:'Fixture',searchSong:async()=>song,getLyrics:async()=>({lines:[{text:'你好',timestamp:0}]}),...overrides});
async function run(apis,body={},deps={}) {
  const res=createMockRes();
  await createMusicRomanizeHandler({lookupOfficialTranscriptionFn:async()=>null,lookupReviewedRecordingFn:async()=>null,resolveCatalogAliasesFn:async()=>[],redis:null,getAvailableAPIsFn:()=>apis,getProcessorFn:()=>processor,providerTimeoutMs:20,logger:{error(){},log(){}},...deps})(createMockReq({body:{artist:'周杰伦',title:'晴天',duration:269,language:'zh',...body}}),res);
  return res;
}
test('zero timestamps survive the handler',async()=>assert.equal((await run([api()])).body.lines[0].timestamp,0));
test('fallback continues after missing lyrics, outages, mismatches and deadlines',async()=> {
  for(const bad of [api({getLyrics:async()=>null}),api({searchSong:async()=>{throw new Error('offline');}}),api({searchSong:async()=>({...song,artist:'Cover'})}),api({searchSong:()=>new Promise(()=>{})})]) {
    assert.equal((await run([bad,api({name:'Backup'})])).statusCode,200);
  }
});
test('only mismatched recordings return actionable 409',async()=>assert.equal((await run([api({searchSong:async()=>({...song,duration:300})})])).statusCode,409));
test('deadlines return 504; outages return 502',async()=> {
  assert.equal((await run([api({searchSong:()=>new Promise(()=>{})})])).statusCode,504);
  assert.equal((await run([api({searchSong:async()=>{throw new Error('offline');}})])).statusCode,502);
});
test('cache keys separate source, version, album, duration and title/artist boundaries',async()=> {
  const keys=[];
  const deps={redis:{},getCachedFn:async(_,key)=>{keys.push(key);return null;},setCachedFn:async()=>{}};
  await run([api()],{},deps);
  await run([api({name:'Backup'})],{},deps);
  await run([api()],{album:'Album'},deps);
  await run([api()],{duration:270},deps);
  assert.equal(new Set(keys).size,4);
});
test('request validation rejects invalid fields without invoking providers',async()=> {
  for(const body of [{artist:{}},{title:[]},{duration:-1},{duration:'269'},{album:8}]) assert.equal((await run([api()],body)).statusCode,400);
});
