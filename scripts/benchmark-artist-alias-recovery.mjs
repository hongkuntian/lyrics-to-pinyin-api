// Controlled cohort on the existing production-service benchmark. Never sends
// requests to a provider, authenticates an app, or retains provider lyrics.
import {writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runCatalogBenchmark} from './benchmark-catalog-word-timing.mjs';
import {recoveryCorpus,fixtureAPI} from '../tests/helpers/artist-alias-recovery.js';
import {identityCatalog} from '../tests/helpers/artist-identities.js';
import {createArtistIdentityResolver} from '../api/utils/artist-identities.js';

const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;};
const counts=calls=>({total:calls.length,search:calls.filter(c=>c.path==='/search').length,
  profile:calls.filter(c=>c.path==='/artist/detail').length,lyrics:calls.filter(c=>['/lyric/new','/lyric'].includes(c.path)).length});
export async function evaluateRecovery({roots,runs=3,delayMS=20,cases=recoveryCorpus().cases}={}) {
  if(!Number.isInteger(delayMS)||delayMS<0||delayMS>100||!roots?.length||!roots.some(([id])=>id==='candidate')
    ||new Set(roots.map(([id])=>id)).size!==roots.length)throw new Error('invalid_recovery_benchmark');
  const modules=await Promise.all(roots.map(async([id,root])=>({id,root,
    revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    NeteaseAPI:(await import(pathToFileURL(resolve(root,'api/music-apis/netease.js')))).NeteaseAPI,
    createService:(await import(pathToFileURL(resolve(root,'api/music-romanize.js')))).createMusicRomanizeService})));
  const results=[];
  for(const row of cases) {
    const latest=new Map(),modes=modules.map(m=>({id:m.id,createService:()=>{
      const f=fixtureAPI(m.NeteaseAPI,row,{delayMS});
      const resolveArtistIdentitiesFn=row.recording.metadata.artist_ids
        ?createArtistIdentityResolver({fetchFn:identityCatalog(row.recording,row.songs[0],row.profiles).fetchFn}):undefined;
      const service=m.createService({redis:null,getAvailableAPIsFn:()=>[f.api],resolveArtistIdentitiesFn,logger:{info(){},error(){}}});
      return async(req,res)=>{await service(req,res);latest.set(m.id,{calls:counts(f.calls),queries:f.calls.filter(c=>c.path==='/search').map(c=>c.query)});};
    }}));
    await runCatalogBenchmark({corpus:{version:1,cases:[{caseID:row.caseID,platform:'spotify',request:{recording:row.recording}}],limitations:[]},
      modes,runs,concurrency:1,onResult:r=>{
        const accepted=r.status===200,sourceID=r.summary?.source.itemID??null;
        results.push({...r,...latest.get(r.mode),role:row.role,kind:row.kind,expectedSourceID:row.expectID,
          accepted,correct:row.expectID===null?!accepted:accepted&&sourceID===row.expectID&&r.summary?.completeMeasured===true,
          falseAccept:accepted&&(row.expectID===null||sourceID!==row.expectID)});
      }});
  }
  const aggregate=Object.fromEntries(modules.map(m=>{
    const rows=results.filter(r=>r.mode===m.id),positive=rows.filter(r=>r.role!=='reject'),negative=rows.filter(r=>r.role==='reject');
    const controls=rows.filter(r=>r.role==='control');
    return [m.id,{revision:m.revision,attempts:rows.length,positiveAccepted:positive.filter(r=>r.correct).length,positiveAttempts:positive.length,
      negativeRejected:negative.filter(r=>r.correct).length,negativeAttempts:negative.length,falseAccepts:rows.filter(r=>r.falseAccept).length,
      providerCalls:rows.reduce((n,r)=>n+r.calls.total,0),controlCalls:controls.reduce((n,r)=>n+r.calls.total,0),
      controlLatencyMS:{p50:percentile(controls.map(r=>r.elapsedMS),0.5),p95:percentile(controls.map(r=>r.elapsedMS),0.95)},
      maxSearchCalls:Math.max(...rows.map(r=>r.calls.search))}];
  }));
  return {version:1,kind:'controlled_production_service_artist_recovery_comparison',createdAt:new Date().toISOString(),runs,delayMS,
    cohortCases:cases.length,aggregate,results,limitations:recoveryCorpus().limitations,
    acceptance:{candidateCorrect:results.filter(r=>r.mode==='candidate').every(r=>r.correct),
      noFalseAccepts:results.every(r=>!r.falseAccept),twoSearchBound:results.every(r=>r.calls.search<=2),
      unchangedControlCalls:!aggregate.baseline||aggregate.baseline.controlCalls===aggregate.candidate.controlCalls}};
}
async function main() {
  const {values}=parseArgs({options:{'baseline-root':{type:'string'},out:{type:'string'},runs:{type:'string',default:'3'},'delay-ms':{type:'string',default:'20'}}});
  const candidate=fileURLToPath(new URL('..',import.meta.url));
  const roots=[...(values['baseline-root']?[['baseline',resolve(values['baseline-root'])]]:[]),['candidate',candidate]];
  const report=await evaluateRecovery({roots,runs:Number(values.runs),delayMS:Number(values['delay-ms'])});
  if(values.out)await writeFile(values.out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({cohortCases:report.cohortCases,aggregate:report.aggregate,acceptance:report.acceptance},null,2));
  if(Object.values(report.acceptance).some(value=>!value))process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
