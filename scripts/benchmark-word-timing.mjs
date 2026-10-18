// Opt-in anonymous source-path benchmark. Never executes the competitor app or
// stores lyric bodies, request URLs/query strings, headers, or download keys.
import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import fetch from 'node-fetch';
import {cleanLyrics,hasUsableLyrics} from '../api/utils/lyric-quality.js';
import {recordingScore,sameRecordingNames,normalizedAlbum} from '../api/utils/recording-match.js';
import {isRejectedRecordingLyrics} from '../api/utils/rejected-lyrics.js';
import {validSourceTiming,validVocalTiming,vocalCoverage,sourceDurationResolution} from '../api/utils/vocal-timing.js';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MAX_BYTES=524288;
const ALLOWED=new Set(['lyrics.kugou.com','lrclib.net','netease-cloud-music-api-gules-mu.vercel.app','u.y.qq.com','c.y.qq.com']);
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const failure=error=>error?.code==='benchmark_timeout'||error?.code==='provider_timeout'?'timeout':error?.name==='AbortError'?'cancelled':error?.code==='recording_mismatch'?'recording_mismatch':error?.code==='module_unavailable'?'module_unavailable':'provider_unavailable';
const fail=code=>Object.assign(new Error(code),{code});
const safePath=value=>/^\/(?:search|download|cloudsearch|song\/detail|artist\/detail|lyric(?:\/new)?|api\/(?:search|get(?:\/\d{1,20})?)|cgi-bin\/musicu\.fcg|qqmusic\/fcgi-bin\/lyric_download\.fcg)$/.test(value)?value:'other';
const safeID=value=>/^\d{1,20}$/.test(String(value??''))?String(value):null;

export function validateCorpus(corpus) {
 const rows=Array.isArray(corpus)?corpus:corpus?.recordings;
 if(!Array.isArray(rows)||!rows.length||rows.length>50)throw fail('invalid_corpus');
 const ids=new Set();
 return rows.map(row=>{
  if(!row||typeof row.caseID!=='string'||!/^[a-z0-9-]{1,80}$/.test(row.caseID)||ids.has(row.caseID))throw fail('invalid_corpus');
  ids.add(row.caseID);
  for(const key of ['artist','title','album'])if(typeof row[key]!=='string'||!row[key].trim()||row[key].length>1024)throw fail('invalid_corpus');
  if(!Number.isFinite(row.duration)||row.duration<=0||row.duration>7200||!/^[a-z]{2,3}$/.test(row.expectedLanguage??''))throw fail('invalid_corpus');
  if(row.catalog_id!=null&&!safeID(row.catalog_id))throw fail('invalid_corpus');
  if(row.directSources!=null&&(!Array.isArray(row.directSources)||row.directSources.length>4||row.directSources.some(s=>!['kugou','qq'].includes(s.provider)||!safeID(s.id))))throw fail('invalid_corpus');
  return structuredClone(row);
 });
}

// The summary is a closed allowlist: even an injected provider error or payload
// containing lyrics/secrets cannot add arbitrary fields to the artifact.
export function summarizeCandidate(candidate,request) {
 const {song,lyrics}=candidate;
 const admitted=recordingScore(song,request)>=0;
 const bounds={duration:song.duration,durationResolution:sourceDurationResolution(lyrics,song.id)};
 const coverage=vocalCoverage(lyrics.lines,{...bounds,provenance:validSourceTiming(lyrics,song.id)});
 return {identity:{admitted,method:'source_metadata_only',namesMatch:sameRecordingNames(song,request),
   durationDeltaMS:Math.round((song.duration-request.duration)*1000),album:song.album?(normalizedAlbum(song.album)===normalizedAlbum(request.album)?'equal':'different'):'absent',
   acousticVerified:false,catalogEquivalenceVerified:false,sourceMetadataSHA256:sha([song.id,song.title,song.artist,song.album??null,song.duration])},
  source:{provider:['kugou','qq','netease','lrclib'].includes(lyrics.source)?lyrics.source:'other',itemID:safeID(song.id),
   revision:/^[a-f0-9]{64}$/.test(lyrics.timingSource?.revision??'')?lyrics.timingSource.revision:null},
  rows:lyrics.lines.length,lineTimedRows:lyrics.lines.filter(l=>Number.isFinite(l.timestamp)).length,
  measuredRows:lyrics.lines.filter(l=>validSourceTiming(lyrics,song.id)&&validVocalTiming(l,bounds)).length,
  segments:lyrics.lines.reduce((n,l)=>n+(validSourceTiming(lyrics,song.id)&&validVocalTiming(l,bounds)?l.vocalTiming.segments.length:0),0),
  coverage:{...coverage,ratio:coverage.total?coverage.covered/coverage.total:0},partial:lyrics.partial===true,instrumental:lyrics.instrumental===true,
  contentSHA256:sha(lyrics.lines.map(l=>[l.text,l.timestamp??null])),timingSHA256:sha(lyrics.lines.map(l=>[l.timestamp??null,l.vocalTiming??null]))};
}

