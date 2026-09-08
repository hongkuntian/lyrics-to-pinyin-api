import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lookupOfficialTranscription} from '../../api/utils/official-transcriptions.js';
const words='窗前来了一只猫，今天我们一起看云。';
const signature={catalog_id:'12345',title:'看云',artist:'Little Cloud',album:'清晨',duration:120.24};
const entry={id:'reviewed-example',reviewedDate:'2026-09-08',signature,catalogAnchor:{storefront:'us',signature},source:{videoID:'abcdefghijk',channelID:'UCabcdefghijk',title:'小云 Little Cloud I 看云 I OFFICIAL MUSIC VIDEO',duration:121,paragraphSHA256:createHash('sha256').update(words).digest('hex')},provenance:[{url:'https://www.youtube.com/watch?v=abcdefghijk',note:'Reviewed official source'}]};
const makeVideo=()=>({videoDetails:{videoId:entry.source.videoID,channelId:entry.source.channelID,title:entry.source.title,lengthSeconds:'121',shortDescription:'Album links\n\n'+words+'\n\nFollow our channel'},playabilityStatus:{status:'OK'}});
const makeApple=()=>({results:[{kind:'song',trackId:12345,trackName:signature.title,artistName:signature.artist,collectionName:signature.album,trackTimeMillis:120240}]});
function context({apple=makeApple(),video=makeVideo(),html,redirect=false}={}) {
  const calls=[];return {registry:{recordings:[entry]},calls,fetchFn:async(url,init)=>{
    calls.push({url,init});return {ok:true,status:200,url:redirect?'https://consent.youtube.com/':url,headers:{get:()=>null},text:async()=>url.startsWith('https://itunes.apple.com/')?JSON.stringify(apple):html ?? '<html><script>var ytInitialPlayerResponse = '+JSON.stringify(video)+';</script></html>'};
  }};
}
test('returns only reviewed plain words and partial marker after both live identity checks',async()=>{
  const ctx=context();const result=await lookupOfficialTranscription(signature,ctx);assert.ok(result);assert.equal(result.song.source,'official_description');assert.equal(result.song.id,'abcdefghijk');assert.equal(result.song.artist,'Little Cloud');assert.equal(result.song.album,'清晨');assert.equal(result.lyrics.partial,true);assert.equal(result.lyrics.instrumental,false);assert.deepEqual(result.lyrics.lines,[{text:'窗前来了一只猫',timestamp:null},{text:'今天我们一起看云',timestamp:null}]);assert.equal(ctx.calls.length,2);assert.ok(ctx.calls.every(x=>x.init.redirect==='error' && x.init.size===5*1024*1024 && x.init.signal));assert.equal(ctx.calls[0].init.signal,ctx.calls[1].init.signal);
});
test('unregistered IDs, version, singer, album, duration and guest mutations make no requests',async()=>{
  for(const change of [{catalog_id:'12346'},{title:'看云 (Live)'},{artist:'Someone Else'},{artist:'Little Cloud & Guest'},{album:'别的专辑'},{duration:121.24}]){const ctx=context();assert.equal(await lookupOfficialTranscription({...signature,...change},ctx),null);assert.equal(ctx.calls.length,0);}
});
test('live Apple ID, names, release and duration must remain bound to reviewed source',async()=>{
  for(const change of [{trackId:999},{trackName:'看云 (Remix)'},{artistName:'Other Artist'},{collectionName:'Concert'},{trackTimeMillis:150000},{kind:'album'}]){const apple=makeApple();Object.assign(apple.results[0],change);const ctx=context({apple});assert.equal(await lookupOfficialTranscription(signature,ctx),null);assert.equal(ctx.calls.length,1);}
});
test('live source video ID, channel, title and duration must match exactly',async()=>{
  for(const change of [{videoId:'other-video'},{channelId:'other-channel'},{title:'看云 Cover'},{lengthSeconds:'123'}]){const video=makeVideo();Object.assign(video.videoDetails,change);assert.equal(await lookupOfficialTranscription(signature,context({video})),null);}
});
test('changed, missing or duplicate reviewed words are rejected instead of guessing extraction',async()=>{
  for(const shortDescription of ['替代歌词','Credits only',words+'\n'+words]){const video=makeVideo();video.videoDetails.shortDescription=shortDescription;assert.equal(await lookupOfficialTranscription(signature,context({video})),null);}
});
test('safe JSON scanner handles quoted braces and does not evaluate JS expressions',async()=>{
  const video=makeVideo();video.videoDetails.shortDescription='literal } brace and \\" quote\n'+words;
  assert.ok(await lookupOfficialTranscription(signature,context({video})));
  for(const html of ['<script>var ytInitialPlayerResponse = {videoDetails:evil()};</script>','<script>var ytInitialPlayerResponse = JSON.parse("bad");</script>','<html>Consent required</html>'])assert.equal(await lookupOfficialTranscription(signature,context({html})),null);
});
test('rejects redirects, non-OK playability, transport failures and oversized bodies',async()=>{
  assert.equal(await lookupOfficialTranscription(signature,context({redirect:true})),null);
  const video=makeVideo();video.playabilityStatus.status='LOGIN_REQUIRED';assert.equal(await lookupOfficialTranscription(signature,context({video})),null);
  assert.equal(await lookupOfficialTranscription(signature,{...context(),fetchFn:async()=>{throw new Error('private transport detail');}}),null);
  assert.equal(await lookupOfficialTranscription(signature,context({html:' '.repeat(5*1024*1024+1)})),null);
});
test('aborted caller makes no request and default registry does not accept test identities',async()=>{
  const ctl=new AbortController();ctl.abort();const ctx=context();assert.equal(await lookupOfficialTranscription(signature,{...ctx,signal:ctl.signal}),null);assert.equal(ctx.calls.length,0);
  assert.equal(await lookupOfficialTranscription(signature,{fetchFn:async()=>{throw new Error('should not fetch');}}),null);
});
