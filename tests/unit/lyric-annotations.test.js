import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {LYRIC_NORMALIZATION_VERSION,hasEmbeddedLyricCredits,normalizeLyricAnnotations} from '../../api/utils/lyric-annotations.js';
const top={artist:'TOP Debut Boy Group',duration:271.291};
const rows=texts=>texts.map((text,i)=>({text,timestamp:i*4+1}));

const composedCredits=['弦乐 助理：杨波(北京)','1st Violin：陈允、曾诚、王洋','2nd Violin：李博彦、严柯、史丹',
  'C.Bass：邵士玫、张小迪','ISRC：TW-C23-04-007-06','3rd Violins: Ensemble','Principal cello: Musician',
  'Assistant recording engineer: Engineer','弦樂錄音助理：楊波','Guitar technician: Musician',
  'Strings contractor: Ensemble','Recording assistant: Engineer'];
test('composed production roles and split ISRC leave performed text and measured cues intact',()=>{
  const vocal={text:'一起唱',timestamp:20,vocalTiming:{end:22,segments:[
    {text:'一起',start:20,end:21,utf16Start:0,utf16Length:2},
    {text:'唱',start:21,end:22,utf16Start:2,utf16Length:1}]}};
  for(const credit of composedCredits) {
    const data={source:'netease',lines:[{text:credit,timestamp:0},vocal,{text:credit,timestamp:23}]};
    const result=cleanLyrics(data);
    assert.deepEqual(result.lines,[vocal]);
    assert.deepEqual(result.lines[0].vocalTiming,vocal.vocalTiming);
    assert.equal(result.credits.length,1);
    assert.equal(result.credits[0].original,credit);
    assert.deepEqual(cleanLyrics(result),result);
    assert.equal(hasEmbeddedLyricCredits({lines:[{original:credit}]}),true);
  }
});
test('ordinary colon text survives even when surrounded by confirmed credits',()=>{
  const vocals=['我说：别哭','Unknown: 张三、李四','1st Violin sings: stay','弦乐助理在唱：一起唱',
    'Assistant to my heart: you','3rd time: I love you','Guitar hero: sing with me','Strings attached: stay',
    'ISRC：TW-C23-04-007-06 是我的暗号','ISRC: TW-C23-04-007-060','凌晨3:30','https://example.com',
    'Chorus: sing with me','和声：一起唱'];
  for(const text of vocals) {
    const data={lines:rows(['编曲：制作人','混音：工程师',text,'录音室：Studio','作曲：作曲家'])};
    assert.deepEqual(cleanLyrics(data).lines,[data.lines[2]]);
  }
});
test('repairing a previously normalized source remaps provider translations by visible occurrence',()=>{
  const sourceRows=rows(['[Singer]','1st Violin: Ensemble','一起唱','一起唱']);
  const input={source:'netease',lines:sourceRows.slice(1),lyricStructure:{version:LYRIC_NORMALIZATION_VERSION,
    sourceRows,speakers:[],annotations:[],occurrences:sourceRows.slice(1).map((line,i)=>({
      sourceID:`L000${i+1}`,sourceIndex:i+1,sourceText:line.text,lyricText:line.text,sourcePrefix:'',speakerID:null,startsTurn:false}))},
    providerTranslation:{source:'netease',language:'en',kind:'provider',lines:[
      {sourceID:'L0001',sourceText:'1st Violin: Ensemble',text:'Credit translation'},
      {sourceID:'L0002',sourceText:'一起唱',text:'First sung occurrence'},
      {sourceID:'L0003',sourceText:'一起唱',text:'Repeated sung occurrence'}]}};
  const result=normalizeLyricAnnotations(input);
  assert.deepEqual(result.lines,input.lines.slice(1));
  assert.deepEqual(result.providerTranslation.lines,[
    {sourceID:'L0001',sourceText:'一起唱',text:'First sung occurrence'},
    {sourceID:'L0002',sourceText:'一起唱',text:'Repeated sung occurrence'}]);
  assert.deepEqual(normalizeLyricAnnotations(result),result);
  const creditOnly=normalizeLyricAnnotations({lines:[{text:'1st Violin: Ensemble'}],providerTranslation:{
    lines:[{sourceID:'L0001',sourceText:'1st Violin: Ensemble',text:'Credit translation'}]}});
  assert.equal(creditOnly.providerTranslation,undefined);
});

