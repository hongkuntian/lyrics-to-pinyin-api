// Explicit, bounded provider evaluation. No library database or production cache writes.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {generate,requestBody,reservationMicros} from '../api/utils/song-library/translation.js';
import {generateExplanation,explanationBody} from '../api/utils/song-library/study-explanation.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const targets=['en','fr','es','zh-Hans'];
export function documentFor(item) {
  const occurrences=item.lines.map((text,index)=>({sourceID:`L${String(index+1).padStart(4,'0')}`,sourceText:text,lyricText:text,speakerID:null,startsTurn:false,sourcePrefix:''}));
  return {id:hash(item.id),sourceHash:hash(item.lines.join('\n')),response:{song:{title:{original:item.title},artist:{original:'Lyra evaluation corpus'},language:item.language}},structure:{version:'source-speakers-1',speakers:[],occurrences}};
}
export function selectionForCase(item,doc) {
  const occurrence=doc.structure.occurrences[item.selection.line];
  const before=occurrence.lyricText.split(item.selection.text)[0];
  if(before===occurrence.lyricText)throw new Error('selection_missing');
  const count=text=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].length;
  return {sourceID:occurrence.sourceID,lower:count(before),upper:count(before)+count(item.selection.text),text:item.selection.text,textHash:hash(item.selection.text),studyText:{layer:'original',revisionID:doc.id,occurrenceID:occurrence.sourceID}};
}
export async function evaluate({apiKey,corpus,translate=generate,explain=generateExplanation,log=console.log,onlyDirections=null}={}) {
  if(!apiKey)throw new Error('evaluation_requires_provider_key');
  const jobs=[];
  for(const item of corpus.cases) {
    const doc=documentFor(item),selection=selectionForCase(item,doc);
    for(const target of targets.filter(t=>t!==(item.language==='zh'?'zh-Hans':item.language))) {
      const translationRequest=requestBody(doc,target),studyRequest=explanationBody(doc,null,selection,target);
      jobs.push({item,doc,target,selection,translationRequest,studyRequest});
    }
  }
  if(onlyDirections!==null) {
    const known=new Set(jobs.map(j=>`${j.item.language}:${j.target}`));
    if(!Array.isArray(onlyDirections)||!onlyDirections.length||onlyDirections.some(d=>!known.has(d)))throw new Error('invalid_evaluation_directions');
  }
  const allJobs=jobs.slice();
  if(onlyDirections!==null)jobs.splice(0,jobs.length,...allJobs.filter(j=>onlyDirections.includes(`${j.item.language}:${j.target}`)));
  const reserve=jobs.reduce((n,j)=>n+reservationMicros(j.translationRequest)+reservationMicros(j.studyRequest),2_400_000);
  if(allJobs.length!==12||reserve>3_000_000)throw new Error('evaluation_budget_exceeded');
  log(JSON.stringify({event:'multilingual_evaluation_start',cases:jobs.length,reservedMicros:reserve,corpusHash:hash(JSON.stringify(corpus))}));
  let index=0,failed=0;
  async function worker() {
    while(index<jobs.length) {
      const job=jobs[index++],{item,doc,target,selection}=job;
      try {
        const translated=await translate(doc,{apiKey,target,generationRequest:job.translationRequest});
        const explanation=await explain(doc,null,selection,{apiKey,explanationLanguage:target,generationRequest:job.studyRequest});
        let translatedStudy=null;
        if(item.language==='en') {
          const line=translated.content.lines[item.selection.line];
          const segments=[...new Intl.Segmenter(target,{granularity:'word'}).segment(line.lyricText)];
          const word=segments.find(s=>s.isWordLike);
          if(!word)throw new Error('translated_selection_missing');
          const count=text=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].length;
          const lower=count(line.lyricText.slice(0,word.index)),upper=lower+count(word.segment);
          const accepted={id:hash(`${item.id}:${target}`),target,lines:translated.content.lines};
          const translatedSelection={sourceID:line.sourceID,lower,upper,text:word.segment,textHash:hash(word.segment),studyText:{layer:'translation',revisionID:accepted.id,occurrenceID:line.sourceID,target}};
          translatedStudy=[];
          for(const language of targets) {
          const request=explanationBody(doc,accepted,translatedSelection,language);
          if(reservationMicros(request)>200_000)throw new Error('translated_study_budget_exceeded');
          const result=await explain(doc,accepted,translatedSelection,{apiKey,explanationLanguage:language,generationRequest:request});
          translatedStudy.push({language,selection:word.segment,explanation:result.content,responseID:result.response?.id,usageMicros:result.actualMicros});
          }
        }
        emitRecord(log,{translatedStudy,event:'multilingual_evaluation_case',case:item.id,direction:`${item.language}:${target}`,checks:item.checks,source:item.lines,translation:translated.content,selection:selection.text,explanation:explanation.content,usageMicros:(translated.actualMicros??0)+(explanation.actualMicros??0),translationResponseID:translated.response?.id,explanationResponseID:explanation.response?.id});
      } catch(error) {
        failed++;
        const providerCode=error.providerResponse?.error?.code;
        const providerType=error.providerResponse?.error?.type;
        const safe=value=>typeof value==='string'&&/^[a-z_]{1,80}$/.test(value)?value:null;
        log(JSON.stringify({providerCode:safe(providerCode),providerType:safe(providerType),event:'multilingual_evaluation_failure',case:item.id,direction:`${item.language}:${target}`,code:error.code??'evaluation_failed'}));
      }
    }
  }
  await Promise.all([worker(),worker()]);
  if(failed)throw new Error('evaluation_incomplete');
  log(JSON.stringify({event:'multilingual_evaluation_complete',cases:jobs.length}));
}
export function emitRecord(log,record) {
  const encoded=Buffer.from(JSON.stringify(record),'utf8').toString('base64');
  const count=Math.ceil(encoded.length/2000);
  for(let index=0;index<count;index++)log(JSON.stringify({event:'multilingual_evaluation_chunk',direction:record.direction,index,count,data:encoded.slice(index*2000,(index+1)*2000)}));
}
export async function runEvaluation(env=process.env) {
  const corpus=JSON.parse(await readFile(new URL('../evaluation/multilingual/corpus.json',import.meta.url),'utf8'));
  await evaluate({apiKey:env.OPENAI_API_KEY,corpus,onlyDirections:env.LYRA_EVALUATION_DIRECTIONS?JSON.parse(env.LYRA_EVALUATION_DIRECTIONS):null});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]!=='--live')throw new Error('explicit_live_flag_required');
  await runEvaluation();
}
