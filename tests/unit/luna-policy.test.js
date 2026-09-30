import test from 'node:test';
import assert from 'node:assert/strict';
import {source} from '../helpers/library-db.js';
import {requestBody,parseTranslation,reservationMicros,usageMicros,generate} from '../../api/utils/song-library/translation.js';
import {explanationBody,generateExplanation} from '../../api/utils/song-library/study-explanation.js';
import {assessmentBody,parseAssessment,batchReservation,batchUsage,assessRecord} from '../../api/utils/song-library/review-assessment.js';
import {comparisonContext,verificationBody} from '../../api/utils/song-library/review-verification.js';

const content=parseTranslation(JSON.stringify({translations:{L0001:'Make today a song.'},sourceNotes:[]}),source);
const selection={sourceID:'L0001',text:'今天',lower:1,upper:3};
const assessment=parseAssessment(JSON.stringify({decision:'correct',summary:'Preserve the action.',changes:[{sourceID:'L0001',sourceQuote:source.structure.occurrences[0].sourceText,replacement:'Sing today into a song.',reason:'Singing transforms today.'}]}),source,content);
const response=(model,text)=>({id:'fixture',model,service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:1000},output:[{type:'message',content:[{type:'output_text',text}]}]});

test('every new generation and correction stage uses GPT-6 Luna with xhigh',()=>{
  for(const body of [requestBody(source),requestBody(source,'fr'),explanationBody(source,content,selection),
    explanationBody(source,content,selection,'fr'),assessmentBody(source,content,[]),
    verificationBody(source,content,assessment,comparisonContext(source,content,assessment,'A'))]) {
    assert.equal(body.model,'gpt-6-luna');assert.deepEqual(body.reasoning,{effort:'xhigh'});
    assert.equal(body.service_tier,'default');assert.equal(body.store,false);assert.equal(body.tools,undefined);
  }
});
test('standard and Batch accounting use the admitted model and reject unknown models',()=>{
  const usage={input_tokens:1000,output_tokens:1000};
  assert.equal(usageMicros(usage),625);assert.equal(batchUsage(usage),313);
  assert.equal(usageMicros(usage,'gpt-5.6-luna'),1450);assert.equal(batchUsage(usage,'gpt-5.6-luna'),725);
  assert.equal(usageMicros(usage,'unknown'),null);assert.equal(batchUsage(usage,'unknown'),null);
  for(const model of ['gpt-6-luna','gpt-5.6-luna']) {
    const body=requestBody(source,'en',{model}),input=Buffer.byteLength(JSON.stringify(body))+4096;
    const rates=model==='gpt-6-luna'?[0.125,0.5]:[0.25,1.2];
    assert.equal(reservationMicros(body),Math.ceil(input*rates[0]+body.max_output_tokens*rates[1]));
    assert.equal(batchReservation(body),Math.ceil((input*rates[0]+body.max_output_tokens*rates[1])/2));
  }
  assert.throws(()=>reservationMicros({...requestBody(source),model:'unknown'}),{code:'generation_configuration_unavailable'});
  assert.throws(()=>requestBody(source,'en',{model:'unknown'}),{code:'generation_configuration_unavailable'});
});
test('legacy translation requests retain their original model, effort, payload and price',async()=>{
  const body=requestBody(source,'en',{legacy:true});
  assert.equal(body.model,'gpt-5.6-luna');assert.equal(body.reasoning.effort,'high');
  let sent;
  const result=await generate(source,{apiKey:'fixture',generationRequest:body,fetchFn:async(url,init)=>{
    sent=JSON.parse(init.body);return new Response(JSON.stringify(response(body.model,JSON.stringify({translations:{L0001:'Make today a song.'},sourceNotes:[]}))));
  }});
  assert.deepEqual(sent,body);assert.equal(result.actualMicros,1450);
});
test('legacy Study requests retain their price while provider substitution remains unknown',async()=>{
  const body=explanationBody(source,content,selection,'en',{model:'gpt-5.6-luna'});
  const answer={meaning:'today',context:'The speaker sings about today.',grammar:'',uncertainty:'',sourceQuote:'今天'};
  const run=model=>generateExplanation(source,content,selection,{apiKey:'fixture',generationRequest:body,fetchFn:async()=>new Response(JSON.stringify(response(model,JSON.stringify(answer))))});
  assert.equal(body.reasoning.effort,'high');assert.equal((await run(body.model)).actualMicros,1450);
  await assert.rejects(run('gpt-6-luna'),{code:'provider_configuration_changed',actualMicros:null});
});
test('Batch settlement compares against its frozen request and uses legacy pricing when needed',()=>{
  const body=requestBody(source,'en',{model:'gpt-5.6-luna'});
  const record={response:{status_code:200,body:response(body.model,JSON.stringify({decision:'keep',summary:'Adequate.',changes:[]}))}};
  assert.equal(assessRecord(record,source,content,undefined,body).actualMicros,725);
  assert.equal(assessRecord(record,source,content).errorCode,'provider_configuration_changed');
  record.response.body.model='gpt-6-luna';
  assert.equal(assessRecord(record,source,content,undefined,body).actualMicros,null);
});
