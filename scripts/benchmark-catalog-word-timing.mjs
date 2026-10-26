// Live production-service acquisition, without app authentication or lyric-body
// retention. Run explicitly; hermetic CI only exercises injected services.
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {vocalCoverage,validTimingProvenance} from '../api/utils/vocal-timing.js';
import {verifySpotifyBinding,sourceCapsule,independentProvider} from '../api/utils/song-library/spotify-recording.js';

export function diagnosticProviders(getAvailable,provider){
 if(!['netease','qq','kugou','lrclib'].includes(provider))throw new Error('invalid_diagnostic_provider');
 return script=>getAvailable(script).filter(api=>independentProvider(api.name)===provider);
}

export function summarizeResponse(response,request) {
 const timing=response?.metadata?.lyric_timing,song=response?.song;
 let bound=validTimingProvenance(timing)&&timing.source.split(':')[1]===String(song?.id);
 if(request.recording){
  try{verifySpotifyBinding(response.recordingBinding,request.recording,sourceCapsule(response),response.metadata.selection_revision,response);}
  catch{bound=false;}
  bound=bound&&timing?.provider==='spotify'&&timing.recordingID===request.recording.item_id;
 }else bound=bound&&timing?.provider==='appleMusic'&&timing.recordingID===request.catalog_id;
 const lines=Array.isArray(response?.lines)?response.lines:[];
 const coverage=vocalCoverage(lines.map(l=>({...l,text:l.original})),{duration:song?.duration??7200,durationResolution:timing?.durationResolution??0,provenance:bound});
 return {readable:lines.length>0||response?.quality?.instrumental===true,lineTimed:response?.quality?.synced===true,
  completeMeasured:coverage.complete,coverage,rows:lines.length,cues:bound?lines.reduce((n,l)=>n+(l.vocalTiming?.segments?.length??0),0):0,
  source:{provider:response?.metadata?.source??null,itemID:song?.id==null?null:String(song.id),timing:bound?timing.source:null},
  acousticVerified:false};
}

export async function runCatalogBenchmark({corpus,modes,runs=1,concurrency=1,onResult}={}) {
 if(corpus?.version!==1||!Array.isArray(corpus.cases)||!corpus.cases.length||corpus.cases.length>500
  ||new Set(corpus.cases.map(c=>c.caseID)).size!==corpus.cases.length||!Number.isInteger(runs)||runs<1||runs>3
  ||!Number.isInteger(concurrency)||concurrency<1||concurrency>2
  ||!Array.isArray(modes)||!modes.length||modes.some(m=>typeof m.createService!=='function'))throw new Error('invalid_benchmark');
 const results=[],jobs=[];
 for(let run=1;run<=runs;run++)for(const [index,row] of corpus.cases.entries())for(const mode of (index+run)%2?modes:[...modes].reverse()) {
  jobs.push({run,row,mode});
 }
 let next=0;
 await Promise.all(Array.from({length:concurrency},async()=>{while(next<jobs.length){
  const index=next++,{run,row,mode}=jobs[index];
  const start=Date.now(),res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  let summary=null;
  try{
   const service=mode.createService();
   await service({method:'POST',body:{...structuredClone(row.request),options:{refresh:true,lyric_sources_version:2}}},res);
   if(res.statusCode===200)summary=summarizeResponse(res.body,row.request);
  }catch{res.statusCode=502;}
  const result={run,caseID:row.caseID,platform:row.platform,mode:mode.id,status:res.statusCode,elapsedMS:Date.now()-start,summary};
  results[index]=result;onResult?.(result);
 }}));
 const knownAvailable=[...new Set([...corpus.cases.filter(c=>c.availabilityEvidence).map(c=>c.caseID),...results.filter(r=>r.summary?.completeMeasured).map(r=>r.caseID)])];
 const aggregate=Object.fromEntries(modes.map(m=>{
  const rows=results.filter(r=>r.mode===m.id),complete=rows.filter(r=>r.summary?.completeMeasured);
  return [m.id,{attempts:rows.length,readable:rows.filter(r=>r.summary?.readable).length,lineTimed:rows.filter(r=>r.summary?.lineTimed).length,
   completeMeasured:complete.length,observedAvailableAttempts:rows.filter(r=>knownAvailable.includes(r.caseID)).length,
   completeCaseIDs:[...new Set(complete.map(r=>r.caseID))]}];
 }));
 return {version:1,kind:'local-production-service-live-provider-benchmark',createdAt:new Date().toISOString(),runs,concurrency,
  limitations:[...corpus.limitations,'Availability includes frozen prior source-positive screening evidence and current complete results. Failed eligible attempts stay in the denominator. Failures do not establish absence upstream.','No deployed authenticated request, physical playback, acoustic alignment or stock competitor execution is verified.'],
  observedAvailableCaseIDs:knownAvailable,aggregate,results};
}