async function bounded(work,ms,parentSignal) {
 const controller=new AbortController();let timer,onAbort;
 try {
  const interrupted=new Promise((_,reject)=>{
   onAbort=()=>{controller.abort();reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));};
   parentSignal?.addEventListener('abort',onAbort,{once:true});
   timer=setTimeout(()=>{controller.abort();reject(fail('benchmark_timeout'));},Math.max(1,ms));
   if(parentSignal?.aborted)onAbort();
  });
  return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}),interrupted]);
 }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',onAbort);controller.abort();}
}

function observedFetch(fetchFn,requests,now) {
 return async(address,init={})=>{
  const url=new URL(address);
  if(!ALLOWED.has(url.hostname)||url.protocol!=='https:'||url.username||url.password)throw fail('unsafe_transport');
  const headers=new Headers(init.headers??{});
  if(headers.has('authorization')||headers.has('cookie')||headers.has('proxy-authorization'))throw fail('credential_forbidden');
  const started=now(),row={host:url.hostname,path:safePath(url.pathname),method:['GET','POST'].includes((init.method??'GET').toUpperCase())?(init.method??'GET').toUpperCase():'OTHER',
   format:['krc','lrc'].includes(url.searchParams.get('fmt'))?url.searchParams.get('fmt'):null};
  requests.push(row);
  try {
   const response=await fetchFn(String(url),{...init,redirect:'error',size:MAX_BYTES});
   if(response.url&&new URL(response.url).origin!==url.origin)throw fail('unsafe_transport');
   let bytes;
   if(response.body?.[Symbol.asyncIterator]) {
    const chunks=[];let size=0;
    for await(const chunk of response.body){const part=Buffer.from(chunk);size+=part.length;if(size>MAX_BYTES)throw fail('body_too_large');chunks.push(part);}
    bytes=Buffer.concat(chunks);
   } else if(response.text)bytes=Buffer.from(await response.text());
   else bytes=Buffer.from(JSON.stringify(await response.json()));
   if(bytes.length>MAX_BYTES)throw fail('body_too_large');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   const cache=String(response.headers?.get?.('x-cache')??'');
   Object.assign(row,{status:response.status,bytes:bytes.length,responseSHA256:sha(bytes),upstreamCache:/\bhit\b/i.test(cache)?'reported_hit':/\bmiss\b/i.test(cache)?'reported_miss':'unknown'});
   return {ok:response.ok,status:response.status,url:response.url??String(url),headers:response.headers??new Headers(),
    json:async()=>JSON.parse(text),text:async()=>text};
  }catch(error){row.failure=failure(error);throw error;}
  finally{row.elapsedMS=Math.max(0,now()-started);}
 };
}

async function loadSet(root,id) {
 const url=relative=>pathToFileURL(join(root,relative)).href;
 try {
  const [registry,selection,hedge,rejections]=await Promise.all([import(url('api/music-apis/index.js')),import(url('api/utils/lyric-selection.js')),import(url('api/utils/hedged-lookup.js')),import(url('api/utils/rejected-lyrics.js'))]);
  return {id,makeAPIs:language=>registry.getAvailableAPIs(language).map(api=>new api.constructor()),
   choose:selection.chooseMeasuredLyricCandidate??selection.chooseLyricCandidate,hedge:hedge.hedgedLookup,reject:rejections.isRejectedRecordingLyrics};
 }catch{return {id,unavailable:true};}
}

