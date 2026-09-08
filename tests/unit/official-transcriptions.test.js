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

test('diagnostics distinguish public metadata validation without exposing source bodies or transport details',async()=>{
  const video=makeVideo();video.playabilityStatus.status='LOGIN_REQUIRED';const events=[];
  await lookupOfficialTranscription(signature,{...context({video}),diagnose:event=>events.push(event)});
  const shape=events.find(x=>x.stage==='source_metadata');assert.ok(shape);assert.equal(shape.playability,'LOGIN_REQUIRED');assert.equal(shape.videoMatches,true);assert.equal(shape.channelMatches,true);assert.equal(shape.descriptionPresent,true);assert.equal(shape.paragraphMatches,true);
  assert.equal(JSON.stringify(events).includes(words),false);
  const failed=[];await lookupOfficialTranscription(signature,{...context(),fetchFn:async()=>{throw new Error('DO_NOT_LOG_PRIVATE_TRANSPORT');},diagnose:x=>failed.push(x)});
  assert.equal(JSON.stringify(failed).includes('DO_NOT_LOG'),false);assert.ok(failed.some(x=>x.outcome==='failed'));
});

function publicPage() {
  return {currentVideoEndpoint:{watchEndpoint:{videoId:entry.source.videoID}},contents:{twoColumnWatchNextResults:{results:{results:{contents:[
    {videoPrimaryInfoRenderer:{title:{runs:[{text:entry.source.title}]}}},
    {videoSecondaryInfoRenderer:{owner:{videoOwnerRenderer:{navigationEndpoint:{browseEndpoint:{browseId:entry.source.channelID}}}},attributedDescription:{content:'Credits\n'+words}}}
  ]}}}}};
}
function publicContext({page=publicPage(),duration='PT2M2S',identifier=entry.source.videoID,video={playabilityStatus:{status:'LOGIN_REQUIRED'}},includeSchema=true,allowAbsent=false,extraSchema=''}={}) {
  const schema=includeSchema?'<div itemscope itemtype="http://schema.org/VideoObject"><link itemprop="url" href="https://www.youtube.com/watch?v='+entry.source.videoID+'"><meta itemprop="identifier" content="'+identifier+'"><meta itemprop="duration" content="'+duration+'"><span itemprop="author"></span></div>':'';
  const html=schema+extraSchema+'<script>var ytInitialPlayerResponse = '+JSON.stringify(video)+'; var ytInitialData = '+JSON.stringify(page)+';</script>';
  const ctx=context({html});ctx.registry={recordings:[{...entry,source:{...entry.source,publicDuration:122,allowAbsentPublicDurationForPartialDescription:allowAbsent}}]};return ctx;
}
test('recovers exact public main-watch description when playback is gated without fetching media or authenticating',async()=>{
  const ctx=publicContext();const result=await lookupOfficialTranscription(signature,ctx);assert.ok(result);assert.equal(result.lyrics.partial,true);assert.equal(result.lyrics.lines.length,2);assert.equal(result.reviewedIdentity.descriptionMetadata,'public_watch_page');assert.equal(ctx.calls.length,2);assert.ok(ctx.calls[1].url.startsWith('https://www.youtube.com/watch?v='));
});
test('public watch fallback rejects identity, paragraph, duration and schema mutations',async()=>{
  for(const field of ['video','channel','title','paragraph','recommendation']){
    const page=publicPage(),contents=page.contents.twoColumnWatchNextResults.results.results.contents;
    if(field==='video')page.currentVideoEndpoint.watchEndpoint.videoId='wrong-video';
    if(field==='channel')contents[1].videoSecondaryInfoRenderer.owner.videoOwnerRenderer.navigationEndpoint.browseEndpoint.browseId='wrong-channel';
    if(field==='title')contents[0].videoPrimaryInfoRenderer.title.runs[0].text='Other Cover';
    if(field==='paragraph')contents[1].videoSecondaryInfoRenderer.attributedDescription.content='Different words';
    if(field==='recommendation'){page.recommendations=contents;page.contents.twoColumnWatchNextResults.results.results.contents=[];}
    assert.equal(await lookupOfficialTranscription(signature,publicContext({page})),null);
  }
  assert.equal(await lookupOfficialTranscription(signature,publicContext({duration:'PT2M3S'})),null);
  assert.equal(await lookupOfficialTranscription(signature,publicContext({identifier:'wrong-video'})),null);
});
test('public watch metadata cannot conceal contradictory player recording metadata',async()=>{
  const video=makeVideo();video.videoDetails.videoId='wrong-video';assert.equal(await lookupOfficialTranscription(signature,publicContext({video})),null);
});

