import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {readFileSync} from 'node:fs';
import {Response} from 'node-fetch';
import {QQMusicAPI} from '../../api/music-apis/qq.js';
const f=JSON.parse(readFileSync(new URL('../fixtures/qrc-codec-fixtures.json',import.meta.url)));
// Fixed encrypted vectors contain synthetic First/Second rows only.
const bilingualQRC={
  "idol": "0c8d67dd3e549974b64ed2680459f13881aa15d10db4cc8324b86311d0d741bd6af5d8724f2b7571b2b2bf976be395e49ce543e87bf085b0d05bc5f45ffab18497794dba433cdf05275ea59d80582e190c6d40b80bf669a892399d81dc18be298647a132bcaecf33870ecb2f4bdb1b25ca0eeb16424e2273c1c23daefb3b1ed35f9a96ff4535391fa08fe6ca0fac4a40231088ecdea2c021467c6be48ea3dbd97e29d1fecaf99d83fbe49721faec346954de4352a87c75cf6178d1baea6d0f335dd6108f30595f47d8fa8afdd63b8bc8170ebf81765f60b2eb14d75813558c4f",
  "iu": "0c8d67dd3e549974b64ed2680459f13881aa15d10db4cc8324b86311d0d741bd6af5d8724f2b7571b2b2bf976be395e49ce543e87bf085b0d05bc5f45ffab18497794dba433cdf05275ea59d80582e190c6d40b80bf669a892399d81dc18be298647a132bcaecf33870ecb2f4bdb1b25d24233656c919ee03c2a014e788ecb8bba25fb74ace3d18e82a1a8c7c616ab0b239d4a21148c234cff8414797b3abc8c0e6fec76738def38b1062924023baea2dafd0b2da3f0425777aec4a692bba5b85574db2a3ba12ed2408eb0493a51916d",
  "group": "0c8d67dd3e549974b64ed2680459f13881aa15d10db4cc8324b86311d0d741bd6af5d8724f2b7571b2b2bf976be395e49ce543e87bf085b0d05bc5f45ffab18497794dba433cdf05275ea59d80582e190c6d40b80bf669a892399d81dc18be298647a132bcaecf33870ecb2f4bdb1b25819f34df40ae0b36c3aafe79bfd0034ae0396a06cdd95dfeb6bc2adc9be8a65fc9841b9bd360080e7daa094450511b7cafbcf91857f557f880a9629d6688d8d60d2292cd3c10e4a33ba64dcc702952a8862aa4ebb05779ff30b6f3d452ecff1dcbefc5fbdcb416d32f60356e3b4811c1"
};
const request={artist:'Test',title:'Synthetic',duration:120,album:'Example'};
// Material edition descriptors, with synthetic First/Second source rows.
const editionQRC={
  "badAwardCaption": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c566e0625fd14db0d87663f4cc2aa2798bb20a8f0d0a4e9a921e40eaafc0507e7394812dee6cf2f207a69663d980417598914ecbfd84cd99cbb2d8f0c3a4f7527eb7c0082995b76ac7b39ed326fe67ad9bc5d25ce778a092d365de3f076f4bd738191d61c0b996a48b2b9c3e7dc58fd262e4e9fd765918fc244",
  "badExplicitCaption": "e278b9763b68244eadfad7ce9df4bda6db36aed72c7cb4a3ac4cb8bed1357f0c87e5a92773143681a0ddf77f9fc9c6b711db131deaaeb07cdf3dfaec5ca87155ec847694f615c49b1ff545b9cc14e663694bd3c497825d5fe042533c779dba704801b86ba64ca4ddb37df37339f41e33c73640ecf9871279803986509ab37c2d91dfb37225196afda5cd5641a6b34c2eb490002b15b6d33aef99c84f6cab3ff5",
  "benignAwardCaption": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c5681c21f4eb60a7319bf53adff1fb076f8030079109169b482c37bbfcb276fa0c6b0eacdfce51482c86da7487b4a539a1e22474b7dea0ff9c1272d9460b5ffa1976682504dae730bcecc2e5a687e003599e260b803ceae7779bd13cf6ea653f27e5f996c5fff1de95ad0d8f1cda43879bc",
  "benignExplicitCaption": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c5681c21f4eb60a731954a4c9d505b2eed6ca9997f0e1da59f153d6ccd705879277798eaa19968011e8d81fd7734c8cd486d61e89df281a1f0522a21995f1523198a3533d1648cf9189bb376b1fe64a5eb619671381d76f2995",
  "opaque": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c564e9d16a5f1726d3a0e89c80296ae7683916dacccb3f3b9b6e0396a06cdd95dfe82c56fd602227302c5fb217554c32ecea41c21461a1fea1ae731f9db972be9374b2c49600a56aeabd4450e4dd7975651ae6c3d9aaed629ce",
  "caption": "4c8e63086c537f1dd5f809ab8bdf9d49856c7fd798cd6b5daf7ce698547da00c1c925b19479198605876e50cd348dda70540e8c667278adccd33aa980f94c7c3c4da4a2bec8ee669bd55dde28837141259b0bbd93722720f58fddb4709c38b2fe3afb357c08b7536b67aed41ba618d7df1006d23f8199452942e279a178e70bf5b9e8c5bd40c6cbad28b0a861a21f112c403667125a51622",
  "remaster": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c567db1400a5842b1b2c8161cf2ac409a3ae0396a06cdd95dfe82c56fd602227302c5fb217554c32ecea41c21461a1fea1ae731f9db972be9374b2c49600a56aeabdd81f508cc44f7dbe06af8010ed7b5b3",
  "live": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c56272ced23d1af1267dc40fcb29e6549da9a7b9cf1334b49cf717a33a005de4c5b23b828f3620c7aa662c792bfbd7d85906cc8044c493a392d33efe2de008de861d47470cf47ed511e2348468e83d970e6",
  "edit": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c561cc417465a3f0e3391370693e4f76ad5e0396a06cdd95dfe82c56fd602227302c5fb217554c32ecea41c21461a1fea1ae731f9db972be9374b2c49600a56aeabdd81f508cc44f7db6fab791f38fc93cf",
  "matching": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b3644861079c64c0964047c14937fc14be117036e3dcb7ebab9f5a0747f49a0030acea9cd752d9b619bddd4bd7cc6c8b97486da8684d10eba014acfced13a05e5dce06e6352b77e7de24fac2aef34a3ae953d21e313f1c0741d0b3e878188ce28fc",
  "subtitle": "ee7befb746f93831d42dcdf2e21f0d5dd9fd95a45509a645c457a4c6b1f25e151e8cad1e55389e4864eb076a798a526b819f34df40ae0b36fdd4984b94688c561ff2372555349687ed9019e5ffbd3e9419344d62bc1aabd412ec4bca1f7bf3e8c305e58d925c4651f8e31b7de702a6995d7bcc8fbf57c8cfcead942d4a90edf5cc59367cce381c232d2570bcf5d41737d25a97d1029f410c"
};
// Public MIT codec vectors use synthetic rows, never source lyric text.
const explicitQRC={
  "ascii": "5a7890e0c497e62a53efcc0e555d12f0ec18c2caf44d4b993b604e0024eab54c5f169ed26ce8db80d625309f38ba82589da62ae5cea5f0621b7dd95598aeff9cfcd580c7cc662421fbfd109c70c100146d4780fcf1d0d513c96d234375c0479aca404760f44d82586fd41c856842f4bb2eb4663bf66dd1a0c35ec04a9877a71e5024741e4d34cff57d6f2bc9c8eca3934be83d840b0fa44041e3833ebd93a28222d5fb43208eac5fa06df6b90a2a0f98cd07cfc6a577f6d5155b2eef4163440f",
  "fullwidth": "5a7890e0c497e62a0514079237cf6dc3f885df15b290c2119b0dbecd40bec97e149a392be9c1ca9f45e0d6c151693e5a79feee6d9d410e430b2ae3c2f6c30bf83e498a7e6431b92ec365ff3da2b197629ab1fc56a8aa4051389c27ab18ea467674c44bc5e4606935b645c8f17331b92458ee070789b985ae6d64eab5886fbb07983f107f23d2cd1bc6846f025c967455a7e51121401ab0c466414920437848872b54d536368a05b8bd4b19936c72e38dc0aed764e09a56c08c503b7828edbba5704d3ec7b36ca4ed",
  "wrongCase": "5a7890e0c497e62a53efcc0e555d12f01f1af82407ce8cd69b0dbecd40bec97ee99b96688b05d13ccd418b81240e1effa96c7a66d04e520a7985472e39db7933e8d3ddeb395b589e2ebda9ff7ae07acc10c7b4c4019f9adbf2cf4b5ce2aab307818cc3984313e4840bb1d2e2bccd9ca67709b51b65c42091613373e9f5944478d08f2248ad384befe1915f14af5baf83ba0c0c4fe92ef980f983233ddb52d18bcabee2cf1041867c062697debb7f0877350b46474fedfea364c19cf4deaffd59",
  "different": "d07df6c09d33711ec4175007af645ae7d1ac1e62d4c5aef57698a84f57287e7a3dbc7792c0ff5347471a28dafe382d2294d63b8666e2b9d0099d1eca71580bcb362170ba9cd93d0fe37af052e391c4dfd6c6a44afdc2b030580ace80cdf4aec95e790e9e3d86f9f51123106139b1eed788296129c8775f793907fb41c34790742ed51829ec190b540c22195907298de7e9603bec216607b4f831310675b1dbc106e3eefcfba0dd111032a7b34a3b7fa35aa55c7718ed95db5d1e99dd62797c41",
  "live": "5a7890e0c497e62ac2a75eae05cc3685f885df15b290c2113b604e0024eab54c2a1a369e0b47884c8f1539372f2cbc9eb0fbc1d53195c3a32492e845211b1d8b345130ce225342557c0ef76c3cd4cdbefa55596a6daef826f6be40141d84632a654a08b0688c97b78c7eeaa8c590fe7b942b6b96fdf4905bf0947c742c6549101a4b7d91837b3281160e20635c66ff790f41a678f6435afc8e7a0d8210b9c3c080edcc72aad8bd79dab1ed415c21497a8045d7a3d79012286b7acd135c519f0f3cf642004c08ca63",
  "guest": "9007434f59eac239681f2097c3aa57dfa7983ed4458de450b05bb4e6e811297ad9a3b8ca827d475521035921ad1db184a9971dfd135c84e50cb685df1134881078940786569e3402cd4d6f6280b842611b886fa3d92564ba2ca02af11547b6db9e68550720bb32cee231c0edec6e454d94d6585b8b994bafad974204dda907cb761f7a6b93c3d768b2a70a2af12a6916f07d0a2deb6a16a0d5ba3f679feff933d3064ac1c3f2e8d1281c5c363e5728536073b0c5a4e9a889bd84037992043dd4496c85929861ab740b58da3a50327be7",
  "artist": "d07df6c09d33711ec4175007af645ae775fc2b8fab360e4e5be54f170f90e841a8a78343e34b9a839e639325d650d450418901f47224e770fcc5c6f75edbd7dca9ac794f85c7e60dde2819ee0a9fd0afcc29f9d88abc431e0dd47881fd29e085ae507f1a12be54bb5717a7a39e612cc5c07ca65a2a406b3004464e3080da49ad9079bce08cbc2f91ac332a62026c4dc8986f94c7712c0754b056c5360cdc217e4ff0c409f7dfe7bb83be311f983f86d0b413f95c9c1b72c4c5c44d412dba4e35",
  "rounded": "97d1672be5796c003c825e59a9c48da17903f0d064c0d0af7452958f7389790f85e49abc8bda5298ce315c57dc7006fe69ff3ef7509442da1e5ecacb0425f231d3830148a2e6c8f345b9c21c5d26e98602e7bd0ac68883c962cf3c3685aecd1594eae6e5a2588c029555ab0cf07715b920514689763b21f94f089edac967894a365235394cdf5fd100bb49656fe817dc3b2dcad44e8a254617e46eefb3bf11662462cc4935c63e177be302d5a9696de40f91d1e8f45d09e87729b95b3c0105d6"
};
const candidate=(value='123',changes={})=>({songid:Number(value),songmid:String(value).padStart(14,'0'),songname:request.title,
 albumid:2,albummid:'00000000000002',albumname:request.album,interval:120,singer:[{id:1,mid:'00000000000001',name:request.artist}],...changes});
