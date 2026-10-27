import test from 'node:test';
import assert from 'node:assert/strict';
import {qqLanguageObservations,kugouLanguageObservations,mergeLanguageObservations,bindProviderLanguageObservations,
 resolveProviderLanguageEvidence,providerLanguageSource} from '../../api/utils/provider-language-evidence.js';
import {analyzeLyricLanguage} from '../../api/utils/lyric-language.js';

const observedAt='2026-10-27T00:00:00.000Z';
const source={provider:'qq',id:'123'};
const lines=['Invented words for a synthetic source.'];
const analysis=(primary='und')=>({version:1,primary,languages:[primary],scripts:['Latn'],mixed:false,confidence:'unknown',
 pronunciation_language:null,pronunciation_basis:'unknown',lines:[{sourceID:'L0001',language:'und',confidence:'unknown'}]});
const qq=(labels=[],extra={})=>qqLanguageObservations('123',{track_info:{id:123,language:3,...extra},info:{lan:{title:'歌曲语种',content:labels.map((value,i)=>({id:i,value}))}}},{observedAt});
const kg=(label,extra={})=>kugouLanguageObservations('123',{id:'123',language:label,...extra},0,{observedAt});
const bound=(record,changes={})=>bindProviderLanguageObservations({lines:lines.map(text=>({text}))},
 {source:record.source.provider,id:'123'},record,{field:record.source.provider==='qq'?'/data/lyric':'/content',format:'lrc',...changes}).providerLanguageEvidence;
const resolve=(record,primary='und',changes={})=>resolveProviderLanguageEvidence(lines,analysis(primary),bound(record,changes),record.source);

for(const [label,language] of Object.entries({'日语':'ja','韩语':'ko','德语':'de','俄语':'ru','泰语':'th','印尼语':'id',
 '西班牙语':'es','葡萄牙语':'pt','意大利语':'it','越南语':'vi'}))test(`QQ ${label} is a declaration agreeing with ${language}, not a confirmation`,()=>{
 const result=resolve(qq([label]),language);assert.equal(result.decision.status,'agreement');assert.equal(result.decision.candidate,language);
 assert.equal(result.observations.length,2);assert.equal(result.observations.find(o=>o.namespace==='qq.track_info.language').interpretation,'uninterpreted_enum');
 assert.ok(!JSON.stringify(result).includes('confirmed'));
});
test('QQ track enum and category ID are separate namespaces, including category zero',()=>{
 const raw=qqLanguageObservations(123,{track_info:{id:123,language:3},info:{lan:{title:'歌曲语种',content:[{id:5,value:'日语'}]}}},{observedAt});
 const result=resolve(raw,'ja');assert.deepEqual(result.observations.map(o=>o.raw),[{id:5,value:'日语'},3]);
 assert.equal(resolve(qq(['德语']),'de').observations[0].raw.id,0);
 assert.equal(resolve(qq([], {language:999})).decision.status,'unspecific');
 assert.equal(resolve(qq(['日语'],{language:999}),'ja').decision.status,'agreement');
});
for(const [record,primary,candidate] of [[qq(['俄语']),'bg','ru'],[qq(['印尼语']),'zlm','id'],[qq(['韩语']),'hau','ko'],[kg('英语'),'it','en']])
 test(`provider ${candidate} exposes disagreement with body ${primary}`,()=>{const result=resolve(record,primary);assert.equal(result.decision.status,'disagreement');assert.equal(result.decision.candidate,candidate);});