test('corroborated performance credits leave every source array at header, middle and footer',()=>{
  const credits=['男声：单色凌','戏腔：单色凌','和声：曾婕'];
  for(const texts of [[...credits,'一起唱','慢慢听'],['一起唱',...credits,'慢慢听'],['一起唱','慢慢听',...credits],
    ['男聲：單色凌','戲腔：單色凌','和聲：曾婕','一起唱']]) {
    const data={source:'netease',lines:rows(texts)};
    const result=cleanLyrics(data,{artist:'胡66'});
    assert.deepEqual(result.lines,data.lines.filter(l=>!l.text.includes('：')));
    assert.deepEqual(result.lyricStructure.sourceRows,result.lines);
    assert.equal(result.credits.length,3);
    assert.deepEqual(cleanLyrics(result,{artist:'胡66'}),result);
    assert.equal(hasEmbeddedLyricCredits({lines:data.lines.map(l=>({original:l.text}))}),true);
    assert.equal(hasEmbeddedLyricCredits({lines:result.lines.map(l=>({original:l.text}))}),false);
  }
});
test('unconfirmed voice names, sung cues and separated roles remain performed content',()=>{
  for(const texts of [['男声：一起唱','戏腔：一起唱','和声：一起唱'],['男声：单色凌','一起唱','戏腔：单色凌'],
    ['男声：单色凌','女声：曾婕'],['男：一起唱','女：慢慢听'],['戏腔：单色凌'],['和声：曾婕']]) {
    const data={lines:rows(texts)};assert.deepEqual(cleanLyrics(data).lines,data.lines);
    assert.equal(hasEmbeddedLyricCredits({lines:data.lines.map(l=>({original:l.text}))}),false);
  }
  const data={lines:rows(['张极Jeremy：男声：单色凌','张泽禹Zack：戏腔：单色凌'])};
  const first=cleanLyrics(data,top);
  assert.deepEqual(cleanLyrics(first,top),first);
  assert.equal(hasEmbeddedLyricCredits({lines:first.lines.map(l=>({original:l.text})),metadata:{lyric_structure:first.lyricStructure}},top),false);
});
test('server production roles cover the native credit families without admitting partial labels',()=>{
  const credits=['出品监制：Example','发行合作：Example','鼓录音室：Example','和声编写：Example','和声：郑楠(SBMS)',
    '管弦乐编写：Example','管弦乐团：Example','制作统筹：Example','后期制作：Example','母带后期处理：Example',
    '混音&母带处理工作室：Example','词/曲OP：Example','词/曲SP：Example','母带管理：Example','艺人经纪：Example',
    '出品方：Example','第二小提琴：Example','音乐统筹：Example','PGM：Example','OP：Example','SP：Example',
    '编曲 MUSIC ARRANGEMENT：Example','和声 BACKGROUND VOCALS：Example','笛 DIZI：Example'];
  const data={source:'netease',lines:rows(['一起唱',...credits,'慢慢听','出品监制着梦：一起唱','PGM is my name: hello'])};
  const result=cleanLyrics(data);
  assert.equal(result.credits.length,credits.length);
  assert.deepEqual(result.lines,[data.lines[0],...data.lines.slice(credits.length+1)]);
  assert.deepEqual(result.lyricStructure.sourceRows,result.lines);
  assert.deepEqual(cleanLyrics(result),result);
  assert.deepEqual(cleanLyrics({lines:rows(['和声：一起唱(SBMS)','和声：郑楠(SBMS)'])}).lines,rows(['和声：一起唱(SBMS)','和声：郑楠(SBMS)']));
});

test('exact recording headings and rights notices leave performed speech and timing intact',()=>{
  const data={source:'netease',lines:rows(['一起唱 (Live) - 练习歌手','本作品声明，著作权归权利人所有，权利保留','我说：一起唱','一起唱'])};
  const result=cleanLyrics(data,{title:'一起唱 (Live)',artist:'练习歌手'});
  assert.deepEqual(result.lines,data.lines.slice(2));assert.deepEqual(result.lyricStructure.sourceRows,data.lines.slice(2));
  assert.deepEqual(result.credits.map(c=>c.role),['Recording']);
  assert.deepEqual(cleanLyrics(result,{title:'一起唱 (Live)',artist:'练习歌手'}),result);
});