const answer=(data,url)=>({ok:true,status:200,url,headers:new Map(),json:async()=>data});
function context(rows=[candidate()],lyrics={},extra={}) {
 const calls=[];return {...request,...extra,calls,fetchFn:async(url,init)=>{
  const u=new URL(url),payload=init.body?JSON.parse(init.body):null;calls.push({url:u,init,payload});
  if(!payload){
   if(u.pathname.endsWith('smartbox_new.fcg')){const hints=extra.fastRows??[];return answer({code:0,data:{song:{count:hints.length,itemlist:hints.map(r=>({id:String(r.songid),docid:String(r.songid),mid:r.songmid,name:r.songname,singer:r.singer.map(s=>s.name).join('/')}))}}},url);}
   return answer({code:0,data:{song:{list:rows}}},url);
  }
  const lyric=p=>{const setting=lyrics[p.songId]??{};return {code:setting.code??0,data:{songID:p.songId,songName:request.title,singerName:request.artist,qrc:p.qrc,crypt:1,
   lyric:p.qrc?(setting.hex??f.providerQRC):(setting.lrc??f.providerLRC),...setting.fields}};};
  const result={code:0};
  for(const [key,entry] of Object.entries(payload)) {
   if(key==='comm')continue;const param=entry.param;
   if(entry.method==='get_song_detail_yqq') {
    const raw=(extra.fastRows??rows).find(r=>r.songid===param.song_id)??rows[0];
    result[key]={code:0,data:{track_info:{id:raw.detailID??raw.songid,mid:raw.detailMID??raw.songmid,name:raw.songname,title:raw.detailTitle??raw.songname,subtitle:raw.subtitle??'',interval:raw.interval,
     album:{id:raw.albumid,mid:raw.albummid,name:raw.albumname,...(raw.detailAlbumTitle!==undefined?{title:raw.detailAlbumTitle}:{})},singer:raw.singer,...(raw.explicit!==undefined?{explicit:raw.explicit}:{})}}};
   }else result[key]=lyric(param);
  }
  return answer(result,url);
 }};
}
const search=ctx=>new QQMusicAPI().searchSong(ctx.artist,ctx.title,ctx);