async function adapterReplay(set,request,{signal,fetchFn,providerTimeoutMS,now}) {
 if(set.unavailable)throw fail('module_unavailable');
 const apis=set.makeAPIs(request.expectedLanguage),attempts=[],pending=[];
 const selected=await set.hedge(apis,(api,parentSignal)=>{const operation=(async()=>{
  const start=now();let summary;
  try{return await bounded(async ownSignal=>{
   const context={...request,signal:ownSignal,fetchFn};
   const song=await api.searchSong(request.artist,request.title,context);
   if(!song)return null;
   const raw=await api.getLyrics(song.id,{...context,song});
   const lyrics=cleanLyrics(raw,{duration:song.duration,title:song.title,artist:song.artist});
   if(!hasUsableLyrics(lyrics,{duration:song.duration}))return null;
   if((set.reject??isRejectedRecordingLyrics)(lyrics.lines,request))throw fail('recording_mismatch');
   const candidate={song,lyrics,api};summary=summarizeCandidate(candidate,request);
   if(!summary.identity.admitted)throw fail('recording_mismatch');
   return candidate;
  },providerTimeoutMS,parentSignal);}catch(error){summary={...(summary??{}),failure:failure(error)};return null;}
  finally{attempts.push({provider:['KugouAPI','NeteaseAPI','LRCAPI','QQMusicAPI'].includes(api.name)?api.name:'other',elapsedMS:now()-start,...(summary??{failure:'absent'})});}
 })();pending.push(operation);return operation;},{delayMs:350,untimedGraceMs:2500,wordTimingGraceMs:providerTimeoutMS,chooseCandidate:set.choose,signal});
 await Promise.allSettled(pending);
 return {candidate:selected,providerAttempts:attempts};
}

const COMM={ct:24,cv:4747474,format:'json',inCharset:'utf-8',outCharset:'utf-8',notice:0,platform:'yqq.json',needNewCode:1};
async function directReplay(source,request,{signal,fetchFn}) {
 if(source.provider==='kugou') {
  const {decodeKRC,parseKRC}=await import('../api/utils/kugou-krc.js');
  const search=new URL('https://lyrics.kugou.com/search');
  search.search=new URLSearchParams({ver:1,man:'yes',client:'pc',keyword:`${request.artist} - ${request.title}`,duration:Math.round(request.duration*1000)}).toString();
  const data=await(await fetchFn(search,{signal})).json();
  const rows=data?.candidates?.filter(x=>String(x.id)===String(source.id))??[];
  if(data.status!==200||rows.length!==1)throw fail('recording_mismatch');
  const raw=rows[0],song={id:String(raw.id),source:'kugou',title:raw.song,artist:raw.singer,duration:raw.duration/1000};
  if(!sameRecordingNames(song,request)||Math.abs(song.duration-request.duration)>1||raw.product_from!=='官方推荐歌词'
   ||typeof raw.accesskey!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(raw.accesskey))throw fail('recording_mismatch');
  const download=new URL('https://lyrics.kugou.com/download');
  download.search=new URLSearchParams({ver:1,client:'pc',id:source.id,accesskey:raw.accesskey,fmt:'krc',charset:'utf8'}).toString();
  const body=await(await fetchFn(download,{signal})).json();
  const decoded=decodeKRC(body.content);
  if(decoded)for(const match of decoded.matchAll(/^\s*\[(ar|ti):([^\]\r\n]*)\]\s*$/gim)){const value=match[2].trim();if(value&&!sameRecordingNames({...song,[match[1].toLowerCase()==='ar'?'artist':'title']:value},song))throw fail('recording_mismatch');}
  const lyrics=body.status===200?parseKRC(decoded,{songId:source.id,duration:song.duration}):null;
  if(!lyrics)throw fail('invalid_payload');
  return {candidate:{song,lyrics:cleanLyrics(lyrics,{duration:song.duration,title:song.title,artist:song.artist})}};
 }
 let parser;
 try{parser=await import('../api/utils/qq-qrc.js');}catch{throw fail('module_unavailable');}
 const metadata=new URL('https://u.y.qq.com/cgi-bin/musicu.fcg');
 metadata.searchParams.set('data',JSON.stringify({comm:COMM,req:{module:'music.pf_song_detail_svr',method:'get_song_detail_yqq',param:{song_id:Number(source.id)}}}));
 const detail=await(await fetchFn(metadata,{signal,headers:{Referer:'https://y.qq.com/'}})).json();
 const info=detail.req?.data?.track_info;
 if(detail.code!==0||detail.req?.code!==0||String(info?.id)!==String(source.id)||!Array.isArray(info.singer))throw fail('recording_mismatch');
 const song={id:String(info.id),source:'qq',title:info.title??info.name,artist:info.singer.map(s=>s.name).join(' & '),album:info.album?.name,duration:info.interval};
 if(!sameRecordingNames(song,request)||recordingScore(song,request)<0)throw fail('recording_mismatch');
 const url=new URL('https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg');
 url.search=new URLSearchParams({musicid:source.id,version:15,miniversion:82,lrctype:4}).toString();
 const response=await fetchFn(url,{signal,headers:{Referer:'https://y.qq.com/portal/player.html'}});
 if(!response.ok)throw fail('provider_unavailable');
 const body=await response.text();
 // Only the established download envelope's one content element is consumed;
 // no XML DTD or other element is interpreted, and no raw body is retained.
 const values=[...body.matchAll(/<content(?:\s+[^>]*)?>(?:<!\[CDATA\[)?\s*([a-fA-F0-9]+)\s*(?:\]\]>)?<\/content>/g)];
 if(values.length!==1)throw fail('invalid_payload');
 const lyrics=parser.parseEncryptedQRC(values[0][1],{songId:source.id,duration:song.duration});
 if(!lyrics)throw fail('invalid_payload');
 return {candidate:{song,lyrics:cleanLyrics(lyrics,{duration:song.duration,title:song.title,artist:song.artist})}};
}

