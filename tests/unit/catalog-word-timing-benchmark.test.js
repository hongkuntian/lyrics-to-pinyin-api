import test from 'node:test';
import assert from 'node:assert/strict';
import {runCatalogBenchmark,coverageGate} from '../../scripts/benchmark-catalog-word-timing.mjs';
const sentinel='Invented lyric sentinel';
const request={catalog_id:'123',artist:'Synthetic',title:'Synthetic',duration:30};
const response={song:{id:42,duration:30},quality:{synced:true},metadata:{source:'NeteaseAPI',lyric_timing:{version:1,provider:'appleMusic',recordingID:'123',source:'netease:42:yrc',revision:'a'.repeat(64)}},
 lines:[{original:sentinel,timestamp:1,vocalTiming:{end:2,segments:[{text:sentinel,utf16Start:0,utf16Length:sentinel.length,start:1,end:2}]}}]};
const mode=(id,body,status=200)=>({id,createService:()=>async(_,res)=>res.status(status).json(body)});
test('catalog benchmark counts exact bound words separately from readable and observed availability',async()=>{
 const corpus={version:1,limitations:[],cases:[{caseID:'invented',platform:'apple',request}]};
 const line=structuredClone(response);delete line.metadata.lyric_timing;delete line.lines[0].vocalTiming;
 const report=await runCatalogBenchmark({corpus,modes:[mode('before',line),mode('after',response)]});
 assert.equal(report.aggregate.before.readable,1);assert.equal(report.aggregate.before.completeMeasured,0);
 assert.equal(report.aggregate.after.completeMeasured,1);assert.equal(report.aggregate.before.observedAvailableAttempts,1);
 assert.equal(JSON.stringify(report).includes(sentinel),false);
 const wrong=structuredClone(response);wrong.metadata.lyric_timing.recordingID='124';
 const rejected=await runCatalogBenchmark({corpus,modes:[mode('wrong',wrong),mode('offline',{error:sentinel},502)]});
 assert.deepEqual(rejected.observedAvailableCaseIDs,[]);assert.equal(JSON.stringify(rejected).includes(sentinel),false);
});

test('catalog sample retains both catalogs and every exact reported Spotify recording',async()=>{
 const {readFile}=await import('node:fs/promises');
 const corpus=JSON.parse(await readFile(new URL('../../docs/research/measured-discovery-corpus.json',import.meta.url),'utf8'));
 assert.ok(corpus.cases.filter(c=>c.platform==='apple').length>=12);
 assert.ok(corpus.cases.filter(c=>c.platform==='spotify').length>=10);
 for(const id of ['46fURCnWErjFdNM2yBJ2c8','56UzFYxgkvxU188BsCKBOc','2wzXhxWPX0aODraKNXoJYY'])assert.ok(corpus.cases.some(c=>c.request.recording?.item_id===id));
});

test('larger live sweeps bound case concurrency without dropping or duplicating requests',async()=>{
 let active=0,peak=0,calls=0;
 const service={id:'fixture',createService:()=>async(_,res)=>{calls++;peak=Math.max(peak,++active);await new Promise(r=>setImmediate(r));active--;res.json(response);}};
 const corpus={version:1,limitations:[],cases:Array.from({length:7},(_,i)=>({caseID:'case-'+i,platform:'apple',request}))};
 const report=await runCatalogBenchmark({corpus,modes:[service],concurrency:2});
 assert.equal(calls,7);assert.equal(peak,2);assert.equal(report.results.length,7);
 assert.equal(report.aggregate.fixture.completeMeasured,7);
 await assert.rejects(runCatalogBenchmark({corpus,modes:[service],concurrency:3}),/invalid_benchmark/);
});

test('frozen availability evidence retains a failed counterpart in the coverage denominator',async()=>{
 const corpus={version:1,limitations:[],cases:[{caseID:'eligible-miss',platform:'apple',request,availabilityEvidence:{fromCaseID:'prior-source-positive'}}]};
 const report=await runCatalogBenchmark({corpus,modes:[mode('candidate',{},504)]});
 assert.equal(report.aggregate.candidate.completeMeasured,0);
 assert.equal(report.aggregate.candidate.observedAvailableAttempts,1);
 assert.deepEqual(report.observedAvailableCaseIDs,['eligible-miss']);
});

test('availability gate rejects missing attempts and keeps every eligible miss in its threshold',()=>{
 const corpus={cases:Array.from({length:107},()=>({availabilityEvidence:{fromCaseID:'frozen-source'}}))};
 const report={runs:1,aggregate:{candidate:{attempts:107,observedAvailableAttempts:107,completeMeasured:106}}};
 assert.equal(coverageGate(report,corpus,.99).passed,true);
 assert.equal(coverageGate(report,corpus,1).passed,false);
 assert.equal(coverageGate(report,corpus,.99).rate,106/107);
 assert.throws(()=>coverageGate({...report,aggregate:{candidate:{...report.aggregate.candidate,attempts:106}}},corpus,.99),/invalid_coverage_gate/);
 assert.throws(()=>coverageGate(report,{cases:[{}]},.99),/invalid_coverage_gate/);
 assert.throws(()=>coverageGate(report,corpus,NaN),/invalid_coverage_gate/);
});