test('QQ allowed outer sheet suffixes revalidate the entire remaining caption against the strict source core',async()=>{
 for(const [key,explicit] of [['badAwardCaption',undefined],['badExplicitCaption',true]]) {
  const ctx=context([candidate()],{123:{hex:editionQRC[key]}},{explicit});
  await assert.rejects(new QQMusicAPI().getRecording('123',ctx),{code:'recording_mismatch'});
 }
 const echo=context([candidate()],{123:{hex:f.providerQRC,fields:{songName:'Synthetic (from The Mono Edition) (65届格莱美获奖歌曲)'}}});
 await assert.rejects(new QQMusicAPI().getRecording('123',echo),{code:'recording_mismatch'});
 for(const [key,explicit] of [['benignAwardCaption',undefined],['benignExplicitCaption',true]]) {
  const ctx=context([candidate()],{123:{hex:editionQRC[key]}},{explicit}),fresh=await new QQMusicAPI().getRecording('123',ctx);
  assert.equal(fresh.song.title,'Synthetic');assert.ok(fresh.lyrics.lines.every(l=>l.vocalTiming));
 }
});
test('QQ equivalent full album text survives annotation boundaries without weakening other edition checks',async()=>{
 for(const [left,right,title,hex] of [
  ['Example (Live at Paris)','Example Live at Paris','Synthetic',f.providerQRC],
  ['Example (Acoustic Sessions)','Example Acoustic Sessions','Synthetic',f.providerQRC],
  ['Example (2011 Remaster)','Example 2011 Remaster','Synthetic (2011 Remaster)',editionQRC.matching]
 ])for(const [album,sourceAlbum] of [[left,right],[right,left]])for(const provider of ['apple','spotify']) {
  const row=candidate('123',{songname:title,albumname:sourceAlbum}),lyrics={123:{hex,fields:{songName:''}}};
  const target={title,album,...(provider==='spotify'?{recordingProvider:'spotify',creditedArtistNames:['Test']}:{})};
  const fresh=await new QQMusicAPI().getRecording('123',context([row],lyrics,target));assert.equal(fresh.song.album,sourceAlbum);assert.ok(fresh.lyrics.lines.every(l=>l.vocalTiming));
 }
 for(const [album,sourceAlbum] of [['Example (Live at Paris)','Example Live at Tokyo'],['Example (2011 Remaster)','Example 2015 Remaster']]) {
  await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate('123',{albumname:sourceAlbum})],{}, {album})),{code:'recording_mismatch'});
 }
});
test('QQ authoritative duration exclusions survive readable-only fast results and misleading legacy recovery',async()=>{
 const valid=candidate('123',{albumname:'Other'}),unqualified=candidate('124',{songname:'Synthetic - Test',detailTitle:'Synthetic - Test (Cover)',interval:90});
 const legacy=candidate('124'),lyrics={123:{hex:'00'}};
 const ctx=context([valid,legacy],lyrics,{fastRows:[valid,unqualified]}),song=await search(ctx);
 assert.equal(song.id,'123');assert.equal(song.lyricsData.lines.some(l=>l.vocalTiming),false);
 assert.equal(ctx.calls.length,4);assert.equal(ctx.calls.some(c=>c.payload?.req?.param?.songId===124),false);
});

test('QQ Viva discovery excludes a fresh verified unrelated cover only by its authoritative out-of-bound interval',async()=>{
 const valid=candidate('2166066',{songname:'Viva La Vida',albumname:'Viva La Vida or Death and All His Friends',interval:241,
  singer:[{id:1,mid:'00000000000001',name:'Coldplay'}]});
 const cover=candidate('499819215',{songmid:'002j7vDt23godF',songname:'Viva La Vida - Coldplay',detailTitle:'Viva La Vida - Coldplay (Violin Cover)',
  albumname:'Viva La Vida - Coldplay (Violin Cover)',interval:192,singer:[{id:973775,mid:'00000000973775',name:'Filip Jancik'}]});
 const lyrics={2166066:{hex:f.providerAwardQRC,fields:{songName:'',singerName:''}}};
 const target={title:'Viva La Vida',artist:'Coldplay',album:valid.albumname,duration:241};
 const ctx=context([valid],lyrics,{...target,fastRows:[valid,cover]}),song=await search(ctx);
 assert.equal(song.id,'2166066');assert.ok(song.lyricsData.lines.every(l=>l.vocalTiming));assert.equal(ctx.calls.length,2);
 assert.ok(ctx.calls[1].payload.details_499819215);assert.equal(ctx.calls[1].payload.details_499819215.param.song_id,499819215);
 // A smaller legacy subset cannot hide a possible contender or an untrusted
 // source identity/interval. The exact existing three-second edge is retained.
 for(const changes of [{interval:238},{interval:244},{interval:'192'},{interval:0},{interval:7201},{detailID:999},{detailMID:'00000000000999'}]) {
  const unresolved=context([valid],lyrics,{...target,fastRows:[valid,{...cover,...changes}]});
  await assert.rejects(search(unresolved),{code:'recording_mismatch'});assert.equal(unresolved.calls.length,3);
 }
});
test('QQ reviewed Idol raw display semantics survive the actual informational TV subtitle and formatting',async()=>{
 const caption='《【我推的孩子】》TV动画片头曲|第1话片尾曲';
 const base=candidate('403181955',{songname:'アイドル',detailTitle:'アイドル (偶像)',subtitle:caption,albumname:'アイドル',detailAlbumTitle:'アイドル (偶像)',interval:213,
  singer:[{id:1,mid:'00000000000001',name:'YOASOBI',title:'YOASOBI (ヨアソビ)'}]});
 const lyrics={403181955:{hex:bilingualQRC.idol,fields:{songName:'',singerName:''}}};
 const target={artist:'YOASOBI',title:'アイドル',album:'アイドル - Single',duration:213.234};
 for(const detailTitle of ['アイドル (偶像)','アイドル(偶像)','アイドル（偶像）']) {
  const row={...base,detailTitle},ctx=context([row],lyrics,{...target,fastRows:[row]}),song=await search(ctx);
  assert.equal(song.id,'403181955');assert.equal(song.title,'アイドル');assert.equal(song.subtitle,caption);assert.ok(song.lyricsData.lines.every(l=>l.vocalTiming));assert.equal(ctx.calls.length,2);
  const fresh=await new QQMusicAPI().getRecording('403181955',context([row],lyrics,target));assert.equal(fresh.song.title,'アイドル');assert.equal(fresh.song.subtitle,caption);
  await assert.rejects(search(context([row],lyrics,{...target,title:detailTitle,fastRows:[row]})),{code:'recording_mismatch'});
 }
 for(const subtitle of ['Original Version','Original Mix','Mono','2015 Remaster','Tokyo Live','feat. Guest',caption+' (Original Mix)']) {
  const row={...base,subtitle};
  await assert.rejects(new QQMusicAPI().getRecording('403181955',context([row],lyrics,target)),{code:'recording_mismatch'});
 }
});