async function freshIDReplay(source,request,{signal,fetchFn}) {
 let QQMusicAPI;try{({QQMusicAPI}=await import('../api/music-apis/qq.js'));}catch{throw fail('module_unavailable');}
 const api=new QQMusicAPI(),fresh=await api.getRecording(source.id,{...request,signal,fetchFn});
 if(!fresh?.song||!fresh.lyrics)throw fail('recording_mismatch');
 const lyrics=cleanLyrics(fresh.lyrics,{duration:fresh.song.duration,title:fresh.song.title,artist:fresh.song.artist});
 if(!hasUsableLyrics(lyrics,{duration:fresh.song.duration})||isRejectedRecordingLyrics(lyrics.lines,request))throw fail('recording_mismatch');
 return {candidate:{song:fresh.song,lyrics,api}};
}

async function fingerprints(root) {
 const paths=['api/music-apis','api/utils/vendor'];const files=[];
 for(const path of paths)try{for(const name of await readdir(join(root,path)))if(name.endsWith('.js'))files.push(join(path,name));}catch{}
 files.push(...['lyric-selection','vocal-timing','hedged-lookup','recording-match','lyric-quality','lyric-annotations','kugou-krc','qq-qrc'].map(n=>`api/utils/${n}.js`));
 const hashes={};for(const file of files.sort())try{hashes[file]=sha(await readFile(join(root,file)));}catch{}
 return {files:hashes,SHA256:sha(hashes)};
}

