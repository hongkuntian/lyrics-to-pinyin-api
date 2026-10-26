// Private playlist inputs stay outside the public repository. Acquisition uses
// benchmark-catalog-word-timing.mjs and the ordinary production service.
import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spotifyRecording} from '../api/utils/song-library/spotify-recording.js';

export function playlistCorpus(snapshot){
 try{
  if(snapshot?.version!==1||!Array.isArray(snapshot.collections)||!snapshot.collections.length
   ||snapshot.conflictingURIs?.length)throw 0;
  const records=new Map();let occurrences=0;
  for(const collection of snapshot.collections){
   const {pages,items}=collection;
   if(!Array.isArray(pages)||!pages.length||!Array.isArray(items))throw 0;
   const total=pages[0].totalItems;
   if(!Number.isInteger(total)||total<0||pages.some((p,i)=>p.page!==i+1||p.status!=='READY'
    ||p.totalItems!==total||!Number.isInteger(p.returned)||p.returned<0
    ||p.hasNext!==(i<pages.length-1)||!Array.isArray(p.explanations)||p.explanations.length)
    ||pages.reduce((n,p)=>n+p.returned,0)!==total||items.length!==total)throw 0;
   for(const item of items){
    if(item.entityType!=='MUSIC'||!/^spotify:track:[A-Za-z0-9]{22}$/.test(item.uri))throw 0;
    const recording=spotifyRecording({version:2,provider:'spotify',item_id:item.uri.split(':')[2],metadata:{origin:'spotify',
     title:item.title,artists:item.artists?.map(a=>a.name),album:item.album,duration_ms:item.durationMS}});
    const previous=records.get(recording.item_id);
    if(previous&&JSON.stringify(previous)!==JSON.stringify(recording))throw 0;
    records.set(recording.item_id,recording);occurrences++;
   }
  }
  if(!records.size||records.size>500||(snapshot.occurrences!==undefined&&snapshot.occurrences!==occurrences)
   ||(snapshot.uniqueTracks!==undefined&&snapshot.uniqueTracks!==records.size))throw 0;
  return {version:1,kind:'private_playlist_timing_evaluation',snapshot:{collections:snapshot.collections.length,occurrences,
   uniqueTracks:records.size,inventoryComplete:snapshot.inventoryComplete===true},limitations:[
    'Every page of the discovered collections is validated; connector discovery does not prove account-wide inventory.',
    'Metadata admission and measured cue coverage do not establish acoustic alignment or complete sung text.',
    'Failures remain in the denominator. Unknown availability is not upstream absence. Keep this personal corpus outside Git.'
   ],cases:[...records.values()].map(recording=>({caseID:'spotify-'+recording.item_id,platform:'spotify',request:{recording}}))};
 }catch{throw new Error('invalid_playlist_snapshot');}
}

