// Bounded, opt-in experiment. No database, production writes, automatic retries,
// provider fallback, or model comparison. Complete inputs and outputs stay private.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {explanationBody,generateExplanation} from '../api/utils/song-library/study-explanation.js';
import {reservationMicros} from '../api/utils/song-library/translation.js';
import {makeDocument} from '../api/utils/song-library/document.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const sources=['scripts/evaluate-content-quality.mjs','api/utils/song-library/study-explanation.js','api/utils/song-library/study-grounding.js','api/utils/song-library/translation.js','api/utils/song-library/model-policy.js'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sources.map(async file=>[file,hash(await fs.readFile(new URL('../'+file,import.meta.url),'utf8'))])));
const count=text=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].length;
export function caseInput(spec,snapshot) {
 let doc,translation=null;
 if(spec.lines) {
  const response={song:{title:{original:spec.id},artist:{original:'Original evaluation text'},language:spec.language},metadata:{source:'authored-evaluation'},quality:{partial:false,instrumental:false},lines:spec.lines.map(original=>({original,romanized:''}))};
  doc=makeDocument({catalog_id:'1',title:spec.id,artist:'Original evaluation text',duration:30},response,'evaluation',spec.speakers??{});
 } else {
  const row=snapshot.rows.find(r=>r.response.song.title.original===spec.title);if(!row)throw new Error('source_missing');
  doc={id:row.document_id,sourceHash:row.source_hash,response:row.response,structure:row.structure};
  translation={id:row.id,target:row.target,...structuredClone(row.content)};
  if(spec.replaceTranslation) {
   translation.id='controlled-stress-'+translation.id;
   const line=translation.lines.find(l=>l.sourceID===spec.sourceID);line.lyricText=line.text=spec.replaceTranslation;
  }
 }
 const occurrence=spec.sourceID?doc.structure.occurrences.find(o=>o.sourceID===spec.sourceID):doc.structure.occurrences[spec.line];
 const layer=spec.layer??'original';
 const row=layer==='original'?occurrence.lyricText:translation.lines.find(l=>l.sourceID===occurrence.sourceID).lyricText;
 const matches=[];let cursor=0;
 while(spec.text&&cursor<=row.length) {
  const index=row.indexOf(spec.text,cursor);if(index<0)break;
  matches.push(index);cursor=index+spec.text.length;
 }
 if(matches.length>1&&spec.textOccurrence===undefined)throw new Error('selection_ambiguous');
 const which=spec.textOccurrence??0;
 if(!Number.isSafeInteger(which)||which<0||which>=matches.length)throw new Error('selection_missing');
 const index=matches[which];
 const selection={sourceID:occurrence.sourceID,lower:count(row.slice(0,index)),upper:count(row.slice(0,index))+count(spec.text),text:spec.text,
  studyText:{layer,revisionID:layer==='original'?doc.id:translation.id,occurrenceID:occurrence.sourceID,...(layer==='translation'?{target:translation.target}:{})}};
 return {doc,translation,selection};
}
export async function prepare({snapshot,corpus,directory,budgetMicros,previousAccountedMicros=0}) {
 if(!Number.isSafeInteger(budgetMicros)||budgetMicros<=0||budgetMicros>5_000_000)throw new Error('invalid_authorized_budget');
 if(!Number.isSafeInteger(previousAccountedMicros)||previousAccountedMicros<0)throw new Error('invalid_previous_accounting');
 const jobs=[];
 for(const spec of corpus.cases) {
  const input=caseInput(spec,snapshot);
  for(let repeat=1;repeat<=(spec.phase==='diagnostic'?2:1);repeat++) {
   for(const condition of repeat%2?['control','grounded']:['grounded','control']) {
    const body=explanationBody(input.doc,input.translation,input.selection,'en',{grounded:condition==='grounded'});
    jobs.push({id:`${spec.id}-${repeat}-${condition}`,caseID:spec.id,phase:spec.phase,repeat,condition,checks:spec.checks,stress:Boolean(spec.replaceTranslation),...input,body,reservedMicros:reservationMicros(body)});
   }
  }
 }
 const total=jobs.reduce((n,j)=>n+j.reservedMicros,0);if(total+previousAccountedMicros>budgetMicros)throw new Error('evaluation_budget_exceeded');
 const plan={version:'content-quality-plan-1',hypothesis:corpus.hypothesis,at:new Date().toISOString(),budgetMicros,previousAccountedMicros,maxReservedMicros:total,sourceHashes:await sourceHashes(),corpusHash:hash(corpus),snapshotHash:hash(snapshot),jobs};
 await fs.mkdir(directory,{recursive:true});await save(path.join(directory,'plan.json'),plan);
 return {planHash:hash(plan),jobs:jobs.length,maxReservedMicros:total,budgetMicros};
}
export async function run({directory,approvedHash,apiKey,generateFn=generateExplanation}) {
 const plan=JSON.parse(await fs.readFile(path.join(directory,'plan.json'),'utf8'));
 if(!apiKey)throw new Error('provider_key_required');
 if(hash(plan)!==approvedHash||plan.version!=='content-quality-plan-1')throw new Error('plan_changed');
 if(JSON.stringify(plan.sourceHashes)!==JSON.stringify(await sourceHashes()))throw new Error('generation_code_changed');
 // Recompute all bounds before any external call; the immutable start marker
 // prohibits automatically resending a partially completed run.
 if(!Number.isSafeInteger(plan.budgetMicros)||plan.budgetMicros<=0||plan.budgetMicros>5_000_000||
  !Number.isSafeInteger(plan.previousAccountedMicros)||plan.previousAccountedMicros<0||
  plan.previousAccountedMicros+plan.jobs.reduce((n,j)=>n+reservationMicros(j.body),0)>plan.budgetMicros)throw new Error('evaluation_budget_exceeded');
 await save(path.join(directory,'started.json'),{planHash:approvedHash,at:new Date().toISOString()});
 const results=[];let accountedMicros=plan.previousAccountedMicros;
 for(const job of plan.jobs) {
  const started=Date.now();let result;
  try {
   const generated=await generateFn(job.doc,job.translation,job.selection,{apiKey,generationRequest:job.body});
   result={id:job.id,valid:true,content:generated.content,usage:generated.response.usage,actualMicros:generated.actualMicros,response:generated.response};
  } catch(e) {
   result={id:job.id,valid:false,error:/^[a-z_]{1,80}$/.test(e.code)?e.code:'evaluation_failure',actualMicros:e.actualMicros??null,response:e.providerResponse??null};
  }
  // Returned text cannot echo the credential into the retained evidence.
  if(JSON.stringify(result).includes(apiKey))result={id:job.id,valid:false,error:'provider_echoed_credentials',actualMicros:result.actualMicros,response:null};
  result.elapsedMs=Date.now()-started;
  result.accountedMicros=Number.isSafeInteger(result.actualMicros)&&result.actualMicros>=0?result.actualMicros:reservationMicros(job.body);
  accountedMicros+=result.accountedMicros;
  await save(path.join(directory,job.id+'.json'),result);results.push({id:job.id,valid:result.valid,error:result.error,accountedMicros:result.accountedMicros,elapsedMs:result.elapsedMs});
  console.log(JSON.stringify(results.at(-1)));
  if(accountedMicros>plan.budgetMicros)throw new Error('provider_cost_overrun');
  if(['provider_rejected','provider_configuration_changed','provider_echoed_credentials'].includes(result.error)) {
   await save(path.join(directory,'interrupted.json'),{planHash:approvedHash,accountedMicros,results});
   throw new Error('provider_configuration_stopped');
  }
 }
 const summary={planHash:approvedHash,at:new Date().toISOString(),accountedMicros,budgetMicros:plan.budgetMicros,results};
 await save(path.join(directory,'summary.json'),summary);return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const [command,...args]=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2)options[args[i]]=args[i+1];
 if(command==='prepare') {
  const snapshot=JSON.parse(await fs.readFile(options['--snapshot'],'utf8'));
  const corpus=JSON.parse(await fs.readFile(options['--corpus']??new URL('../evaluation/content-quality/cases.json',import.meta.url),'utf8'));
  console.log(JSON.stringify(await prepare({snapshot,corpus,directory:options['--directory'],budgetMicros:Number(options['--budget-micros']),previousAccountedMicros:Number(options['--previous-accounted-micros']??0)})));
 } else if(command==='run'&&options['--live']==='yes') {
  await run({directory:options['--directory'],approvedHash:options['--approved-plan-sha256'],apiKey:process.env.OPENAI_API_KEY});
 } else throw new Error('explicit_command_and_live_flag_required');
}