test('QQ full display-edition authority rejects mixes, versions, channels and unclassified qualifiers',async()=>{
 for(const [primary,display,hex] of [
  ['Synthetic (Original Mix)','Synthetic (Extended Mix)',f.providerEditionQRC['Synthetic (Extended Mix)']],
  ['Synthetic (Original Version)','Synthetic (Re-recorded Version)',f.providerEditionQRC['Synthetic (Re-recorded Version)']],
  ['Synthetic (Mono)','Synthetic (Stereo)',f.providerEditionQRC['Synthetic (Stereo)']],
  ['Synthetic (Red Opaque Qualifier)','Synthetic (Blue Opaque Qualifier)',editionQRC.opaque]
 ])for(const provider of ['apple','spotify']) {
  const row=candidate('123',{songname:primary,detailTitle:display}),lyrics={123:{hex,fields:{songName:display}}};
  const target={title:primary,...(provider==='spotify'?{recordingProvider:'spotify',creditedArtistNames:['Test']}:{})};
  await assert.rejects(new QQMusicAPI().getRecording('123',context([row],lyrics,target)),{code:'recording_mismatch'});
  await assert.rejects(search(context([row],lyrics,{...target,fastRows:[row]})),{code:'recording_mismatch'});
 }
});
test('QQ one-sided material labels remain in catalog admission and cannot authorize an unqualified sheet',async()=>{
 const title='Synthetic (Original Mix)',hex=f.providerEditionQRC[title],lyrics={123:{hex,fields:{songName:title}}};
 const qualified=candidate('123',{detailTitle:title});
 await assert.rejects(new QQMusicAPI().getRecording('123',context([qualified],lyrics)),{code:'recording_mismatch'});
 const accepted=await new QQMusicAPI().getRecording('123',context([qualified],lyrics,{title}));assert.equal(accepted.song.title,title);
 const primary=candidate('123',{songname:title,detailTitle:'Synthetic'});
 const proper=await new QQMusicAPI().getRecording('123',context([primary],lyrics,{title}));assert.equal(proper.song.title,title);
 await assert.rejects(new QQMusicAPI().getRecording('123',context([primary],{}, {title})),{code:'recording_mismatch'});
});
test('QQ compares complete album descriptors while permitting ordinary alternate release names',async()=>{
 const conflicts=[['2011 Remaster','2015 Remaster'],['Paris Live','Tokyo Live'],['Original Mix','Extended Mix'],
  ['Original Version','Re-recorded Version'],['Mono','Stereo'],['Short Edit','Extended Edit'],['Sped Up 1.1x','Sped Up 1.2x'],
  ['Slowed 0.8x','Slowed 0.9x'],['2011 Re-recording','2015 Re-recording'],['Red Opaque Qualifier','Blue Opaque Qualifier']];
 for(const [left,right] of conflicts)for(const provider of ['apple','spotify']) {
  const row=candidate('123',{albumname:`Other [${right}]`}),target={album:`Example (${left})`,...(provider==='spotify'?{recordingProvider:'spotify',creditedArtistNames:['Test']}:{})};
  await assert.rejects(new QQMusicAPI().getRecording('123',context([row],{},target)),{code:'recording_mismatch'});
  await assert.rejects(search(context([row],{}, {...target,fastRows:[row]})),{code:'recording_mismatch'});
 }
 for(const [album,sourceAlbum] of [['Example (2011 Remaster)','Other [2011 Remaster]'],['Example (Original Mix)','Other (Original Mix)'],
  ['Example (Red Opaque Qualifier)','Other (Red Opaque Qualifier)'],['Example - Single','Other (Deluxe Edition)'],
  ['Ordinary Collection','Cover Me'],['Example Deluxe Edition','Other Standard Edition']]) {
  const row=candidate('123',{albumname:sourceAlbum}),ctx=context([row],{}, {album,fastRows:[row]}),song=await search(ctx);
  assert.equal(song.album,sourceAlbum);assert.ok(song.lyricsData.lines.every(l=>l.vocalTiming));
  const fresh=await new QQMusicAPI().getRecording('123',context([row],{}, {album}));assert.equal(fresh.song.album,sourceAlbum);
 }
 const prose=candidate('123',{albumname:'Live Through Tomorrow'}),target={album:'Cover Me',recordingProvider:'spotify',creditedArtistNames:['Test']};
 assert.equal((await new QQMusicAPI().getRecording('123',context([prose],{},target))).song.album,'Live Through Tomorrow');
});
test('QQ material descriptors cannot hide in descriptive captions or malformed nested labels',async()=>{
 const title='Synthetic (from The Mono Edition)',lyrics={123:{hex:editionQRC.caption,fields:{songName:''}}};
 await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate()],lyrics)),{code:'recording_mismatch'});
 await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate('123',{detailTitle:title})],lyrics)),{code:'recording_mismatch'});
 for(const album of ['Example (2011 Remaster','Example [Mono)','Example '+ '('.repeat(9)+'Mono'+')'.repeat(9)]) {
  await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate('123',{albumname:album})],{}, {album})),{code:'recording_mismatch'});
 }
 for(const [album,sourceAlbum] of [['Example Mono 2011 Remaster','Example Stereo 2011 Remaster'],
  ['Example Live Original Mix','Example Live Extended Mix'],['Example - Blue Unknown','Other - Red Unknown']]) {
  await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate('123',{albumname:sourceAlbum})],{}, {album})),{code:'recording_mismatch'});
 }
 for(const [album,sourceAlbum] of [['Example Monophonic','Example Stereophonic'],['Example Dolby Atmos','Example Stereo'],
  ['Example 立体声','Example 单声道'],['Example SpedUp 0.8x','Example SpedUp 1.2x'],['Example 120 BPM','Example 130 BPM']]) {
  await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate('123',{albumname:sourceAlbum})],{}, {album})),{code:'recording_mismatch'});
 }
});
test('QQ reviewed Idol labels are informational only on fresh source objects and retain every other edition',async()=>{
 const row=candidate('123',{songname:'アイドル',detailTitle:'アイドル (偶像)',albumname:'アイドル (偶像)',
  singer:[{id:1,mid:'00000000000001',name:'YOASOBI',title:'YOASOBI (ヨアソビ)'}]});
 const target={artist:'YOASOBI',title:'アイドル',album:'アイドル - Single'},lyrics={123:{hex:bilingualQRC.idol,fields:{songName:'',singerName:''}}};
 const ctx=context([row],lyrics,{...target,fastRows:[row]}),song=await search(ctx);assert.equal(song.title,'アイドル');assert.equal(song.album,'アイドル (偶像)');
 const fresh=await new QQMusicAPI().getRecording('123',context([row],lyrics,target));assert.ok(fresh.lyrics.lines.every(l=>l.vocalTiming));
 const copied=JSON.parse(JSON.stringify(song));copied.information=[{base:'アイドル',label:'偶像'}];
 await assert.rejects(new QQMusicAPI().getLyrics('123',{...ctx,song:copied}),{code:'recording_mismatch'});
 for(const edition of ['2015 Remaster','Tokyo Live','Original Mix','Mono','Unknown Qualifier']) {
  const other={...row,albumname:`アイドル (偶像) (${edition})`};
  await assert.rejects(new QQMusicAPI().getRecording('123',context([other],lyrics,target)),{code:'recording_mismatch'});
 }
 const unknown=candidate('123',{albumname:'Other (Blue Opaque Qualifier)'});
 await assert.rejects(new QQMusicAPI().getRecording('123',context([unknown],{}, {album:'Example (Red Opaque Qualifier)',explicit:true})),{code:'recording_mismatch'});
});

for(const edition of [
 {key:'remaster',primary:'Synthetic (2011 Remaster)',display:'Synthetic (2015 Remaster)'},
 {key:'live',primary:'Synthetic (Paris Live)',display:'Synthetic (Tokyo Live)'},
 {key:'edit',primary:'Synthetic (Short Edit)',display:'Synthetic (Extended Edit)'}
])test(`QQ conflicting ${edition.key} descriptors cannot authorize alternate source sheets`,async()=>{
 const row=candidate('123',{songname:edition.primary,detailTitle:edition.display}),lyrics={123:{hex:editionQRC[edition.key],fields:{songName:edition.display}}};
 await assert.rejects(new QQMusicAPI().getRecording('123',context([row],lyrics,{title:edition.primary})),{code:'recording_mismatch'});
 // The same legacy ID cannot hide the contradiction from fresh detail.
 const ctx=context([row],lyrics,{title:edition.primary,fastRows:[row]});
 await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
});
test('QQ edition conflicts stay material when album markers or subtitle labels repeat the category',async()=>{
 const primary='Synthetic (2011 Remaster)',display='Synthetic (2015 Remaster)',album='Example (Remastered)';
 const row=candidate('123',{songname:primary,detailTitle:display,albumname:album});
 await assert.rejects(new QQMusicAPI().getRecording('123',context([row],{123:{hex:editionQRC.remaster,fields:{songName:display}}},{title:primary,album})),{code:'recording_mismatch'});
 const subtitle=candidate('123',{songname:primary,detailTitle:primary,subtitle:'2015 Remaster'});
 await assert.rejects(new QQMusicAPI().getRecording('123',context([subtitle],{123:{hex:editionQRC.subtitle,fields:{songName:primary+' (2015 Remaster)'}}},{title:primary})),{code:'recording_mismatch'});
});
test('QQ matching full edition descriptors permit normalized display punctuation',async()=>{
 const primary='Synthetic (2011 Remaster)',display='Synthetic（2011 Remaster）',row=candidate('123',{songname:primary,detailTitle:display});
 const ctx=context([],{123:{hex:editionQRC.matching,fields:{songName:display}}},{title:primary,fastRows:[row]}),song=await search(ctx);
 assert.equal(song.title,primary);assert.equal(song.providerDisplayTitle,display);assert.equal(song.lyricsData.lines.length,2);assert.equal(ctx.calls.length,2);
 const fresh=await new QQMusicAPI().getRecording('123',context([row],{123:{hex:editionQRC.matching,fields:{songName:display}}},{title:primary}));
 assert.equal(fresh.song.title,primary);assert.ok(fresh.lyrics.lines.every(l=>l.vocalTiming));
});

