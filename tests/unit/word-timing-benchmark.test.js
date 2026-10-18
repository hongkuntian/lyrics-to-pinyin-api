import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {runBenchmark,summarizeCandidate,validateCorpus} from '../../scripts/benchmark-word-timing.mjs';

const recording={caseID:'invented',artist:'Invented Artist',title:'Invented Song',album:'Invented Album',duration:10,expectedLanguage:'en'};
const words='Private invented lyric sentinel';
const raw={lines:[{text:words,timestamp:1,vocalTiming:{end:2,segments:[{utf16Start:0,utf16Length:words.length,text:words,start:1,end:2}]}},
 {text:'Another invented row',timestamp:3,vocalTiming:{end:4,segments:[{utf16Start:0,utf16Length:20,text:'Another invented row',start:3,end:4}]}}],
 source:'kugou',songId:'42',timingSource:{source:'kugou:42:krc',revision:'a'.repeat(64)}};
const candidate=(lyrics=raw,overrides={})=>({song:{id:'42',source:'kugou',title:recording.title,artist:recording.artist,album:recording.album,duration:10,...overrides},lyrics});
const response=value=>({ok:true,status:200,url:'https://lyrics.kugou.com/download',headers:new Headers(),json:async()=>value});
const hedge=async(apis,lookup,{signal})=>{for(const api of apis){const value=await lookup(api,signal);if(value)return value;}return null;};
function set(id,{measured=true,wrong=false,transport=true}={}) {
 return {id,hedge,makeAPIs:()=>[{name:'KugouAPI',supportsVocalTiming:measured,
  searchSong:async(_artist,_title,context)=>{if(transport)await context.fetchFn('https://lyrics.kugou.com/download?accesskey=CAPABILITY_SENTINEL',{signal:context.signal});return candidate(raw,wrong?{title:'Invented Song (Live)'}:{}).song;},
  getLyrics:async()=>measured?raw:{...raw,timingSource:undefined,lines:raw.lines.map(({vocalTiming,...line})=>line)}}]};
}

test('corpus freezes separate Viva album/single durations and version controls',async()=>{
 const corpus=JSON.parse(await readFile(new URL('../../docs/research/word-timing-corpus.json',import.meta.url)));
 const rows=validateCorpus(corpus),album=rows.find(r=>r.caseID==='en-viva-album'),single=rows.find(r=>r.caseID==='control-viva-single');
 assert.equal(album.duration,241.445);assert.equal(single.duration,242.373);assert.notEqual(album.catalog_id,single.catalog_id);
 assert.equal(rows.find(r=>r.caseID==='ja-idol').title,'アイドル');assert.equal(rows.find(r=>r.caseID==='control-idol-english').title,'Idol');
 assert.ok(rows.some(r=>r.expectedLanguage==='zh'));assert.ok(rows.some(r=>r.expectedLanguage==='ko'));
 assert.throws(()=>validateCorpus({recordings:[recording,recording]}),/invalid_corpus/);
});

test('closed summary reports Unicode measured coverage without lyric/capability retention',()=>{
 const text='!你 😀e\u0301',lyrics={...raw,lines:[{text,timestamp:1,vocalTiming:{end:2,segments:[{utf16Start:0,utf16Length:text.length,text,start:1,end:2}]}}]};
 const summary=summarizeCandidate(candidate(lyrics),recording);
 assert.deepEqual(summary.coverage,{covered:2,total:2,complete:true,ratio:1});
 assert.equal(summary.identity.admitted,true);assert.equal(summary.identity.acousticVerified,false);
 assert.equal(JSON.stringify(summary).includes(text),false);assert.match(summary.contentSHA256,/^[a-f0-9]{64}$/);
});
test('summary honors only source-bound QQ interval precision and retains no lyric body',()=>{
 const text='Invented precision sentinel',lyrics={...raw,source:'qq',durationResolution:1,timingSource:{source:'qq:42:qrc',revision:'b'.repeat(64)},
  lines:[{text,timestamp:9.5,vocalTiming:{end:10.134,segments:[{utf16Start:0,utf16Length:text.length,text,start:9.5,end:10.134}]}}]};
 const summary=summarizeCandidate(candidate(lyrics),recording);
 assert.equal(summary.coverage.complete,true);assert.equal(summary.measuredRows,1);assert.equal(summary.segments,1);
 for(const unbound of [{...lyrics,songId:'43'},{...lyrics,durationResolution:undefined},{...lyrics,source:'kugou'}]){
  const rejected=summarizeCandidate(candidate(unbound),recording);
  assert.equal(rejected.coverage.covered,0);assert.equal(rejected.measuredRows,0);assert.equal(rejected.segments,0);
 }
 assert.equal(JSON.stringify(summary).includes(text),false);
});

test('injected network replay separates original LRC/new measured paths and redacts payload/error details',async()=>{
 const report=await runBenchmark({corpus:{recordings:[recording]},runs:1},{adapterSets:[set('original-lyrica',{measured:false}),set('updated-lyrica')],fetchFn:async()=>response({content:words,accesskey:'CAPABILITY_SENTINEL',arbitrary:'DO_NOT_STORE'})});
 assert.equal(report.aggregate['original-lyrica'].measured,0);assert.equal(report.aggregate['updated-lyrica'].completeMeasured,1);
 assert.equal(report.aggregate['updated-lyrica'].wrongIdentityReturned,0);
 const json=JSON.stringify(report);for(const secret of [words,'CAPABILITY_SENTINEL','DO_NOT_STORE','accesskey='])assert.equal(json.includes(secret),false,secret);
 assert.ok(report.results.every(r=>r.requests[0].responseSHA256&&r.requests[0].upstreamCache==='unknown'));
 const failed=await runBenchmark({corpus:[recording]},{adapterSets:[set('original-lyrica')],fetchFn:async()=>{throw new Error('CAPABILITY_SENTINEL '+words);}});
 assert.equal(JSON.stringify(failed).includes(words),false);assert.equal(JSON.stringify(failed).includes('CAPABILITY_SENTINEL'),false);
});