export function aggregateResults(results) {
 const groups={};
 for(const row of results){const key=row.mode;const g=groups[key]??={attempts:0,returned:0,measured:0,completeMeasured:0,wrongIdentityReturned:0,failures:{},successfulLatencyMS:[],measuredLatencyMS:[]};
  g.attempts++;g.wrongIdentityReturned+=(row.providerAttempts??[]).filter(a=>a.identity?.admitted===false).length;if(row.status==='returned'){g.returned++;g.measured+=Number((row.summary?.coverage.covered??0)>0);g.completeMeasured+=Number(row.summary?.coverage.complete===true);g.wrongIdentityReturned+=Number(row.summary?.identity.admitted===false);g.successfulLatencyMS.push(row.elapsedMS);if((row.summary?.coverage.covered??0)>0)g.measuredLatencyMS.push(row.elapsedMS);}
  else g.failures[row.status]=(g.failures[row.status]??0)+1;
 }
 for(const g of Object.values(groups)){for(const key of ['successfulLatencyMS','measuredLatencyMS']){const sorted=g[key].sort((a,b)=>a-b);const percentile=p=>sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;
  g[key]={samples:sorted.length,p50:percentile(.5),p95:percentile(.95)};}g.latencyQualification='Successful source-envelope/adapter samples only; failures remain in coverage denominator, not counted as fast responses.';}
 return groups;
}

export async function runBenchmark({corpus,baselineRoot=null,runs=1,maxTimeMS=30000,providerTimeoutMS=6000,concurrency=1}={},dependencies={}) {
 const recordings=validateCorpus(corpus);
 if(!Number.isInteger(runs)||runs<1||runs>5||!Number.isFinite(maxTimeMS)||maxTimeMS<10||maxTimeMS>120000||!Number.isFinite(providerTimeoutMS)||providerTimeoutMS<10||providerTimeoutMS>16000||!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw fail('invalid_options');
 const sets=dependencies.adapterSets??[baselineRoot?await loadSet(resolve(baselineRoot),'original-lyrica'): {id:'original-lyrica',unavailable:true},await loadSet(ROOT,'updated-lyrica')];
 const now=dependencies.now??(()=>performance.now()),results=[],jobs=[];
 for(let run=0;run<runs;run++)for(const request of recordings)jobs.push({run,request});
 let next=0;
 await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{
  while(next<jobs.length){const {run,request}=jobs[next++],caseStart=now();
   const modes=[...sets.map(set=>({id:set.id,kind:'production_adapter_selection',work:(options)=>adapterReplay(set,request,options)})),
    ...(request.directSources??[]).flatMap(source=>[{id:`dynamic-style-${source.provider}-${source.provider==='kugou'?'krc':'qrc'}`,kind:'fixed_source_request_envelope',work:options=>(dependencies.directReplay??directReplay)(source,request,options)},...(source.provider==='qq'?[{id:'updated-qq-fresh-id',kind:'fresh_source_id_revalidation',work:options=>(dependencies.freshIDReplay??freshIDReplay)(source,request,options)}]:[])])];
   // Alternate selection order across repetitions; fixed-ID direct envelopes
   // remain a separate lane and cannot be substituted for adapter matching.
   if(run%2)modes.splice(0,sets.length,...modes.slice(0,sets.length).reverse());
   for(const mode of modes){const requests=[],started=now(),budget=maxTimeMS-(started-caseStart);
    const row={caseID:request.caseID,caseRole:request.caseRole??'coverage',run,mode:mode.id,kind:mode.kind,cache:(mode.kind==='production_adapter_selection'?'new_adapter_instances':'no_client_cache')+'; upstream_OS_DNS_TLS_caches_uncontrolled',requests};
    if(budget<=0){const exhausted={...row,status:'case_budget_exhausted',elapsedMS:0};results.push(exhausted);dependencies.onResult?.(exhausted);continue;}
    try{const result=await bounded(signal=>mode.work({signal,fetchFn:observedFetch(dependencies.fetchFn??fetch,requests,now),providerTimeoutMS,now}),budget);
     row.providerAttempts=result.providerAttempts;
     if(result.candidate){row.summary=summarizeCandidate(result.candidate,request);row.status=row.summary.identity.admitted?'returned':'recording_mismatch';}
     else row.status=['timeout','provider_unavailable','recording_mismatch'].find(code=>result.providerAttempts?.some(a=>a.failure===code))??'absent';
    }catch(error){row.status=failure(error);}
    row.elapsedMS=Math.max(0,now()-started);results.push(row);dependencies.onResult?.(row);
   }
  }
 }));
 results.sort((a,b)=>a.run-b.run||recordings.findIndex(r=>r.caseID===a.caseID)-recordings.findIndex(r=>r.caseID===b.caseID)||a.mode.localeCompare(b.mode));
 return {version:1,capturedAtUTC:new Date().toISOString(),kind:'anonymous_provider_source_path_comparison',
  configuration:{runs,maxTimeMS,providerTimeoutMS,concurrency,caseIDs:recordings.map(r=>r.caseID)},
  limitations:['No stock Dynamic Lyrics app execution, playback clock, visible latency, account access, protected service or modified IPA execution.',
   'Fixed-source envelopes bypass production discovery/tie consensus; they establish route availability only. Metadata matches do not establish acoustic alignment or cross-catalog equivalence.',
   'Dynamic-style lanes replay established public endpoint/parameter families with this harness transport/parser, not the complete competitor ranking, authentication, cache or timing.',
   'Fresh-ID revalidation uses the new production getRecording method with a known public ID and fresh metadata; it omits discovery and does not establish a cached verified hint.',
   'Each production lane uses its own original/current registry, selector and hedge with fresh adapter instances. No production auth, HTTP service, database, Redis or saved-document latency is included.',
   'Cache state of upstream services, OS, DNS and TLS is uncontrolled. Successful latency quantiles exclude failures, which remain explicit in coverage denominators.'],
  results,aggregate:aggregateResults(results),coverageCasesAggregate:aggregateResults(results.filter(r=>r.caseRole==='coverage')),versionControlsAggregate:aggregateResults(results.filter(r=>r.caseRole==='version_or_language_control'))};
}

