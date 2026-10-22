import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyLyricNotice} from '../../api/utils/lyric-notices.js';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {hasEmbeddedLyricCredits,validLyricStructure} from '../../api/utils/lyric-annotations.js';
const corpus=JSON.parse(readFileSync(new URL('../fixtures/lyric-notice-grammar.json',import.meta.url)));
const rows=texts=>texts.map((text,i)=>({text,timestamp:i*4+1}));
const response=data=>({lines:data.lines.map(l=>({original:l.text})),metadata:{lyric_structure:data.lyricStructure}});

test('shared complete-row notice corpus distinguishes observed evidence from synthetic adversaries',()=>{
  assert.equal(corpus.observed.length,3);
  for(const item of corpus.observed){assert.ok(item.provenance);assert.ok(classifyLyricNotice(item.text),item.text);}
  for(const text of corpus.hidden)assert.ok(classifyLyricNotice(text),text);
  for(const text of corpus.preserved)assert.equal(classifyLyricNotice(text),null,text);
  for(const text of corpus.preserved){
    const data={source:'netease',lines:rows([text])};
    const result=cleanLyrics(data);
    assert.deepEqual(result.lines,data.lines,text);
    assert.deepEqual(cleanLyrics(result),result,text);
    assert.equal(hasEmbeddedLyricCredits(response(data)),false,text);
  }
});
test('notices disappear from vocals and canonical rows anywhere, without becoming contributor credits',()=>{
  const vocal={text:'一起唱',timestamp:20,vocalTiming:{end:22,segments:[
    {text:'一起',start:20,end:21,utf16Start:0,utf16Length:2},{text:'唱',start:21,end:22,utf16Start:2,utf16Length:1}]}};
  for(const text of corpus.hidden)for(const index of [0,1,2]){
    const input=[vocal,{text:'一起唱',timestamp:24}];input.splice(index,0,{text,timestamp:25});
    const data={source:'netease',lines:input},result=cleanLyrics(data);
    assert.deepEqual(result.lines,[vocal,{text:'一起唱',timestamp:24}],text);
    assert.deepEqual(result.lines[0].vocalTiming,vocal.vocalTiming);
    assert.deepEqual(result.lyricStructure.sourceRows,result.lines.map(({text,timestamp})=>({text,timestamp})));
    assert.deepEqual(result.credits,[]);assert.deepEqual(cleanLyrics(result),result);
    assert.equal(hasEmbeddedLyricCredits(response(data)),true);
    assert.equal(hasEmbeddedLyricCredits(response(result)),false);
    assert.equal(validLyricStructure(result.lyricStructure,response(result).lines),true);
  }
});
test('notice-only sources remain missing text rather than becoming instrumentals',()=>{
  const result=cleanLyrics({source:'netease',lines:rows(corpus.hidden)});
  assert.deepEqual(result.lines,[]);assert.deepEqual(result.lyricStructure.sourceRows,[]);
  assert.equal(result.instrumental,false);assert.deepEqual(result.credits,[]);
});
test('notice extraction remaps provider translation through repeated visible occurrences',()=>{
  const lines=rows(['一起唱',corpus.hidden[0],'一起唱',corpus.hidden[1],'慢慢听']);
  const data={source:'netease',lines,providerTranslation:{source:'netease',language:'en',kind:'provider',
    lines:lines.map((l,i)=>({sourceID:`L000${i+1}`,sourceText:l.text,text:`translation ${i}`}))}};
  const result=cleanLyrics(data);
  assert.deepEqual(result.lines,[lines[0],lines[2],lines[4]]);
  assert.deepEqual(result.providerTranslation.lines.map(l=>[l.sourceID,l.text]),[
    ['L0001','translation 0'],['L0002','translation 2'],['L0003','translation 4']]);
  assert.deepEqual(cleanLyrics(result),result);
});
test('a verified raw performer cue wins before notice and production-role classification',()=>{
  for(const body of [...corpus.hidden,'Producer: keep singing','[oh yeah]']){
    const data={source:'netease',lines:rows([`Singer：${body}`,'普通句'])};
    const result=cleanLyrics(data,{artist:'Singer'});
    assert.equal(result.lines[0].text,body.trim());
    assert.equal(validLyricStructure(result.lyricStructure,response(result).lines),true);
    assert.deepEqual(cleanLyrics(result,{artist:'Singer'}),result);
    assert.equal(hasEmbeddedLyricCredits(response(result)),false);
    assert.equal(hasEmbeddedLyricCredits({...response(data),song:{artist:{original:'Singer'}}}),false);
  }
});
test('canonical prefix exemptions require the whole exact mapping, not unchecked or inherited speaker fields',()=>{
  const body='银河计划X星斗推';
  const result=cleanLyrics({source:'netease',lines:rows([`Singer：${body}`])},{artist:'Singer'});
  assert.equal(hasEmbeddedLyricCredits(response(result)),false);
  for(const mutate of [s=>s.sourceRows[0].text='changed',s=>s.occurrences[0].sourceIndex=9,
    s=>s.occurrences[0].sourcePrefix='fake',s=>s.annotations=[],s=>s.speakers=[]]){
    const forged=structuredClone(result);mutate(forged.lyricStructure);
    assert.equal(validLyricStructure(forged.lyricStructure,response(forged).lines),false);
    assert.equal(hasEmbeddedLyricCredits(response(forged)),true);
  }
  const inherited=cleanLyrics({source:'netease',lines:rows(['Singer：普通句',body])},{artist:'Singer'});
  assert.deepEqual(inherited.lines.map(l=>l.text),['普通句']);
  const forged={lines:[{original:body}],metadata:{lyric_structure:{occurrences:[{lyricText:body,sourcePrefix:'Singer：',speakerID:'S1'}]}}};
  assert.equal(hasEmbeddedLyricCredits(forged),true);
});