test('QQ explicit sheet labels require a fresh exact explicit request and preserve the source catalog title',async()=>{
 for(const hex of [explicitQRC.ascii,explicitQRC.fullwidth]) {
  const ctx=context([],{123:{hex}},{fastRows:[candidate()],explicit:true}),song=await search(ctx);
  assert.equal(song.title,'Synthetic');assert.equal(song.lyricsData.lines.length,2);
  assert.equal(song.lyricsData.providerLyricLabels[0].value.includes('Explicit'),true);
  assert.equal(song.lyricsData.timingSource.source,'qq:123:qrc');
  assert.equal(await new QQMusicAPI().getLyrics('123',{...ctx,song}),song.lyricsData);
  for(const explicit of [false,undefined])await assert.rejects(new QQMusicAPI().getLyrics('123',{...ctx,song,explicit}),{code:'recording_mismatch'});
  const refreshed=await new QQMusicAPI().getRecording('123',context([candidate()],{123:{hex}},{explicit:true}));
  assert.equal(refreshed.song.title,'Synthetic');assert.equal(refreshed.lyrics.lines.length,2);
  const copied=JSON.parse(JSON.stringify(refreshed.song));delete copied.lyricsData;
  await assert.rejects(new QQMusicAPI().getLyrics('123',{...context([candidate()],{123:{hex}},{explicit:true}),song:copied}),{code:'recording_mismatch'});
 }
 for(const explicit of [false,undefined]) {
  const ctx=context([],{123:{hex:explicitQRC.ascii}},{fastRows:[candidate()],explicit});
  await assert.rejects(search(ctx),{code:'recording_mismatch'});
  await assert.rejects(new QQMusicAPI().getRecording('123',context([candidate()],{123:{hex:explicitQRC.ascii}},{explicit})),{code:'recording_mismatch'});
 }
 const clean=context([],{123:{hex:explicitQRC.ascii}},{fastRows:[candidate('123',{explicit:false})],explicit:true});
 await assert.rejects(search(clean),{code:'recording_mismatch'});
 const legacy=context([candidate()],{123:{hex:explicitQRC.ascii}},{explicit:true});await assert.rejects(search(legacy),{code:'recording_mismatch'});
});
test('QQ explicit sheet permission does not admit other versions, guest credits, artists, names or transport echoes',async()=>{
 for(const key of ['wrongCase','different','live','guest','artist']) {
  const ctx=context([],{123:{hex:explicitQRC[key]}},{fastRows:[candidate()],explicit:true});
  await assert.rejects(search(ctx),{code:'recording_mismatch'});
 }
 for(const fields of [{songID:999},{songName:'Synthetic (Explicit)'},{singerName:'Other'}]) {
  const ctx=context([],{123:{hex:explicitQRC.ascii,fields}},{fastRows:[candidate()],explicit:true});
  await assert.rejects(search(ctx),{code:'recording_mismatch'});
 }
});
test('QQ retains album rendition labels for Apple admission and rechecks cached request classification',async()=>{
 for(const marker of ['Explicit','Clean','Live','Remastered','Remix','Acoustic']) {
  const row=candidate('123',{albumname:`Album (${marker})`});
  for(const extra of [{},{explicit:false}]) {
   await assert.rejects(search(context([row],{}, {...extra,fastRows:[row]})),{code:'recording_mismatch'});
   await assert.rejects(new QQMusicAPI().getRecording('123',context([row],{},extra)),{code:'recording_mismatch'});
  }
 }
 // Source title and album both carrying Explicit previously let the canonical
 // primary title hide the marker from Apple's older, narrower album scorer.
 const row=candidate('123',{albumname:'Album (Explicit)',detailTitle:'Synthetic (Explicit)'});
 const ctx=context([row],{123:{hex:explicitQRC.ascii}},{fastRows:[row],explicit:true});
 const song=await search(ctx);assert.equal(song.title,'Synthetic');assert.equal(song.album,'Album (Explicit)');
 assert.ok(song.lyricsData.lines[0].vocalTiming);
 const fresh=await new QQMusicAPI().getRecording('123',context([row],{123:{hex:explicitQRC.ascii}},{explicit:true}));
 assert.ok(fresh.lyrics.lines[0].vocalTiming);
 for(const explicit of [false,undefined])await assert.rejects(new QQMusicAPI().getLyrics('123',{...ctx,song,explicit}),{code:'recording_mismatch'});
 for(const marker of ['Clean','Live','Remastered','Remix','Acoustic']) {
  const other=candidate('123',{albumname:`Album (${marker})`});
  await assert.rejects(search(context([other],{}, {explicit:true,fastRows:[other]})),{code:'recording_mismatch'});
 }
});
test('Spotify explicit flag admits QQ source-owned explicit album and sheet labels through fresh ID validation',async()=>{
 const row=candidate('123',{albumname:'Album (Explicit)',detailTitle:'Synthetic (Explicit)'});
 const extra={recordingProvider:'spotify',creditedArtistNames:['Test'],explicit:true,fastRows:[row]};
 const ctx=context([row],{123:{hex:explicitQRC.ascii}},extra),song=await search(ctx);
 assert.equal(song.album,'Album (Explicit)');assert.ok(song.lyricsData.lines[0].vocalTiming);
 const fresh=await new QQMusicAPI().getRecording('123',context([row],{123:{hex:explicitQRC.ascii}},extra));
 assert.ok(fresh.lyrics.lines[0].vocalTiming);
 for(const explicit of [false,undefined])await assert.rejects(search(context([row],{123:{hex:explicitQRC.ascii}},{...extra,explicit})),{code:'recording_mismatch'});
});

test('QQ validated integer source intervals retain measured final cues within their declared precision',async()=>{
 const ctx=context([],{123:{hex:explicitQRC.rounded}},{fastRows:[candidate()]}),song=await search(ctx);
 assert.equal(song.duration,120);assert.equal(song.lyricsData.durationResolution,1);
 assert.equal(song.lyricsData.lines.at(-1).vocalTiming.end,120.5);
 assert.equal(song.lyricsData.lines.at(-1).vocalTiming.segments.at(-1).end,120.5);
});