async function main() {
 const {values}=parseArgs({options:{corpus:{type:'string'},output:{type:'string'},'baseline-root':{type:'string'},runs:{type:'string',default:'1'},'max-time-ms':{type:'string',default:'30000'},'provider-timeout-ms':{type:'string',default:'6000'},concurrency:{type:'string',default:'1'},ids:{type:'string'},progress:{type:'boolean',default:false}}});
 if(!values.output)throw new Error('Use --output <summary.json> [--baseline-root <original checkout>] [--corpus <json>] [--ids <caseID,...>] [--runs 1..5] [--max-time-ms 30000] [--provider-timeout-ms 6000] [--concurrency 1..3]');
 let corpus=JSON.parse(await readFile(resolve(values.corpus??join(ROOT,'docs/research/word-timing-corpus.json'))));
 corpus={...(Array.isArray(corpus)?{}:corpus),recordings:validateCorpus(corpus)};
 if(values.ids){const ids=new Set(values.ids.split(','));corpus.recordings=corpus.recordings.filter(r=>ids.has(r.caseID));}
 const before={updated:await fingerprints(ROOT),...(values['baseline-root']?{original:await fingerprints(resolve(values['baseline-root']))}:{})};
 const report=await runBenchmark({corpus,baselineRoot:values['baseline-root'],runs:Number(values.runs),maxTimeMS:Number(values['max-time-ms']),providerTimeoutMS:Number(values['provider-timeout-ms']),concurrency:Number(values.concurrency)},{onResult:values.progress?(row=>process.stdout.write(JSON.stringify({caseID:row.caseID,mode:row.mode,status:row.status,elapsedMS:Math.round(row.elapsedMS),coverage:row.summary?.coverage??null})+'\n')):undefined});
 report.sourceFingerprints={updated:await fingerprints(ROOT),...(values['baseline-root']?{original:await fingerprints(resolve(values['baseline-root']))}:{})};
 report.sourceChangedDuringRun=Object.keys(before).some(k=>before[k].SHA256!==report.sourceFingerprints[k].SHA256);report.startedSourceFingerprints=before;
 report.harnessSHA256=sha(await readFile(fileURLToPath(import.meta.url)));report.corpusSHA256=sha(corpus);
 const path=resolve(values.output);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(report,null,2)+'\n');
 process.stdout.write(JSON.stringify({output:path,aggregate:report.aggregate,qualification:report.kind})+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Word-timing benchmark failed; verify options and local source modules. Raw provider errors are intentionally redacted.\n');process.exitCode=1;});