test('a notice hidden only in canonical rows is repaired before hashing/model input',()=>{
  const input=cleanLyrics({source:'netease',lines:rows(['Singer：普通句'])},{artist:'Singer'});
  input.lyricStructure.sourceRows.unshift({text:'银河计划X星斗推',timestamp:0});
  input.lyricStructure.occurrences.forEach(o=>o.sourceIndex++);
  input.lyricStructure.annotations.forEach(a=>a.sourceIndex++);
  assert.equal(hasEmbeddedLyricCredits(response(input)),true);
  const repaired=cleanLyrics(input,{artist:'Singer'});
  assert.deepEqual(repaired.lines,input.lines);
  assert.deepEqual(repaired.lyricStructure.sourceRows,[{text:'Singer：普通句',timestamp:1}]);
  assert.equal(hasEmbeddedLyricCredits(response(repaired)),false);
  assert.deepEqual(cleanLyrics(repaired,{artist:'Singer'}),repaired);
});
test('recognized wrapped instrumental markers stay non-vocal while section words and sung bodies survive',async()=>{
  const {parseLRC}=await import('../../api/utils/lrc.js');
  const markers=['music','instrumental','interlude','intro','outro','间奏','前奏','尾奏','伴奏','纯音乐'];
  for(const word of markers)for(const [open,close] of [['(',')'],['[',']'],['【','】']]){
    const marker=open+word+close;
    const data={source:'netease',lines:parseLRC(`[00:01]${marker}\n[00:03]普通句`)};
    assert.equal(data.lines[0].text,marker);
    const result=cleanLyrics(data);
    assert.deepEqual(result.lines,[data.lines[1]]);assert.equal(result.instrumental,false);
    assert.deepEqual(result.lyricStructure.sourceRows,[data.lines[1]]);
    const sung=cleanLyrics({lines:rows([`Singer：${marker}`])},{artist:'Singer'});
    assert.deepEqual(sung.lines.map(l=>l.text),[marker]);assert.deepEqual(cleanLyrics(sung,{artist:'Singer'}),sung);
  }
  const words=rows(['[Verse 1]','[Chorus]','(oh yeah)','【一起唱】']);
  assert.deepEqual(cleanLyrics({lines:words}).lines,words);
  assert.equal(cleanLyrics({source:'netease',lines:rows(['[Intro]'])}).instrumental,false);
});