test('QQ same-ID bilingual display titles and artist labels do not become catalog aliases',async()=>{
 const cases=[{name:'アイドル',display:'アイドル (偶像)',artist:'YOASOBI',artistDisplay:'YOASOBI (ヨアソビ)',hex:bilingualQRC.idol},
  {name:'Blueming',display:'Blueming',artist:'IU',artistDisplay:'IU (아이유)',hex:bilingualQRC.iu}];
 for(const item of cases) {
  const row=candidate('123',{songname:item.name,detailTitle:item.display,singer:[{id:1,mid:'00000000000001',name:item.artist,title:item.artistDisplay}]}),settings={hex:item.hex,fields:{songName:item.display,singerName:item.artistDisplay}};
  const ctx=context([],{123:settings},{fastRows:[row],title:item.name,artist:item.artist}),song=await search(ctx);
  assert.equal(song.title,item.name);assert.equal(song.artist,item.artist);assert.equal(song.providerDisplayTitle,item.display);assert.deepEqual(song.providerDisplayArtistNames,[item.artistDisplay]);
  assert.equal(song.lyricsData.lines[0].text,'First');assert.ok(song.lyricsData.lines[0].vocalTiming);assert.equal(ctx.calls.length,2);
  const aliasRequest=context([],{123:settings},{fastRows:[row],title:item.display,artist:item.artistDisplay});await assert.rejects(search(aliasRequest),{code:'recording_mismatch'});
 }
});
test('QQ bilingual source headers require freshly bound full display lists, preserving every guest',async()=>{
 const row=candidate('123',{singer:[{id:1,mid:'00000000000001',name:'Test',title:'Test (테스트)'},{id:2,mid:'00000000000002',name:'Guest',title:'Guest (嘉宾)'}]});
 const extra={fastRows:[row],artist:'Test & Guest',recordingProvider:'spotify',creditedArtistNames:['Test','Guest']};
 const ctx=context([],{123:{hex:bilingualQRC.group,fields:{singerName:'Test (테스트) & Guest (嘉宾)'}}},extra);
 const song=await search(ctx);assert.deepEqual(song.creditedArtistNames,['Test','Guest']);assert.equal(song.lyricsData.lines.length,2);
 const partial=context([],{123:{hex:bilingualQRC.group,fields:{singerName:'Test (테스트)'}}},extra);await assert.rejects(search(partial),{code:'recording_mismatch'});
});
test('QQ serialized or legacy labels cannot manufacture fresh display-label authority',async()=>{
 const row=candidate('123',{songname:'Blueming',detailTitle:'Blueming',singer:[{id:1,mid:'00000000000001',name:'IU',title:'IU (아이유)'}]});
 const options={artist:'IU',title:'Blueming'},settings={hex:bilingualQRC.iu,fields:{songName:'',singerName:''}};
 const fresh=context([row],{123:settings},options),value=await new QQMusicAPI().getRecording('123',fresh);
 const serialized=JSON.parse(JSON.stringify(value.song));delete serialized.lyricsData;
 await assert.rejects(new QQMusicAPI().getLyrics('123',{...context([row],{123:settings},options),song:serialized}),{code:'recording_mismatch'});
 const legacy=context([row],{123:settings},options);await assert.rejects(search(legacy),{code:'recording_mismatch'});
});
test('QQ display translation never erases primary versions, alternate guest credits or malformed artist titles',async()=>{
 const version=candidate('123',{songname:'Synthetic (Live)',detailTitle:'Synthetic'}),ctx=context([candidate()],{}, {fastRows:[version]});
 await assert.rejects(search(ctx),{code:'recording_mismatch'});
 for(const title of [{},'x'.repeat(1025),'bad\u0000label']) {
  const raw=candidate('123',{singer:[{id:1,mid:'00000000000001',name:'Test',title}]});
  await assert.rejects(new QQMusicAPI().getRecording('123',context([raw])),{code:'recording_mismatch'});
 }
});

test('QQ fast discovery hydrates every bounded suggestion in one fresh metadata/QRC batch',async()=>{
 const rows=[candidate(),candidate('124',{songname:'Other'}),candidate('125',{interval:150})],ctx=context([],{}, {fastRows:rows});
 const song=await search(ctx);assert.equal(song.id,'123');assert.equal(song.lyricsData.timingSource.source,'qq:123:qrc');assert.equal(ctx.calls.length,2);
 const [lookup,batch]=ctx.calls;assert.equal(lookup.url.pathname,'/splcloud/fcgi-bin/smartbox_new.fcg');assert.equal(lookup.url.searchParams.get('key'),'Synthetic Test');
 assert.equal(lookup.url.searchParams.get('format'),'json');assert.equal(lookup.url.searchParams.get('is_xml'),'0');
 assert.deepEqual(Object.keys(batch.payload).sort(),['comm','details_123','details_124','details_125','lyric_123','lyric_124','lyric_125']);
 for(const row of rows){assert.deepEqual(batch.payload[`details_${row.songid}`].param,{song_id:row.songid});assert.equal(batch.payload[`lyric_${row.songid}`].param.songId,row.songid);assert.equal(batch.payload[`lyric_${row.songid}`].param.qrc,1);}
 assert.ok(ctx.calls.every(c=>c.init.redirect==='error'&&c.init.size===524288));
 assert.equal(ctx.calls.some(c=>c.url.pathname.endsWith('client_search_cp')),false);
});
test('QQ fast path validates every best tie and excludes neither fourth nor later suggested editions',async()=>{
 const rows=Array.from({length:7},(_,i)=>candidate(String(123+i))),ctx=context([],{}, {fastRows:rows});
 assert.equal((await search(ctx)).id,'123');assert.equal(ctx.calls.length,2);assert.equal(Object.keys(ctx.calls[1].payload).length,15);
 const conflict=context([candidate()],{129:{hex:f.providerCueConflict}}, {fastRows:rows});
 await assert.rejects(search(conflict),{code:'recording_mismatch'});assert.equal(conflict.calls.length,3);
});
test('QQ legacy fallback cannot hide a previously discovered equal-rank text or cue conflict',async()=>{
 for(const hex of [f.providerWordConflict,f.providerCueConflict]) {
  const ctx=context([candidate()],{124:{hex}}, {fastRows:[candidate(),candidate('124')]});
  await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
  assert.equal(ctx.calls[2].url.pathname,'/soso/fcgi-bin/client_search_cp');assert.equal(ctx.calls.filter(c=>c.payload?.req).length,0);
 }
});
test('QQ fallback retains source identity failures and does not retry the same poisoned measured response',async()=>{
 const ctx=context([candidate()],{123:{fields:{songID:999}}},{fastRows:[candidate()]});
 await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);assert.equal(ctx.calls.filter(c=>c.payload?.req).length,0);
});
test('QQ fallback can recover a strictly better metadata winner while retaining lower-rank conflicts',async()=>{
 const older=[candidate('123',{albumname:'Other'}),candidate('124',{albumname:'Other'})];
 const ctx=context([candidate('125')],{124:{hex:f.providerWordConflict}},{fastRows:older});
 const result=await search(ctx);assert.equal(result.id,'125');assert.equal(result.lyricsData.timingSource.source,'qq:125:qrc');assert.equal(ctx.calls.length,4);
 assert.equal(ctx.calls[3].payload.req.param.songId,125);
});
test('QQ full detail title preserves remix/live/acoustic versions through source hints and legacy fallback',async()=>{
 for(const detailTitle of ['Synthetic (Remix)','Synthetic (Live)','Synthetic (Acoustic)','Synthetic (feat. Guest)']) {
  const row=candidate('123',{detailTitle}),ctx=context([candidate()],{}, {fastRows:[row]});
  await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
  const fresh=context([row]);await assert.rejects(new QQMusicAPI().getRecording('123',fresh),{code:'recording_mismatch'});assert.equal(fresh.calls.length,1);
 }
 const invalid=context(),normal=invalid.fetchFn;invalid.fetchFn=async(url,init)=>{const r=await normal(url,init),j=await r.json();j.details.data.track_info.name={};return answer(j,url);};
 await assert.rejects(new QQMusicAPI().getRecording('123',invalid),{code:'recording_mismatch'});
});
test('QQ fast discovery rejects absent album only when a potentially eligible source remains unresolved',async()=>{
 const remix=candidate('124',{albumid:0,albummid:'',albumname:'',detailTitle:'Synthetic (Remix)'});
 const good=context([],{}, {fastRows:[candidate(),remix]});assert.equal((await search(good)).id,'123');assert.equal(good.calls.length,2);
 const unresolved=context([candidate()],{}, {fastRows:[candidate('123',{albumid:0,albummid:'',albumname:''})]});
 await assert.rejects(search(unresolved),{code:'recording_mismatch'});assert.equal(unresolved.calls.length,3);
});
test('QQ smartbox over-cap or malformed suggestions use the complete legacy route without truncation',async()=>{
 const over=context([candidate()],{}, {fastRows:Array.from({length:11},(_,i)=>candidate(String(123+i)))});
 assert.equal((await search(over)).id,'123');assert.equal(over.calls.length,3);assert.equal(over.calls[1].url.pathname,'/soso/fcgi-bin/client_search_cp');
 const wrong=context(),normal=wrong.fetchFn;wrong.fetchFn=async(url,init)=>{const r=await normal(url,init),j=await r.json();if(new URL(url).pathname.endsWith('smartbox_new.fcg'))j.data.song.count=1;return answer(j,url);};
 assert.equal((await search(wrong)).id,'123');assert.equal(wrong.calls.length,3);
});
test('QQ exact hint ID and MID must be freshly echoed before fast results can establish a unique source',async()=>{
 for(const changes of [{detailID:999},{detailMID:'00000000000999'}]) {
  const ctx=context([candidate()],{}, {fastRows:[candidate('123',changes)]});await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
 }
 const contradictory=context([candidate()],{}, {fastRows:[candidate(),candidate('123',{songmid:'00000000000999'})]});
 await assert.rejects(search(contradictory),{code:'recording_mismatch'});assert.equal(contradictory.calls.length,2);
});
test('QQ parent cancellation during the fast batch never starts legacy recovery',async()=>{
 const controller=new AbortController(),ctx=context([],{}, {fastRows:[candidate()],signal:controller.signal}),normal=ctx.fetchFn;
 ctx.fetchFn=async(url,init)=>{if(!init.body)return normal(url,init);controller.abort();throw Object.assign(new Error('cancelled'),{name:'AbortError'});};
 await assert.rejects(search(ctx),{name:'AbortError'});assert.equal(ctx.calls.length,1);
});