test('wrong-version adapter return is rejected and remains visible in identity-failure counts',async()=>{
 const report=await runBenchmark({corpus:[recording]},{adapterSets:[set('updated-lyrica',{wrong:true,transport:false})]});
 assert.equal(report.results[0].status,'recording_mismatch');assert.equal(report.aggregate['updated-lyrica'].returned,0);
 assert.equal(report.aggregate['updated-lyrica'].wrongIdentityReturned,1);
 assert.equal(report.results[0].providerAttempts[0].failure,'recording_mismatch');
});

test('per-case total deadline aborts pending transport and does not label a timeout as fast measured success',async()=>{
 let aborted=false;
 const report=await runBenchmark({corpus:[recording],maxTimeMS:25,providerTimeoutMS:200},{adapterSets:[set('updated-lyrica')],fetchFn:(_url,init)=>new Promise((_,reject)=>{
  init.signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(new Error('sentinel'),{name:'AbortError'}));},{once:true});
 })});
 assert.equal(aborted,true);assert.equal(report.results[0].status,'timeout');
 assert.equal(report.aggregate['updated-lyrica'].measured,0);assert.equal(report.aggregate['updated-lyrica'].successfulLatencyMS.samples,0);
});

test('case concurrency is bounded with fresh adapter instances per run',async()=>{
 let active=0,peak=0,instances=0;const fixture=set('updated-lyrica'),make=fixture.makeAPIs;
 fixture.makeAPIs=(...args)=>{instances++;return make(...args);};
 const corpus=[recording,{...recording,caseID:'second'},{...recording,caseID:'third'}];
 const report=await runBenchmark({corpus,runs:2,concurrency:2},{adapterSets:[fixture],fetchFn:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return response({safe:true});}});
 assert.equal(instances,6);assert.equal(peak,2);assert.equal(report.results.length,6);
 assert.ok(report.results.every(r=>r.cache.includes('upstream_OS_DNS_TLS_caches_uncontrolled')));
});

test('fixed-ID KRC envelope replay is separately classified and never replaces an adapter mismatch',async()=>{
 const krc='[ar:Invented Artist]\n[ti:Invented Song]\n[1000,1000]<0,1000,0>'+words+'\n[3000,1000]<0,1000,0>Another invented row';
 const key=Buffer.from([64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105]);
 const packed=Buffer.concat([Buffer.from('krc1'),Buffer.from(deflateSync(Buffer.from(krc)).map((b,i)=>b^key[i%16]))]).toString('base64');
 const report=await runBenchmark({corpus:[{...recording,directSources:[{provider:'kugou',id:'42'}]}]},{adapterSets:[set('updated-lyrica',{wrong:true,transport:false})],fetchFn:async address=>{
  const url=new URL(address);return {...response(url.pathname==='/search'?{status:200,candidates:[{id:'42',song:recording.title,singer:recording.artist,duration:10000,product_from:'官方推荐歌词',accesskey:'CAPABILITY_SENTINEL'}]}:{status:200,fmt:'krc',content:packed}),url:String(url)};
 }});
 const direct=report.results.find(r=>r.mode==='dynamic-style-kugou-krc');
 assert.equal(direct.kind,'fixed_source_request_envelope');assert.equal(direct.status,'returned');assert.equal(direct.summary.coverage.complete,true);
 assert.equal(report.aggregate['updated-lyrica'].returned,0);assert.equal(report.aggregate['dynamic-style-kugou-krc'].returned,1);
 const json=JSON.stringify(report);assert.equal(json.includes(words),false);assert.equal(json.includes(packed),false);assert.equal(json.includes('CAPABILITY_SENTINEL'),false);
 assert.ok(report.limitations.some(s=>s.includes('bypass production discovery/tie consensus')));
});

test('transport rejects authenticated requests before invoking the injected network',async()=>{
 let called=false;const fixture=set('updated-lyrica');fixture.makeAPIs=()=>[{name:'KugouAPI',searchSong:async(_a,_t,ctx)=>ctx.fetchFn('https://lyrics.kugou.com/download',{headers:{Cookie:'CREDENTIAL_SENTINEL'}})}];
 const report=await runBenchmark({corpus:[recording]},{adapterSets:[fixture],fetchFn:async()=>{called=true;return response({});}});
 assert.equal(called,false);assert.equal(JSON.stringify(report).includes('CREDENTIAL_SENTINEL'),false);assert.equal(report.aggregate['updated-lyrica'].returned,0);
});


test('known-ID fresh revalidation is measured separately from source envelope and discovery',async()=>{
 const report=await runBenchmark({corpus:[{...recording,directSources:[{provider:'qq',id:'42'}],caseRole:'version_or_language_control'}]},{adapterSets:[],directReplay:async()=>({candidate:candidate()}),freshIDReplay:async()=>({candidate:candidate()})});
 assert.equal(report.results.length,2);assert.equal(report.aggregate['updated-qq-fresh-id'].returned,1);
 assert.equal(report.results.find(r=>r.mode==='updated-qq-fresh-id').kind,'fresh_source_id_revalidation');
 assert.equal(Object.keys(report.coverageCasesAggregate).length,0);assert.equal(report.versionControlsAggregate['dynamic-style-qq-qrc'].returned,1);
});
