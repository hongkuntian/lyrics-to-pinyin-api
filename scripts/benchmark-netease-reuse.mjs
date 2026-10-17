// Explicit public-provider experiment; never part of the hermetic test suite.
// No real Redis/database, app credentials, AI generation or lyric bodies saved.
import {performance} from 'node:perf_hooks';
import {createMusicRomanizeService} from '../api/music-romanize.js';
import {NeteaseAPI} from '../api/music-apis/netease.js';
import {createMockRes} from '../tests/helpers/mock-http.js';

if(!process.argv.includes('--live')){
 console.log('Run with --live for three bounded, sequential NetEase-only public-provider acquisitions. JSON contains timings/counts only.');
 process.exit(0);
}
const request={artist:'Eason Chan',title:'孤勇者 (《英雄聯盟:雙城之戰》動畫劇集中文主題曲)',
 album:'孤勇者 (《英雄聯盟:雙城之戰》動畫劇集中文主題曲) - Single',duration:256,catalog_id:'1596938779',storefront:'ca',romanization_system:'none'};
const values=new Map(),pending=[],results=[];
for(const mode of ['initial-discovery','new-instance-id-revalidation','explicit-refresh-id-revalidation']){
 for(const key of values.keys())if(!key.startsWith('lyrics:verified-context:'))values.delete(key);
 const calls=[],api=new NeteaseAPI();
 for(const method of ['searchSong','getRecording','getLyrics','namesForArtist']){
  const original=api[method].bind(api);
  api[method]=async(...args)=>{const start=performance.now();try{return await original(...args);}finally{calls.push({method,elapsedMS:Math.round(performance.now()-start)});}};
 }
 const service=createMusicRomanizeService({redis:{},getCachedFn:async(_,k)=>values.get(k),setCachedFn:async(_,k,v)=>values.set(k,structuredClone(v)),
  waitUntilFn:p=>pending.push(p),getAvailableAPIsFn:()=>[api],getMusicAPIFn:()=>api,logger:{info(){},error(){}}});
 const start=performance.now(),res=createMockRes();
 await service({method:'POST',body:{...request,music_platform:'netease',...(mode.startsWith('explicit')?{options:{refresh:true}}:{})}},res);
 for(let n=0;n<pending.length;n++)await pending[n];
 results.push({mode,status:res.statusCode,totalMS:Math.round(performance.now()-start),source:res.body?.metadata?.source??null,
  lineCount:res.body?.lines?.length??0,measuredCueCount:res.body?.lines?.reduce((n,l)=>n+(l.vocalTiming?.segments?.length??0),0)??0,
  timingRevision:res.body?.metadata?.lyric_timing?.revision??null,serverTiming:res.headers['server-timing']??res.headers['Server-Timing']??null,calls});
}
console.log(JSON.stringify({experiment:'NetEase-only server-host acquisition; fresh service instances, in-memory shared context store, content cache cleared; not phone/end-to-end production latency',noLyricBodiesRetained:true,results},null,2));
