import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReading,renderReading,profiles,profileFor,annotationFor} from '../../api/utils/pronunciation-aids.js';

test('profiles explicitly separate source, script, notation and intended reader',()=>{
  assert.equal(profileFor('ja-hepburn').kind,'romanization');
  assert.equal(profileFor('ja-kana').kind,'native-reading');
  assert.equal(profileFor('ko-revised').outputScript,'Latn');
  assert.ok(profiles.every(p=>p.readerLanguage===null));
  assert.throws(()=>profileFor('yue-mandarin-hints'),/unsupported_pronunciation_profile/);
});
test('Japanese readings handle words, particles, gemination and kana without Chinese conversion',async()=>{
  for(const [source,expected] of [['君が好き','kimi ga suki'],['私は歌う','watashi wa utau'],['学校へ行く','gakkō e iku'],['がっこう','gakkō'],['ありがとう','arigatō']]) {
    assert.equal(renderReading(await analyzeReading(source,'ja'),'ja-hepburn').text,expected,source);
  }
});
test('Korean covers complete syllables, liaison and assimilation',async()=>{
  for(const [source,expected] of [['사랑해','saranghae'],['안녕하세요','annyeonghaseyo'],['국물','gungmul'],['한국어','hangugeo'],['같이','gachi'],['신라','silla'],['꽃잎','kkonnip'],['좋아','joa']])
    assert.equal(renderReading(await analyzeReading(source,'ko'),'ko-revised').text,expected,source);
});
test('Japanese inflection retains kana spelling and contextual long vowels',async()=>{
  for(const [source,expected] of [['一緒に歌おう','issho ni utaō'],['この道を歩こう','kono michi o arukō'],['会おう','aō'],['思う','omou'],['夢を見ている','yume o mite iru'],['風が吹いている','kaze ga fuite iru']])
    assert.equal(renderReading(await analyzeReading(source,'ja'),'ja-hepburn').text,expected,source);
  assert.equal(renderReading(await analyzeReading('歌おう','ja'),'ja-kana').text,'うたおう');
});
test('all segments preserve original graphemes including emoji and decomposed Hangul',async()=>{
  for(const [language,text] of [['ja','👩🏽‍🎤君が好き yeah!'],['ko','👩🏽‍🎤 '+ '사랑해'.normalize('NFD')+' yeah!']]){
    const reading=await analyzeReading(text,language),parts=Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text),x=>x.segment);
    assert.equal(reading.segments.map(s=>s.source).join(''),text);
    for(const s of reading.segments)assert.equal(parts.slice(s.lower,s.upper).join(''),s.source);
    const rendered=renderReading(reading,language==='ja'?'ja-hepburn':'ko-revised');
    assert.ok(rendered.text.startsWith('👩🏽‍🎤'));assert.ok(rendered.text.endsWith('yeah!'));
  }
});
test('unknown Japanese readings are explicit and profiles cannot cross source languages',async()=>{
  const reading=await analyzeReading('𠮷𠮷','ja');
  assert.ok(reading.segments.some(s=>s.status==='unresolved'));
  assert.throws(()=>renderReading(reading,'ko-revised'),/unsupported_pronunciation_direction/);
});
test('aid revisions are separate from immutable source documents and from other profiles',async()=>{
  const doc={id:'a'.repeat(64),sourceHash:'b'.repeat(64),response:{song:{language:'ja'}},structure:{occurrences:[{sourceID:'L0001',lyricText:'君が好き'}]}};
  const before=JSON.stringify(doc),a=await annotationFor(doc,'ja-hepburn'),b=await annotationFor(doc,'ja-kana');
  assert.equal(JSON.stringify(doc),before);assert.notEqual(a.id,b.id);assert.equal(a.readingRevision,b.readingRevision);
  assert.equal(a.documentID,doc.id);assert.equal(a.sourceHash,doc.sourceHash);
  assert.equal(b.lines[0].text,'きみがすき');
});
test('legacy casing and vowel options compose without restoring placeholder caches',async()=>{
  const {JapaneseProcessor}=await import('../../api/processors/japanese.js');
  const {getCacheKey}=await import('../../api/utils/cache.js');
  const {createHash}=await import('node:crypto');
  assert.equal((await new JapaneseProcessor().romanize('学校','hepburn',{case:'upper',long_vowels:'double'})).romanized,'GAKKOO');
  for(const [language,text,system] of [['ja','学校','hepburn'],['ko','사랑해','revised']]){
    const old='romanize:'+createHash('sha256').update(JSON.stringify({text,language,system,options:'{}'})).digest('hex');
    assert.notEqual(getCacheKey(text,language,system),old);
  }
});