test('a fabricated standalone notice cue cannot borrow an unrelated real performer identity',async()=>{
  const {makeSelectedDocument,selectedTextHash,validateSelectedDocument}=await import('../../api/utils/song-library/selected-source.js');
  const {spotifyHash}=await import('../../api/utils/song-library/spotify-recording.js');
  const input=cleanLyrics({source:'netease',lines:rows(['Singer：普通句'])},{artist:'Singer'});
  const legitimate=structuredClone(input);
  const notice='【未经著作权人许可不得使用】';
  input.lyricStructure.sourceRows.unshift({text:notice,timestamp:0});
  input.lyricStructure.occurrences.forEach(o=>o.sourceIndex++);
  input.lyricStructure.annotations.forEach(a=>a.sourceIndex++);
  input.lyricStructure.annotations.unshift({sourceIndex:0,kind:'performer_cue',speakerID:'S1',sourceLabel:'未经著作权人许可不得使用'});
  assert.equal(validLyricStructure(input.lyricStructure,response(input).lines),false);
  assert.equal(hasEmbeddedLyricCredits(response(input)),true);
  const repaired=cleanLyrics(input,{artist:'Singer'});
  assert.ok(!repaired.lyricStructure.sourceRows.some(row=>row.text===notice));
  assert.deepEqual(repaired.lines,input.lines);assert.deepEqual(cleanLyrics(repaired,{artist:'Singer'}),repaired);
  const candidate={provider:'netease',itemID:'123',title:'Provider song',artist:'Singer',lines:input.lines,lyricStructure:input.lyricStructure};
  await assert.rejects(makeSelectedDocument(candidate,{provider:'netease',itemID:'123',expectedTextHash:selectedTextHash(candidate.lines)}),/invalid_source_structure/);
  const doc=await makeSelectedDocument({...candidate,lyricStructure:legitimate.lyricStructure},
    {provider:'netease',itemID:'123',expectedTextHash:selectedTextHash(candidate.lines)},
    {analyzeLanguageFn:()=>({primary:'en',pronunciation_language:null})});
  doc.selectedSourceCapsule.lyricStructure=structuredClone(input.lyricStructure);
  doc.response.metadata.lyric_structure=doc.selectedSourceCapsule.lyricStructure;
  // Rebind the capsule hashes deliberately: rejection must come from the cue
  // proof itself, rather than just an ordinary altered-hash mismatch.
  doc.sourceHash=spotifyHash(['selected-provider-source-1',doc.selectedSourceCapsule]);
  doc.id=spotifyHash(['selected-lyrics-document-1',doc.sourceHash,doc.selectionRevision]);
  assert.throws(()=>validateSelectedDocument(doc),/source_context_unavailable/);
});
test('valid standalone generic cues and combined performer aliases retain exact idempotent proof',()=>{
  const options={artist:'TOP Debut Boy Group'};
  const data={lines:rows(['张极Jeremy：普通句','[合]','一起唱','[Chorus]','继续唱',
    '[张泽禹Zack/左航LEFT]','组合句','[张泽禹/左航]','另一句'])};
  const normalized=cleanLyrics(data,options);
  assert.equal(validLyricStructure(normalized.lyricStructure,response(normalized).lines),true);
  assert.deepEqual(normalized.lyricStructure.speakers.map(s=>s.displayName),['张极','All','张泽禹 / 左航']);
  assert.deepEqual(cleanLyrics(normalized,options),normalized);
  assert.equal(hasEmbeddedLyricCredits(response(normalized)),false);
  // Caller-supplied aliases without retained/roster corroboration get their
  // own compact speaker label, rather than an unprovable merged exemption.
  const custom={performers:[{name:'A',aliases:['甲','甲甲']},{name:'B',aliases:['乙','乙乙']}]};
  const aliases=cleanLyrics({lines:rows(['甲/乙：普通句','[甲甲/乙乙]','继续唱','[A/B]','另一句'])},custom);
  assert.equal(validLyricStructure(aliases.lyricStructure,response(aliases).lines),true);
  assert.deepEqual(cleanLyrics(aliases,custom),aliases);
});