function attempts(report,corpus){
 const ids=new Set(corpus.cases.map(c=>c.caseID)),seen=new Set();
 if(!Number.isInteger(report?.runs)||report.runs<1||report.runs>3||!Array.isArray(report.results)
  ||report.results.length!==ids.size*report.runs)throw new Error('incomplete_playlist_report');
 for(const row of report.results){
  const key=row.caseID+':'+row.run;
  if(row.mode!=='candidate'||!ids.has(row.caseID)||!Number.isInteger(row.run)||row.run<1||row.run>report.runs||seen.has(key)
   ||!Number.isInteger(row.status)||!Number.isFinite(row.elapsedMS)||row.elapsedMS<0
   ||row.summary?.completeMeasured&&(row.status!==200||!row.summary.lineTimed))throw new Error('incomplete_playlist_report');
  seen.add(key);
 }
 return report.results;
}
const complete=row=>row.status===200&&row.summary?.completeMeasured===true;
const readable=row=>row.status===200&&row.summary?.readable===true;
function availability(corpus,before,after){
 return new Set([...corpus.cases.filter(c=>c.availabilityEvidence).map(c=>c.caseID),...before.filter(complete).map(r=>r.caseID),...after.filter(complete).map(r=>r.caseID)]);
}
function aggregate(rows,known){
 const eligible=rows.filter(r=>known.has(r.caseID)),latency=rows.map(r=>r.elapsedMS).sort((a,b)=>a-b);
 const count=predicate=>rows.filter(predicate).length;
 return {attempts:rows.length,readable:count(readable),lineTimed:count(r=>r.status===200&&r.summary?.lineTimed===true),
  anyMeasured:count(r=>r.status===200&&r.summary?.cues>0),completeMeasured:count(complete),availableAttempts:eligible.length,availableComplete:eligible.filter(complete).length,
  availableHitRate:eligible.length?eligible.filter(complete).length/eligible.length:null,
  statuses:Object.fromEntries([...new Set(rows.map(r=>r.status))].map(status=>[status,count(r=>r.status===status)])),
  completionLatencyMS:{median:latency[Math.ceil(latency.length*.5)-1],p95:latency[Math.ceil(latency.length*.95)-1]}};
}
export function comparePlaylistReports(corpus,baseline,candidate){
 const before=attempts(baseline,corpus),after=attempts(candidate,corpus),known=availability(corpus,before,after);
 const rate=(rows,id,predicate)=>{const found=rows.filter(r=>r.caseID===id);return found.filter(predicate).length/found.length;};
 const recovered=[],lost=[],readableRegressions=[];
 for(const {caseID} of corpus.cases){
  const a=rate(before,caseID,complete),b=rate(after,caseID,complete);
  if(b>a)recovered.push(caseID);if(b<a)lost.push(caseID);
  if(rate(after,caseID,readable)<rate(before,caseID,readable))readableRegressions.push(caseID);
 }
 return {version:1,kind:'private-playlist-timing-comparison',createdAt:new Date().toISOString(),snapshot:corpus.snapshot??null,
  cases:corpus.cases.length,knownAvailable:known.size,unknownAvailability:corpus.cases.length-known.size,
  baseline:aggregate(before,known),candidate:aggregate(after,known),recovered,lost,readableRegressions,
  noObservedRegressions:!lost.length&&!readableRegressions.length,
  limitations:[...(corpus.limitations??[]),'Sequential live runs can differ because of provider availability and latency; aggregate improvement alone does not prove causality.',
   'Availability is the common union of frozen evidence and complete results in either run. Every eligible attempt counts; no best-of-retry scoring.',
   'Latency measures complete local-service requests, not first-readable streaming, deployed authentication or phone playback.']};
}
export function positivePlaylistCorpus(corpus,baseline,candidate){
 const before=attempts(baseline,corpus),after=attempts(candidate,corpus),known=availability(corpus,before,after);
 return {...corpus,kind:'private-frozen-source-positive-playlist-cohort',cases:corpus.cases.filter(c=>known.has(c.caseID)).map(c=>{
  const observed=[...before,...after].find(r=>r.caseID===c.caseID&&complete(r));
  return {...c,availabilityEvidence:c.availabilityEvidence??{fromCaseID:c.caseID,source:observed.summary.source,metadataOnly:true,
   observation:'Complete bound measured timing in the retained playlist screening report; source IDs never enter acquisition requests.'}};
 })};
}
async function main(){
 const {values}=parseArgs({options:{snapshot:{type:'string'},'corpus-out':{type:'string'},baseline:{type:'string'},candidate:{type:'string'},out:{type:'string'},'positive-out':{type:'string'}}});
 if(!values.snapshot)throw new Error('snapshot_required');
 const corpus=playlistCorpus(JSON.parse(await readFile(values.snapshot,'utf8')));
 if(values['corpus-out'])await writeFile(values['corpus-out'],JSON.stringify(corpus,null,2)+'\n');
 if(values.baseline||values.candidate){
  if(!values.baseline||!values.candidate||!values.out)throw new Error('both_reports_and_output_required');
  const baseline=JSON.parse(await readFile(values.baseline,'utf8')),candidate=JSON.parse(await readFile(values.candidate,'utf8'));
  const comparison=comparePlaylistReports(corpus,baseline,candidate);
  await writeFile(values.out,JSON.stringify(comparison,null,2)+'\n');
  if(values['positive-out'])await writeFile(values['positive-out'],JSON.stringify(positivePlaylistCorpus(corpus,baseline,candidate),null,2)+'\n');
  console.log(JSON.stringify({cases:comparison.cases,knownAvailable:comparison.knownAvailable,baseline:comparison.baseline,candidate:comparison.candidate,
   recovered:comparison.recovered.length,lost:comparison.lost.length,readableRegressions:comparison.readableRegressions.length}));
 }else console.log(JSON.stringify(corpus.snapshot));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
