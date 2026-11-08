import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReading,renderReading,profiles,profileFor,annotationFor} from '../../api/utils/pronunciation-aids.js';
import {compose} from '../../api/utils/thai-readings.js';

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
test('reviewed Blue Bird readings stay recording- and source-span-bound in both profiles and legacy output',async()=>{
 const recording={title:'ブルーバード',artist:'Ikimonogakari',album:'Chou Ikimonobakari Tennen Kinen Members Best Selection',duration:215.707};
 const {JapaneseProcessor}=await import('../../api/processors/japanese.js');
 for(const [text,kana,romaji] of [['飛翔いたら','はばたいたら','habataitara'],['遊迷','ゆめ','yume'],['共鳴けて','あずけて','azukete']]){
  const reading=await analyzeReading(text,'ja',{recording});
  assert.equal(renderReading(reading,'ja-kana').text,kana);assert.equal(renderReading(reading,'ja-hepburn').text,romaji);
  assert.equal(reading.segments.map(span=>span.source).join(''),text);
  assert.equal((await new JapaneseProcessor().romanize(text,'hepburn',{recording})).romanized,romaji);
  for(const other of [{...recording,artist:'Cover Singer'},{...recording,album:'Live Album'},{...recording,duration:300},{...recording,title:'Other Song'}])
   assert.notEqual(renderReading(await analyzeReading(text,'ja',{recording:other}),'ja-hepburn').text,romaji);
 }
 const doc={id:'a'.repeat(64),sourceHash:'b'.repeat(64),response:{song:{language:'ja',title:{original:recording.title},artist:{original:recording.artist},album:recording.album,duration:recording.duration}},structure:{occurrences:[{sourceID:'L0001',lyricText:'👩🏽‍🎤飛翔いたら'}]}};
 const before=structuredClone(doc),annotation=await annotationFor(doc,'ja-hepburn');
 assert.equal(annotation.lines[0].text,'👩🏽‍🎤habataitara');assert.deepEqual(doc,before);
 assert.equal(renderReading(await analyzeReading('飛翔','ja',{recording}),'ja-hepburn').text,'hishō');
});
test('albumless reviewed Kugou source carries readings without borrowing request labels',async()=>{
 const recording={id:'468823329',source:'KugouAPI',title:'ブルーバード',artist:'Ikimonogakari',duration:215};
 const reading=async value=>renderReading(await analyzeReading('共鳴けて','ja',{recording:value}),'ja-kana').text;
 assert.equal(await reading(recording),'あずけて');
 for(const other of [{...recording,id:'468823330'},{...recording,source:'NeteaseAPI'},{...recording,album:'Live Album'},{...recording,duration:300}])
  assert.notEqual(await reading(other),'あずけて');
});
test('selected-source documents use the reviewed source reading without changing frozen legacy documents',async()=>{
 const {makeSelectedDocument,selectedTextHash,validateSelectedDocument}=await import('../../api/utils/song-library/selected-source.js');
 const candidate={provider:'kugou',itemID:'468823329',title:'ブルーバード',artist:'Ikimonogakari',duration:215,lines:[{text:'共鳴けて'}]};
 const doc=await makeSelectedDocument(candidate,{provider:candidate.provider,itemID:candidate.itemID,query:'ブルーバード',expectedTextHash:selectedTextHash(candidate.lines)});
 validateSelectedDocument(doc);assert.equal(doc.response.lines[0].romanized,'azukete');
 const before=structuredClone(doc),annotation=await annotationFor(doc,'ja-kana');
 assert.equal(annotation.lines[0].text,'あずけて');assert.deepEqual(doc,before);
});
test('Thai readings use Wiktionary Paiboon per segmented word and never guess a missing word',async()=>{
  const profile=profileFor('th-paiboon');
  assert.equal(profile.sourceLanguage,'th');assert.equal(profile.notation,'paiboon');assert.equal(profile.outputScript,'Latn');
  assert.ok(profile.limitations.some(l=>l.includes('Wiktionary')&&l.includes('CC BY-SA')));
  const reading=await analyzeReading('ไม่ใช่ฉันที่เปิดหน้าต่าง','th');
  assert.equal(renderReading(reading,'th-paiboon').text,'mâi-châi chǎn tîi bpə̀ət nâa-dtàang');
  assert.deepEqual(reading.segments.map(s=>[s.lower,s.upper,s.source]),[[0,4,'ไม่ใช่'],[4,6,'ฉัน'],[6,7,'ที่'],[7,10,'เปิด'],[10,16,'หน้าต่าง']]);
  // A segmenter compound absent from the list is read from listed parts.
  assert.equal(compose('กลับมา'),'glàp-maa');assert.equal(compose('ฌฌฌฌ'),null);
  // A listed word the segmenter splits (เพ|ลง) is re-read as one word.
  const repaired=await analyzeReading('ร้องเพลงช้าๆ','th');
  assert.deepEqual(repaired.segments.map(s=>[s.source,s.romanized]),[['ร้อง','rɔ́ɔng'],['เพลง','pleeng'],['ช้าๆ','cháa-cháa']]);
  // ๆ repeats the preceding word, attached or after a space.
  assert.equal(renderReading(await analyzeReading('ช้าๆ','th'),'th-paiboon').text,'cháa-cháa');
  const spaced=await analyzeReading('เด็ก ๆ เล่น','th');
  assert.deepEqual(spaced.segments.map(s=>[s.source,s.status]),[['เด็ก ๆ','resolved'],[' ','verbatim'],['เล่น','resolved']]);
  // Latin and digits stay verbatim; an unknown Thai word stays unresolved, never guessed.
  const mixed=await analyzeReading('รัก love ๒๕๖๙ ฌฌฌฌ','th');
  assert.deepEqual(mixed.segments.filter(s=>s.status!=='verbatim'||/\S/.test(s.source)).map(s=>[s.source,s.status,s.romanized]),
    [['รัก','resolved','rák'],['love','verbatim',null],['๒๕๖๙','verbatim',null],['ฌฌฌฌ','unresolved',null]]);
  await assert.rejects(()=>annotationFor({id:'a'.repeat(64),sourceHash:'b'.repeat(64),response:{song:{language:'ko'}},structure:{occurrences:[]}},'th-paiboon'),/unsupported_pronunciation_direction/);
});
