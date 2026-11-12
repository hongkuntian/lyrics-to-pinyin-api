import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingScore,findRecording,searchTitle,stripTitleDescription} from '../../api/utils/recording-match.js';
const request={title:'说好不哭',artist:'Jay Chou & Ashin Chen',album:'说好不哭 - Single',duration:222.333};
test('collaborator separators and ordering represent the same full credit',()=>{
 for(const artist of ['Jay Chou feat. Ashin Chen','Jay Chou, Ashin Chen','Ashin Chen / Jay Chou'])
  assert.ok(recordingScore({...request,title:'說好不哭',artist},request)>=0,artist);
 for(const artist of ['Jay Chou','Ashin Chen','Jay Chou & Cover Singer','Jay Chou & Ashin Chen & Guest'])
  assert.equal(recordingScore({...request,artist},request),-1,artist);
});
test('explicit featured credit can move between title and artist without losing contributors',()=>{
 assert.ok(recordingScore({...request,title:'说好不哭 (with Ashin Chen)',artist:'Jay Chou'},request)>=0);
 assert.equal(recordingScore({...request,title:'说好不哭 (with Cover Singer)',artist:'Jay Chou'},request),-1);
 assert.equal(recordingScore({...request,title:'说好不哭 (Live)'},request),-1);
 assert.equal(recordingScore({...request,title:'说好不哭 (Instrumental)'},request),-1);
 assert.equal(recordingScore({...request,duration:231},request),-1);
});
test('album release suffix helps select the single while version safety and conflicts remain',()=>{
 const single={...request,id:1,title:'說好不哭',artist:'Jay Chou feat. Ashin Chen',album:'說好不哭',duration:222};
 const other={...single,id:2,album:'最偉大的作品'};
 assert.equal(findRecording([other,single],request).id,1);
 assert.throws(()=>findRecording([single,{...single,id:3}],request),/recording/i);
 assert.equal(recordingScore({...single,album:'Live'},request),-1);
});
test('exact album remains stronger than a release-suffix fallback when lyrics conflict',()=>{
 const request={artist:'Artist',title:'Song',album:'Song - Single',duration:185};
 const exact={...request,id:1,lyricsData:{lines:[{text:'one original line',timestamp:null}]}};
 const alternate={...exact,id:2,album:'Song',lyricsData:{lines:[{text:'different lyric',timestamp:0}]}};
 assert.equal(findRecording([alternate,exact],request).id,1);
});
test('soundtrack descriptions are not recording versions',()=>{
 const base={title:'小幸运',artist:'田馥甄',duration:265.5};
 assert.ok(recordingScore({...base,title:'小幸運 (電影《我的少女時代》主題曲)'},base)>=0);
 assert.ok(recordingScore({...base,title:'小幸运 (抖音热歌)'},base)>=0);
 const english={title:'A Little Happiness',artist:'Hebe Tien',duration:265.5};
 assert.ok(recordingScore({...english,title:'A Little Happiness (From "Our Times")'},english)>=0);
 for(const suffix of ['Live','Remastered','Instrumental','Acapella','Cover','主題曲 Live','From Our Times - Remastered']) assert.equal(recordingScore({...english,title:`A Little Happiness (${suffix})`},english),-1);
 assert.equal(recordingScore({...base,title:'小幸運 (電影《我的少女時代》主題曲)',duration:300},base),-1);
});
test('paired soundtrack brackets preserve recording admission in both Chinese scripts and provider paths',()=>{
 const source={id:'239333669',title:'我和我的祖国',artist:'王菲',album:'我和我的祖国',duration:188};
 for(const suffix of ['[电影《我和我的祖国》同名主题曲]','[電影《我和我的祖國》同名主題曲]','［電影《我和我的祖國》同名主題曲］']) {
  const target={...source,title:`我和我的祖国 ${suffix}`,album:`我和我的祖国 ${suffix} - Single`,duration:188.612};
  assert.equal(searchTitle(target.title),source.title);
  for(const request of [target,{...target,recordingProvider:'spotify',creditedArtistNames:['王菲']}]) {
   assert.equal(findRecording([source],request).id,source.id);
   for(const changed of [{artist:'Another Singer'},{artist:'王菲 & Guest'},{duration:195},{title:'我和我的祖国 (Live)'},{title:'我和我的祖国 (伴奏)'},{title:'我和我的祖国 (Remix)'}])
    assert.equal(recordingScore({...source,...changed},request),-1,JSON.stringify(changed));
  }
 }
 for(const suffix of ['[From "Example Film"]','[Theme Song From Example Film]','[Love Theme From Example Film]','[抖音熱歌]'])
  assert.equal(searchTitle(`Song ${suffix}`),'Song');
});
test('soundtrack annotations retain guest and rendition qualifiers rather than weakening recording identity',()=>{
 const source={title:'Song',artist:'Singer',album:'Example',duration:188};
 for(const label of ['Live','Remastered','Instrumental','Karaoke','Acapella','Cover','Remix','Demo','Acoustic','Radio Edit','Version','Mix','feat. Guest','with Guest','合唱','翻唱','現場','伴奏']) {
  for(const [open,close] of [['(',')'],['[',']']]) {
   const title=`Song ${open}From Example Film - ${label}${close}`;
   assert.equal(stripTitleDescription(title),title,label);
   assert.equal(recordingScore({...source,title},source),-1,label);
  }
 }
});
test('unknown, nested and malformed soundtrack annotations remain part of the title',()=>{
 for(const suffix of ['[Unknown Subtitle]','[From Example Film)','(From Example Film]','[[From Example Film]]','([From Example Film])','[From (Example Film)]','[From Example Film','From Example Film]','[From Example\nFilm]']) {
  const title=`Song ${suffix}`;
  assert.equal(stripTitleDescription(title),title,suffix);
 }
});
test('Douyin title descriptions match in both Chinese scripts without weakening recording identity',()=>{
 const song={id:553755659,title:'可不可以',artist:'张紫豪',album:'可不可以',duration:240.889};
 for(const suffix of ['(抖音热歌)','(抖音熱歌)','（抖音熱歌）']) {
  const request={...song,title:`可不可以 ${suffix}`,album:`可不可以 ${suffix} - Single`};
  assert.equal(searchTitle(request.title),'可不可以');
  assert.equal(findRecording([song],request).id,song.id);
  for(const changed of [{artist:'Cover Artist'},{artist:'张紫豪 & Guest'},{duration:245},{title:'可不可以 (Live)'},{title:'可不可以 (伴奏)'},{title:'可不可以 (Remix)'}])
   assert.equal(recordingScore({...song,...changed},request),-1,JSON.stringify(changed));
 }
 for(const suffix of ['抖音熱歌 Live','抖音熱歌 Remix','抖音熱歌 伴奏'])
  assert.equal(recordingScore({...song,title:`可不可以 (${suffix})`},song),-1,suffix);
});


test('repeated featured credits retain each distinct contributor once',()=>{
 assert.ok(recordingScore({title:'Song (feat. Guest)',artist:'Singer & Guest',duration:200},{title:'Song',artist:'Singer & Guest',duration:200})>=0);
 assert.equal(recordingScore({title:'Song (feat. Other)',artist:'Singer & Guest',duration:200},{title:'Song',artist:'Singer & Guest',duration:200}),-1);
});
test('live markers can appear in the song title as well as the album',()=>{
 const request={title:'我要你 (Live)',artist:'毛不易 & 单依纯',album:'剧好听的歌 第8期 (Live) - EP',duration:278.394};
 const song={...request,title:'我要你 (Live版)',album:'剧好听的歌 第8期',duration:278.393};
 assert.ok(recordingScore(song,request)>=0);
 assert.equal(recordingScore({...song,title:'我要你'},request),-1);
 assert.equal(recordingScore({...song,duration:300},request),-1);
});