test('a declared language beside und never fills the text estimate',()=>{
 const original=analysis(),copy=structuredClone(original),evidence=bound(qq(['印尼语']));
 const result=resolveProviderLanguageEvidence(lines,original,evidence,source);
 assert.equal(result.decision.status,'declared_only');assert.equal(result.decision.candidate,'id');assert.deepEqual(original,copy);
});
for(const label of ['印度语','其他','小语种','未来语','日语 ',''])test(`broad, unknown and empty label ${JSON.stringify(label)} cannot narrow language`,()=>{
 const result=resolve(kg(label),'hau');assert.equal(result.decision.status,'unspecific');assert.equal(result.decision.candidate,null);
 assert.equal(result.observations[0].raw,label);assert.equal(result.observations[0].language,null);
});
test('multiple specific labels conflict while a broad or unknown companion prevents narrowing',()=>{
 assert.equal(resolve(qq(['日语','韩语']),'ja').decision.status,'declaration_conflict');
 assert.equal(resolve(qq(['日语','日语','']),'ja').decision.status,'agreement');
 for(const label of ['印度语','未来语'])assert.equal(resolve(qq(['日语',label]),'ja').decision.status,'unspecific');
});
test('default lyric track, nested KRC enums and wrong category fields are not extracted as source declarations',()=>{
 const raw=qqLanguageObservations(123,{track_info:{id:123},track:{id:0,language:0},info:{lan:{title:'曲风',content:[{id:5,value:'日语'}]}}},{observedAt});
 assert.equal(resolve(raw).decision.status,'absent');
 const nested=kugouLanguageObservations('123',{id:'123',nested:{language:0}},0,{observedAt});
 assert.equal(resolve(nested).decision.status,'absent');
});
test('missing detail/label is optional, and malformed metadata cannot fail the readable source',()=>{
 assert.equal(resolve(qq([],{language:0})).decision.status,'unspecific');
 for(const raw of [qqLanguageObservations('123',{track_info:{id:999}},{observedAt}),qq(['a'.repeat(257)]),
  qq(Array(8).fill('日语')),kg(['日语']),kg('日语',{id:'999'})])assert.equal(resolve(raw).decision.status,'unusable');
});
test('source IDs, provider namespaces and original/translated/phonetic roles remain independent',()=>{
 const evidence=bound(qq(['日语']));
 for(const expected of [{provider:'qq',id:'124'},{provider:'kugou',id:'123'}]){
  const result=resolveProviderLanguageEvidence(lines,analysis('ja'),evidence,expected);
  assert.equal(result.decision.status,'unusable');assert.deepEqual(result.decision.reasons,['source_binding_mismatch']);
 }
 for(const role of ['translated','phonetic','unknown'])assert.equal(resolve(qq(['日语']),'ja',{role}).decision.status,'unusable');
 const changed=structuredClone(evidence);changed.observations[0].namespace='kugou.search.language';
 assert.equal(resolveProviderLanguageEvidence(lines,analysis('ja'),changed,source).decision.status,'unusable');
});
test('same-source duplicate observations retain conflicts without changing recording identity',()=>{
 const left=kg('英语'),right=kg('日语');const merged=mergeLanguageObservations(left,right);
 assert.equal(resolve(merged).decision.status,'declaration_conflict');
 assert.equal(mergeLanguageObservations(left,left).observations.length,1);
 assert.equal(mergeLanguageObservations(left,qq(['日语'])).unusable,true);
});
test('semantic digest binds source, raw namespaces, body and detector result but not observation time',()=>{
 const raw=qq(['日语']),first=resolve(raw,'ja'),later=structuredClone(raw);
 later.observations.forEach(o=>o.observed_at='2026-10-28T00:00:00.000Z');
 assert.equal(first.semantic_sha256,resolve(later,'ja').semantic_sha256);
 for(const next of [resolve(qq(['韩语']),'ja'),resolve(raw,'und'),
  resolveProviderLanguageEvidence(['Different invented words'],analysis('ja'),bound(raw),source)])assert.notEqual(first.semantic_sha256,next.semantic_sha256);
 assert.match(first.body.text_sha256,/^[a-f0-9]{64}$/u);
});
test('closed observation fields and bounded metadata never expose unrelated provider values',()=>{
 const evidence=bound(qq(['日语']));evidence.observations[0].accesskey='must-not-leak';
 const result=resolveProviderLanguageEvidence(lines,analysis('ja'),evidence,source);
 assert.equal(result.decision.status,'unusable');assert.ok(!JSON.stringify(result).includes('must-not-leak'));
 assert.equal(providerLanguageSource('QQMusicAPI',123).id,'123');assert.equal(providerLanguageSource('qq','001'),null);
});
test('analyzer adds evidence without changing any legacy estimate, mixed passages or pronunciation fields',()=>{
 const body=['夜の窓で架空の物語を話しています。','These are invented words for an independent mixed-language test.'];
 const baseline=analyzeLyricLanguage(body),result=analyzeLyricLanguage(body,{providerEvidence:bound(qq(['日语'])),providerSource:source});
 const {provider_evidence,...legacy}=result;assert.deepEqual(legacy,baseline);assert.equal(provider_evidence.decision.status,'agreement');
 assert.equal(provider_evidence.body.text_sha256,resolveProviderLanguageEvidence(body,baseline,bound(qq(['日语'])),source).body.text_sha256);
 assert.equal(result.mixed,true);
});