test('TOP source formatting removes all 18 credits and 12 cues while retaining 37 ordered vocals',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../fixtures/lyric-annotations-top.json',import.meta.url)));
  const result=cleanLyrics({lines:fixture.lines},{artist:fixture.artist,duration:fixture.duration});
  assert.deepEqual(result.lines,fixture.expectedVocalSourceIndices.map(i=>fixture.lines[i]));
  assert.equal(result.lines.length,37);
  assert.equal(result.credits.length,18);
  assert.equal(result.lyricStructure.annotations.filter(a=>a.kind==='performer_cue').length,12);
  assert.ok(!result.lyricStructure.sourceRows.some(r=>result.credits.some(c=>c.original===r.text)));
});

test('bilingual role grammar consumes the complete label without changing sung text',()=>{
  const data={lines:rows(['編曲 Arrangement：Example','Recording Engineer（录音师）：Example',
    '混音/母带处理工作室Mixing/Mastering Studio：Example','人声编辑Vocal Editing：Example',
    '统筹：Example','出品人：Example','编曲Anything：保留','我说：别走','凌晨3:30','(oh yeah)'])};
  const result=cleanLyrics(data);
  assert.deepEqual(result.lines,data.lines.slice(6));
  assert.equal(result.credits.length,6);
  assert.deepEqual(result.lyricStructure.sourceRows,data.lines.slice(6));
});
test('standalone member and combined labels become hidden turns without moving vocal timestamps',()=>{
  const data={lines:rows(['编曲Arrangement：Example','合：','第一句测试歌词','张极Jeremy：',
    '第二句测试歌词','[张泽禹Zack/左航LEFT]','第三句测试歌词','合：','第一句测试歌词'])};
  const result=cleanLyrics(data,top),s=result.lyricStructure;
  assert.deepEqual(result.lines,[data.lines[2],data.lines[4],data.lines[6],data.lines[8]]);
  assert.deepEqual(s.occurrences.map(o=>o.sourceIndex),[1,3,5,7]);
  assert.deepEqual(s.occurrences.map(o=>o.startsTurn),[true,true,true,true]);
  assert.deepEqual(s.speakers.map(x=>x.displayName),['All','张极','张泽禹 / 左航']);
  assert.equal(s.version,LYRIC_NORMALIZATION_VERSION);
  assert.deepEqual(cleanLyrics(result,top),result);
});
test('inline prefixes preserve the words and source mapping across subsequent cleanup',()=>{
  const data={lines:[{text:'  張極Jeremy：  我说：别走  ',timestamp:9},{text:'朱志鑫22X：张极Jeremy：这是引用',timestamp:20},
    {text:'【张泽禹Zack】：我说：别走',timestamp:23}]};
  const result=cleanLyrics(data,top);
  assert.deepEqual(result.lines.map(l=>l.text),['我说：别走','张极Jeremy：这是引用','我说：别走']);
  for(const o of result.lyricStructure.occurrences) assert.equal(o.sourceText.slice(o.sourcePrefix.length).trim(),o.lyricText);
  assert.deepEqual(cleanLyrics(result,top),result);
});
test('unknown and partial identities, colon punctuation and ordinary brackets survive',()=>{
  const data={lines:rows(['我说：','别走','合：一起唱','[oh yeah]','张极Jeremy/陌生人：保留','未知：保留','Chorus: love / hope'])};
  assert.deepEqual(cleanLyrics(data,top).lines,data.lines);
  const other={lines:rows(['张极Jeremy：','合：','实际歌词'])};
  assert.deepEqual(cleanLyrics(other,{artist:'Another band'}).lines,other.lines);
});
test('a generic cue needs a confirmed performer context and does not consume sung chorus words',()=>{
  const data={lines:rows(['张极Jeremy：第一句','Chorus: sing this line with me','合：重复的歌词'])};
  assert.deepEqual(cleanLyrics(data,top).lines.map(l=>l.text),['第一句','sing this line with me','重复的歌词']);
});
test('provider identities and reviewed artist aliases work without inferring arbitrary names',()=>{
  const data={lines:rows(['甲：一起唱','乙：再唱一遍'])};
  const result=cleanLyrics(data,{performers:[{name:'A',aliases:['甲']},{name:'B',aliases:['乙']}]});
  assert.deepEqual(result.lines.map(l=>l.text),['一起唱','再唱一遍']);
  const legacy=cleanLyrics({lines:rows(['卢：一起唱','王：再唱一遍'])},{catalogID:'342794615'});
  assert.deepEqual(legacy.lyricStructure.speakers.map(s=>s.displayName),['Lo','Wang']);
});
test('an initial context-free pass retains source rows for a later verified artist and retiming',()=>{
  const data={lines:rows(['作词：Example','张极Jeremy：','实际歌词','实际歌词'])};
  const first=cleanLyrics(data);
  const result=cleanLyrics({...first,lines:first.lines.map(l=>({...l,timestamp:l.timestamp+2}))},top);
  assert.deepEqual(result.lines,[{...data.lines[2],timestamp:11},{...data.lines[3],timestamp:15}]);
  assert.deepEqual(result.lyricStructure.sourceRows,data.lines.slice(1));
  assert.deepEqual(result.lyricStructure.occurrences.map(o=>o.sourceIndex),[1,2]);
});