test('QQ resolves exact structured metadata with anonymous fixed-origin QRC request and own provenance',async()=>{
 const ctx=context(),song=await search(ctx),api=new QQMusicAPI();
 assert.equal(song.id,'123');assert.equal(song.qqMID,'00000000000123');assert.deepEqual(song.creditedArtistNames,['Test']);assert.equal(song.album,'Example');
 assert.equal(song.lyricsData.source,'qq');assert.equal(song.lyricsData.songId,'123');assert.equal(song.lyricsData.lines.length,2);
 assert.equal(song.lyricsData.timingSource.source,'qq:123:qrc');assert.match(song.lyricsData.timingSource.revision,/^[a-f0-9]{64}$/);
 assert.deepEqual(song.lyricsData.lines[1].vocalTiming.segments,[{utf16Start:0,utf16Length:6,text:'Second',start:1,end:1.5}]);
 assert.equal(ctx.calls.length,3);const [suggestions,lookup,download]=ctx.calls;
 assert.equal(suggestions.url.pathname,'/splcloud/fcgi-bin/smartbox_new.fcg');assert.equal(suggestions.url.searchParams.get('key'),'Synthetic Test');
 assert.equal(lookup.url.origin,'https://c.y.qq.com');assert.equal(lookup.url.pathname,'/soso/fcgi-bin/client_search_cp');assert.equal(lookup.url.searchParams.get('w'),'Test Synthetic');assert.equal(lookup.url.searchParams.get('format'),'json');assert.equal(lookup.url.searchParams.get('n'),'30');
 assert.equal(download.url.origin,'https://u.y.qq.com');assert.equal(download.init.method,'POST');assert.equal(download.payload.req.module,'music.musichallSong.PlayLyricInfo');assert.equal(download.payload.req.method,'GetPlayLyricInfo');
 assert.deepEqual(download.payload.req.param,{songId:123,crypt:1,qrc:1,lrc_t:0,qrc_t:0,roma:0,roma_t:0,trans:0,trans_t:0,needSingingAnnotations:false,type:1});
 assert.equal(download.payload.comm.ct,24);assert.equal(download.payload.comm.cv,4747474);
 assert.ok(ctx.calls.every(c=>c.init.redirect==='error'&&c.init.size===524288&&c.init.headers.Referer==='https://y.qq.com/'));
 assert.equal(api.name,'QQMusicAPI');assert.equal(api.supportsVocalTiming,true);assert.equal(api.languageAgnosticDiscovery,true);assert.ok(api.supportsLanguage('es-MX'));assert.equal(api.supportsLanguage('EN'),false);
 assert.equal(await api.getLyrics('123',{song}),song.lyricsData);assert.equal(await api.getLyrics('124',{song}),null);
});
test('QQ prefers metadata before timing, preserves versions/credits and existing three-second duration limit',async()=>{
 for(const changes of [{songname:'Synthetic (Live)'},{songname:'Synthetic (Remastered)'},{subtitle:'Radio Edit'},
  {singer:[{id:1,mid:'00000000000001',name:'Test'},{id:2,mid:'00000000000002',name:'Guest'}]},
  {interval:124},{explicit:false}]) {
  const ctx=context([candidate('123',changes)],{}, {explicit:true});await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,2);
 }
 const boundary=context([candidate('123',{interval:123})]);assert.equal((await search(boundary)).duration,123);
 const ranked=context([candidate('124',{interval:121}),candidate()]);assert.equal((await search(ranked)).id,'123');assert.equal(ranked.calls.length,3);
 const missing=context(undefined,undefined,{duration:undefined});assert.equal(await search(missing),null);assert.equal(missing.calls.length,0);
});
test('manual QQ discovery preserves original subtitle and all structured singer identities',async()=>{
 const row=candidate('123',{subtitle:'Live',singer:[{id:1,mid:'00000000000001',name:'Earth, Wind & Fire'},{id:2,mid:'00000000000002',name:'Guest'}]});
 const ctx=context([row]),result=await new QQMusicAPI().searchLyrics('Synthetic',ctx);
 assert.equal(result[0].title,'Synthetic (Live)');assert.equal(result[0].providerTitle,'Synthetic');assert.equal(result[0].subtitle,'Live');
 assert.deepEqual(result[0].creditedArtistNames,['Earth, Wind & Fire','Guest']);assert.equal(ctx.calls.length,1);
});
test('QQ Spotify matching uses complete credits and rejects explicit conflicts',async()=>{
 for(const changes of [{singer:[{id:1,mid:'00000000000001',name:'Test'},{id:2,mid:'00000000000002',name:'Guest'}]},{explicit:false},{songname:'Synthetic (Clean)'}]) {
  const ctx=context([candidate('123',changes)],{}, {recordingProvider:'spotify',creditedArtistNames:['Test'],explicit:true});await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,2);
 }
 assert.equal((await search(context([candidate()],{}, {recordingProvider:'spotify',creditedArtistNames:['Test']}))).id,'123');
});
test('all best QQ ties need exact cleaned text and measured-cue consensus, including ties beyond three',async()=>{
 const ctx=context(Array.from({length:7},(_,i)=>candidate(String(123+i))));assert.equal((await search(ctx)).id,'123');assert.equal(ctx.calls.length,9);
 for(const hex of [f.providerWordConflict,f.providerCueConflict]) {
  const conflict=context([candidate(),candidate('124')],{124:{hex}});await assert.rejects(search(conflict),{code:'recording_mismatch'});
 }
});
test('proved QQ tie conflict immediately aborts hanging peer work and cleans the parent listener',async()=>{
 const parent=new AbortController(),ctx=context([candidate(),candidate('124'),candidate('125')],{124:{hex:f.providerWordConflict}}, {signal:parent.signal});
 const normal=ctx.fetchFn;let peerAborted=false;
 ctx.fetchFn=async(url,init)=>{
  if(init.body&&JSON.parse(init.body).req.param.songId===125)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{peerAborted=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));},{once:true}));
  return normal(url,init);
 };
 await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(peerAborted,true);assert.equal(parent.signal.aborted,false);assert.equal(getEventListeners(parent.signal,'abort').length,0);
});
test('proved QQ conflict returns promptly even if a peer transport ignores cancellation',{timeout:1000},async()=>{
 const ctx=context([candidate(),candidate('124'),candidate('125')],{124:{hex:f.providerCueConflict}}),normal=ctx.fetchFn;
 let releasePeer,peerSignal;
 ctx.fetchFn=async(url,init)=>{
  if(init.body&&JSON.parse(init.body).req.param.songId===125){peerSignal=init.signal;return new Promise(resolve=>{releasePeer=()=>resolve(answer({code:0,req:{code:24001}},url));});}
  return normal(url,init);
 };
 try{await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(peerSignal.aborted,true);assert.equal(typeof releasePeer,'function');}
 finally{releasePeer?.();}
});
test('QQ parent abort relays to local workers without starting fallback or retaining listeners',async()=>{
 const parent=new AbortController(),ctx=context([candidate()],{}, {signal:parent.signal}),normal=ctx.fetchFn;let downloads=0;
 ctx.fetchFn=async(url,init)=>{
  if(!init.body)return normal(url,init);downloads++;
  return new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true});parent.abort();});
 };
 await assert.rejects(search(ctx),{name:'AbortError'});assert.equal(downloads,1);assert.equal(getEventListeners(parent.signal,'abort').length,0);
});
test('QQ wrong echoed ID, title, singer or embedded source headers are hard identity failures',async()=>{
 for(const settings of [{fields:{songID:124}},{fields:{songName:'Synthetic (Live)'}},{fields:{singerName:'Other'}},{hex:f.providerTitleConflict},{hex:f.providerArtistConflict}]) {
  const ctx=context([candidate()],{123:settings});await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
 }
});
test('QQ name echoes are optional informational strings, while the numeric source ID remains mandatory',async()=>{
 for(const fields of [{songName:'',singerName:''},{songName:undefined,singerName:undefined},{songName:' Synthetic ',singerName:' Test '}])
  assert.equal((await search(context([candidate()],{123:{fields}}))).id,'123');
 for(const fields of [{songID:undefined,songName:'',singerName:''},{songName:null},{singerName:42},{songName:'x'.repeat(1001)}]) {
  const ctx=context([candidate()],{123:{fields}});await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
 }
});
test('QQ recognizes only the observed informational Grammy descriptor, preserving catalog edition and raw labels',async()=>{
 const rows=[candidate('123',{songname:'Viva la Vida',albumname:'Viva la Vida',interval:241,singer:[{id:1,mid:'00000000000001',name:'Coldplay'}]})];
 const extra={artist:'Coldplay',title:'Viva la Vida',album:'Viva la Vida',duration:241};
 for(const hex of [f.providerAwardQRC,f.providerFullwidthAwardQRC]) {
  const ctx=context(rows,{123:{hex,fields:{songName:'',singerName:''}}},extra),song=await search(ctx);
  assert.equal(song.title,'Viva la Vida');assert.equal(song.album,'Viva la Vida');
  assert.equal(song.lyricsData.lines[0].text,'First');assert.equal(song.lyricsData.timingSource.source,'qq:123:qrc');
  assert.ok(song.lyricsData.providerLyricLabels.some(l=>l.kind==='ti'&&l.value.includes('51届格莱美获奖歌曲')));
  assert.ok(song.lyricsData.providerLyricLabels.some(l=>l.kind==='al'&&l.value==='2009 GRAMMY Nominees'));
 }
 for(const hex of f.providerBadTitleQRC) {
  const ctx=context(rows,{123:{hex,fields:{songName:'',singerName:''}}},extra);await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,3);
 }
});
test('absent or invalid QRC uses bounded same-ID encrypted LRC fallback without manufactured word provenance',async()=>{
 for(const settings of [{hex:''},{hex:'invalid'},{hex:f.invalidUTF8Hex},{hex:f.expansionHex},{fields:{qrc:0}}]) {
  const ctx=context([candidate()],{123:settings}),normal=ctx.fetchFn;
  if(settings.fields)ctx.fetchFn=async(url,init)=>{if(init.body&&JSON.parse(init.body).req.param.qrc===0){const old=settings.fields;delete settings.fields;const response=await normal(url,init);settings.fields=old;return response;}return normal(url,init);};
  const song=await search(ctx);assert.deepEqual(song.lyricsData.lines.map(l=>[l.text,l.timestamp]),[['First',0],['Second',1]]);assert.equal(song.lyricsData.timingSource,undefined);assert.ok(song.lyricsData.lines.every(l=>!l.vocalTiming));assert.equal(ctx.calls.length,4);
  assert.deepEqual(ctx.calls.filter(c=>c.payload).map(c=>c.payload.req.param.qrc),[1,0]);
 }
});
test('QQ fresh numeric source lookup batches exact details and QRC and validates both IDs before use',async()=>{
 const ctx=context(),value=await new QQMusicAPI().getRecording('123',ctx);assert.equal(value.song.id,'123');assert.equal(value.lyrics.timingSource.source,'qq:123:qrc');
 assert.equal(ctx.calls.length,1);assert.equal(ctx.calls[0].payload.details.method,'get_song_detail_yqq');assert.deepEqual(ctx.calls[0].payload.details.param,{song_id:123});
 assert.equal(ctx.calls[0].payload.lyric.method,'GetPlayLyricInfo');assert.equal(ctx.calls[0].payload.lyric.param.songId,123);assert.equal(ctx.calls[0].payload.lyric.param.qrc,1);
 const wrong=context([candidate('124')]);await assert.rejects(new QQMusicAPI().getRecording('123',wrong),{code:'recording_mismatch'});assert.equal(wrong.calls.length,1);
 const version=context([candidate('123',{songname:'Synthetic (Live)'})]);await assert.rejects(new QQMusicAPI().getRecording('123',version),{code:'recording_mismatch'});
 const wrongLyric=context([candidate()],{123:{fields:{songID:124}}});await assert.rejects(new QQMusicAPI().getRecording('123',wrongLyric),{code:'recording_mismatch'});assert.equal(wrongLyric.calls.length,1);
 for(const title of [{},'x'.repeat(501),'bad\u0000title']) {
  const invalid=context(),normal=invalid.fetchFn;invalid.fetchFn=async(url,init)=>{const response=await normal(url,init),j=await response.json();j.details.data.track_info.title=title;return answer(j,url);};
  await assert.rejects(new QQMusicAPI().getRecording('123',invalid),{code:'recording_mismatch'});
 }
});
test('QQ metadata and response bounds reject poisoned IDs, unsupported shapes and redirects',async()=>{
 for(const rows of [[candidate('123',{songid:'001'})],[candidate('123',{songmid:'../other'})],[candidate('123',{singer:[]})],[candidate('123',{interval:'120'})],Array.from({length:101},(_,i)=>candidate(String(i+1)))]) {
  const ctx=context(rows);const result=search(ctx);if(rows.length>100)await assert.rejects(result);else assert.equal(await result,null);assert.equal(ctx.calls.length,2);
 }
 const duplicate=context([candidate(),candidate('123',{songname:'Other'})]);await assert.rejects(search(duplicate),{code:'recording_mismatch'});
 for(const response of [new Response(Buffer.alloc(524289,65)),new Response(Buffer.from([0xc3,0x28])),{ok:true,status:200,url:'https://elsewhere.invalid/x',headers:new Map(),json:async()=>({code:0})}]) {
  const ctx=context();ctx.fetchFn=async()=>response;await assert.rejects(search(ctx),/QQ provider unavailable/);
 }
});
test('QQ does not forward account headers and sanitizes transport errors and pre-aborted requests',async()=>{
 const ctx=context(undefined,undefined,{headers:{Authorization:'Bearer do-not-send',Cookie:'do-not-send'}});await search(ctx);assert.ok(ctx.calls.every(c=>!c.init.headers.Authorization&&!c.init.headers.Cookie));
 const failed=context();failed.fetchFn=async url=>{throw new Error('network '+url+' response body secret');};await assert.rejects(search(failed),e=>e.message==='QQ provider unavailable');
 const ctl=new AbortController();ctl.abort();const cancelled=context(undefined,undefined,{signal:ctl.signal});await assert.rejects(search(cancelled),{name:'AbortError'});assert.equal(cancelled.calls.length,0);
});