test('an empty playback metadata object still permits independently verified public metadata',async()=>{
  assert.ok(await lookupOfficialTranscription(signature,publicContext({video:{playabilityStatus:{status:'LOGIN_REQUIRED'},videoDetails:{}}})));
});

test('public duration diagnostics distinguish absent schema and explicit duration conflicts',async()=>{
  const events=[];await lookupOfficialTranscription(signature,{...publicContext({duration:'PT2M3S'}),diagnose:event=>events.push(event)});
  const state=events.find(event=>event.stage==='public_page_duration');assert.equal(state.schemaCount,1);assert.equal(state.identifierMatches,true);assert.equal(state.urlMatches,true);assert.equal(state.parsedDuration,123);assert.equal(state.durationMatches,false);
  const absent=[];await lookupOfficialTranscription(signature,{...context({video:{playabilityStatus:{status:'LOGIN_REQUIRED'}}}),diagnose:event=>absent.push(event)});
  const missing=absent.find(event=>event.stage==='public_page_duration');assert.equal(missing.schemaCount,0);assert.equal(missing.parsedDuration,null);
});

test('a reviewed opt-in permits only partial untimed words when the entire public duration schema is absent',async()=>{
  const result=await lookupOfficialTranscription(signature,publicContext({includeSchema:false,allowAbsent:true}));
  assert.ok(result);assert.equal(result.reviewedIdentity.descriptionMetadata,'reviewed_catalog_and_public_description');
  assert.equal(result.lyrics.partial,true);assert.ok(result.lyrics.lines.every(line=>line.timestamp===null));
  assert.equal(await lookupOfficialTranscription(signature,publicContext({includeSchema:false})),null);
  const unregistered=publicContext({includeSchema:false,allowAbsent:true});
  assert.equal(await lookupOfficialTranscription({...signature,catalog_id:'999'},unregistered),null);assert.equal(unregistered.calls.length,0);
});

test('absent-schema opt-in still requires exact public identity and the single reviewed paragraph',async()=>{
  for(const field of ['video','channel','title','paragraph','duplicate']) {
    const page=publicPage(),contents=page.contents.twoColumnWatchNextResults.results.results.contents;
    if(field==='video')page.currentVideoEndpoint.watchEndpoint.videoId='wrong-video';
    if(field==='channel')contents[1].videoSecondaryInfoRenderer.owner.videoOwnerRenderer.navigationEndpoint.browseEndpoint.browseId='wrong-channel';
    if(field==='title')contents[0].videoPrimaryInfoRenderer.title.runs[0].text='Other Cover';
    if(field==='paragraph')contents[1].videoSecondaryInfoRenderer.attributedDescription.content='Changed words';
    if(field==='duplicate')contents[1].videoSecondaryInfoRenderer.attributedDescription.content=words+'\n'+words;
    assert.equal(await lookupOfficialTranscription(signature,publicContext({page,includeSchema:false,allowAbsent:true})),null);
  }
});

test('absent-schema opt-in never bypasses incomplete or conflicting present VideoObject metadata',async()=>{
  for(const change of [{duration:'PT2M3S'},{duration:''},{duration:'invalid'},{identifier:'wrong-video'},{identifier:''}]) {
    assert.equal(await lookupOfficialTranscription(signature,publicContext({...change,allowAbsent:true})),null);
  }
  for(const extraSchema of ['<div itemtype="https://schema.org/VideoObject "></div>',
    '<script type="application/ld+json">{"@type":"VideoObject","duration":"PT2M3S"}</script>',
    '<script type="application/ld+json">{"@type":["Thing","VideoObject"],"duration":"PT2M3S"}</script>']) {
    assert.equal(await lookupOfficialTranscription(signature,publicContext({includeSchema:false,allowAbsent:true,extraSchema})),null);
    assert.equal(await lookupOfficialTranscription(signature,publicContext({allowAbsent:true,extraSchema})),null);
  }
});

test('absent-schema partial words still reject a changed live catalog anchor',async()=>{
  const ctx=publicContext({includeSchema:false,allowAbsent:true}),fetchSource=ctx.fetchFn;
  const apple=makeApple();apple.results[0].trackTimeMillis=130000;
  ctx.fetchFn=(url,init)=>url.startsWith('https://itunes.apple.com/')?context({apple}).fetchFn(url,init):fetchSource(url,init);
  assert.equal(await lookupOfficialTranscription(signature,ctx),null);assert.equal(ctx.calls.length,0);
});