test('a stripped vocal body cannot become a credit or instrumental marker on another pass',()=>{
  const data={source:'netease',lines:rows(['张极Jeremy：Producer: keep singing','张泽禹Zack：编曲：这也是歌词','左航LEFT：Instrumental'])};
  const first=cleanLyrics(data,top),second=cleanLyrics(first,top);
  assert.deepEqual(first.lines.map(l=>l.text),['Producer: keep singing','编曲：这也是歌词','Instrumental']);
  assert.deepEqual(second,first);assert.equal(second.instrumental,false);
});
test('a later verified roster can resolve a previously unknown cue inside an active turn',()=>{
  const data={lines:rows(['张极：第一句','张泽禹Zack：第二句'])};
  const first=cleanLyrics(data,{artist:'张极'}),second=cleanLyrics(first,top);
  assert.deepEqual(second.lines.map(l=>l.text),['第一句','第二句']);
  assert.deepEqual(second.lyricStructure.occurrences.map(o=>o.speakerID),['S1','S2']);
  assert.deepEqual(cleanLyrics(second,top),second);
});

test('instrument and team credits are separate from every source array; performed speech survives',()=>{
  const credits=['原唱：歌手','Program：Example','键盘：张三','打击乐：李四','和声：张三 李四','长笛：王五',
    '萨克斯：赵六','小号：张三','长号：李四','二胡：王五','戏腔念白：歌手','制作团队：工作室','出品团队：工作室'];
  const data={source:'netease',lines:rows([...credits,'我说：谢谢大家','一起唱'])};
  const result=cleanLyrics(data);
  assert.equal(result.credits.length,credits.length);
  assert.deepEqual(result.lines,data.lines.slice(credits.length));
  assert.deepEqual(result.lyricStructure.sourceRows,data.lines.slice(credits.length));
  assert.ok(result.credits.every(c=>c.role && c.contributors.length && c.source==='netease'));
  assert.deepEqual(cleanLyrics(result),result);
});
test('repeated caret translations retain alignment and provenance outside source text',()=>{
  const result=cleanLyrics({source:'lrclib',lines:rows(['作词：测试','春天来了^Spring arrives','一起唱歌^Sing together','等待明天^Await tomorrow','天空很蓝^The sky is blue'])});
  assert.deepEqual(result.lines.map(l=>l.text),['春天来了','一起唱歌','等待明天','天空很蓝']);
  assert.deepEqual(result.providerTranslation.lines.map(l=>l.sourceID),['L0001','L0002','L0003','L0004']);
  assert.equal(result.providerTranslation.lines[0].original,'春天来了^Spring arrives');
  assert.ok(!JSON.stringify(result.lyricStructure).includes('Spring'));
  assert.deepEqual(cleanLyrics(result),result);
  for(const source of [['我爱你^I love you'],['春天^Spring','一起^一起','明天^Tomorrow'],['一起 sing^Sing','明天^Tomorrow','春天^Spring']]) {
    const data={lines:rows(source)};assert.deepEqual(cleanLyrics(data).lines,data.lines);
  }
});