export function coverageGate(report,corpus,minimum){
 const candidate=report.aggregate?.candidate,expected=corpus.cases.length*report.runs;
 if(!Number.isFinite(minimum)||minimum<0||minimum>1||!corpus.cases.length
  ||corpus.cases.some(c=>!c.availabilityEvidence)||!candidate
  ||candidate.attempts!==expected||candidate.observedAvailableAttempts!==expected
  ||!Number.isInteger(candidate.completeMeasured)||candidate.completeMeasured<0||candidate.completeMeasured>expected)
  throw new Error('invalid_coverage_gate');
 const rate=candidate.completeMeasured/expected;
 return {passed:rate>=minimum,minimum,rate,complete:candidate.completeMeasured,attempts:expected};
}

export function selectCatalogCases(corpus,ids) {
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!corpus.cases.some(row=>row.caseID===id)))
  throw new Error('invalid_case_selection');
 return {...corpus,cases:corpus.cases.filter(row=>ids.includes(row.caseID)),
  limitations:[...corpus.limitations,`Explicit subset: ${ids.length} of ${corpus.cases.length} maintained cases; not a whole-corpus result.`]};
}

async function main(){
 const {values}=parseArgs({options:{corpus:{type:'string',default:'docs/research/measured-discovery-corpus.json'},'baseline-root':{type:'string'},out:{type:'string'},runs:{type:'string',default:'1'},concurrency:{type:'string',default:'1'},'minimum-available-rate':{type:'string'},'case-ids':{type:'string'},'only-provider':{type:'string'}}});
 if(values['only-provider']&&values['minimum-available-rate']!==undefined)throw new Error('diagnostic_is_not_combined_coverage_acceptance');
 const original=JSON.parse(await readFile(values.corpus,'utf8')),corpus=values['case-ids']?selectCatalogCases(original,values['case-ids'].split(',')):original,modes=[];
 const roots=[...(values['baseline-root']?[['baseline',resolve(values['baseline-root'])]]:[]),['candidate',fileURLToPath(new URL('..',import.meta.url))]];
 for(const [id,root] of roots){
  const {createMusicRomanizeService}=await import(pathToFileURL(resolve(root,'api/music-romanize.js')));
  const {getAvailableAPIs}=await import(pathToFileURL(resolve(root,'api/music-apis/index.js')));
  const overrides=values['only-provider']?{getAvailableAPIsFn:diagnosticProviders(getAvailableAPIs,values['only-provider'])}:{};
  modes.push({id,createService:()=>createMusicRomanizeService({redis:null,logger:{info(){},error(){}},...overrides})});
 }
 const report=await runCatalogBenchmark({corpus,modes,runs:Number(values.runs),concurrency:Number(values.concurrency),onResult:r=>console.log(JSON.stringify(r))});
 if(values['only-provider']){
  report.kind='local-isolated-provider-discovery-diagnostic';report.provider=values['only-provider'];
  report.limitations.push('Isolated provider discovery uses ordinary admission and provider deadlines, but bypasses the combined source schedule. A positive establishes admitted source availability, not combined pipeline or phone success.');
 }
 if(values['minimum-available-rate']!==undefined)report.acceptance=coverageGate(report,corpus,Number(values['minimum-available-rate']));
 if(values.out)await writeFile(values.out,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({aggregate:report.aggregate,observedAvailable:report.observedAvailableCaseIDs.length,acceptance:report.acceptance}));
 if(report.acceptance&&!report.acceptance.passed)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
