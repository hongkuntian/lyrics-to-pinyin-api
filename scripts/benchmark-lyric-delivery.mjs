// Deterministic injected provider delays; no network, playback or paid work.
import {performance} from 'node:perf_hooks';
import {EventEmitter} from 'node:events';
import {createMusicRomanizeService} from '../api/music-romanize.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function sample(progressive){
 const started=performance.now(),events=[];const event=name=>events.push({name,ms:Math.round(performance.now()-started)});
 const song={id:'source',title:'測試',artist:'歌手',duration:240};
 const api=(name,delay,timestamp)=>({name,searchSong:async()=>{event(name+'_start');await sleep(delay);event(name+'_available');return song;},getLyrics:async()=>({lines:[{text:'一起唱',timestamp},{text:'向前走',timestamp:timestamp===null?null:30}]})});
 const handler=createMusicRomanizeService({redis:null,logger:{info(){},error(){}},getAvailableAPIsFn:()=>[api('Plain',40,null),api('Timed',1000,12)],detectLanguageFn:async()=> 'zh',getProcessorFn:()=>({romanize:async text=>({romanized:text})}),resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null});
 const res=new EventEmitter();Object.assign(res,{statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(body){this.body=body;event('response_complete');return this;},write(line){const frame=JSON.parse(line);if(frame.event==='readable'&&!events.some(e=>e.name==='first_readable'))event('first_readable');if(frame.event==='complete')event('response_complete');return true;},end(){}});
 await handler({method:'POST',body:{artist:song.artist,title:song.title,duration:song.duration,language:'zh',options:progressive?{delivery:'progressive-v1'}:{}}},res);
 return {mode:progressive?'progressive-v1':'legacy-json',events,status:res.statusCode};
}
const results=[];for(let i=0;i<3;i++){results.push(await sample(false));results.push(await sample(true));}
console.log(JSON.stringify({kind:'controlled_backend_delivery_replay',node:process.version,sourceDelaysMs:{plain:40,timed:1000},notes:'Source provider order, hedge and final timing preference are unchanged; these are injected delays, not production or phone benchmarks.',results},null,2));