test('note-only provider placeholders leave vocal text, timing and source mapping intact',()=>{
  const data={source:'lrclib',lines:rows(['♪','Opening phrase','♫ ♬','Sing ♪ with me','♩\uFE0F','Second phrase','🎵 🎶'])};
  const result=cleanLyrics(data);
  assert.deepEqual(result.lines,[data.lines[1],data.lines[3],data.lines[5]]);
  assert.deepEqual(result.lyricStructure.sourceRows,result.lines);
  assert.deepEqual(result.lyricStructure.occurrences.map(o=>o.sourceIndex),[0,1,2]);
  assert.deepEqual(result.lyricStructure.occurrences.map(o=>o.sourceID),['L0001','L0002','L0003']);
  assert.equal(result.instrumental,false);
  assert.deepEqual(cleanLyrics(result),result);
  assert.equal(cleanLyrics({source:'lrclib',lines:rows(['♪','♫'])}).instrumental,false);
});


test('composed ownership and release roles remove credits without treating colon lyrics as metadata',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../fixtures/production-credit-grammar.json',import.meta.url)));
  for(const credit of fixture.credits) {
    const vocal={text:'一起唱',timestamp:20,vocalTiming:{end:22,segments:[
      {text:'一起唱',start:20,end:22,utf16Start:0,utf16Length:3}]}};
    const data={source:'netease',lines:[{text:credit,timestamp:0},vocal,{text:credit,timestamp:24}]};
    const result=cleanLyrics(data,{artist:'Eason Chan'});
    assert.deepEqual(result.lines,[vocal],credit);
    assert.deepEqual(result.lyricStructure.sourceRows,[{text:vocal.text,timestamp:20}]);
    assert.equal(result.credits[0]?.original,credit);
    assert.equal(result.credits.length,1);
    assert.deepEqual(cleanLyrics(result,{artist:'Eason Chan'}),result);
    assert.equal(hasEmbeddedLyricCredits({lines:[{original:credit}]}),true);
  }
  for(const text of fixture.preserved) {
    const data={lines:rows([...fixture.screenshotCredits,text,...fixture.screenshotCredits])};
    assert.deepEqual(cleanLyrics(data).lines,[data.lines[fixture.screenshotCredits.length]],text);
  }
  // A production-looking phrase can be performed after a verified singer cue.
  const data={lines:rows(['Eason Chan：词版权管理方：一起唱','Eason Chan：联合出品：慢慢听'])};
  const result=cleanLyrics(data,{artist:'Eason Chan'});
  assert.deepEqual(result.lines.map(l=>l.text),['词版权管理方：一起唱','联合出品：慢慢听']);
  assert.deepEqual(cleanLyrics(result,{artist:'Eason Chan'}),result);
  assert.equal(hasEmbeddedLyricCredits({lines:result.lines.map(l=>({original:l.text})),metadata:{lyric_structure:result.lyricStructure}}),false);
});


test('combined engineering and artwork roles corroborate a backing-vocal roster without consuming sung cues',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../fixtures/production-credit-grammar.json',import.meta.url)));
  for(const credits of fixture.creditBlocks) {
    for(const texts of [[...credits,'一起唱','慢慢听'],['一起唱',...credits,'慢慢听'],['一起唱','慢慢听',...credits]]) {
      const data={source:'netease',lines:rows(texts)};const result=cleanLyrics(data);
      assert.deepEqual(result.lines,data.lines.filter(l=>['一起唱','慢慢听'].includes(l.text)));
      assert.deepEqual(result.credits.map(c=>c.original),credits);
      assert.deepEqual(cleanLyrics(result),result);
      assert.equal(hasEmbeddedLyricCredits({lines:data.lines.map(l=>({original:l.text}))}),true);
    }
    const sung={lines:rows(['和声：一起唱',...credits.slice(1),'我说：慢慢听'])};
    assert.deepEqual(cleanLyrics(sung).lines,[sung.lines[0],sung.lines.at(-1)]);
  }
});
