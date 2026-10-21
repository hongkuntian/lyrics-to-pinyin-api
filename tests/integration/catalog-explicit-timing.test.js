import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {createMockRes} from '../helpers/mock-http.js';
const request={catalog_id:'123',artist:'Test',title:'Synthetic',album:'Example',duration:120,storefront:'us'};
const catalog={kind:'song',trackId:123,artistName:'Test',trackName:'Synthetic',collectionName:'Example',trackTimeMillis:120000};
for(const [rating,expected] of [['explicit',true],['notExplicit',false],['cleaned',false],[undefined,undefined]])test(`Apple source acquisition uses server catalog rating ${rating??'unknown'} without trusting a client flag`,async()=>{
 const calls=[];
 const aliases=(r,c)=>resolveCatalogAliases(r,{...c,appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[{...catalog,trackExplicitness:rating}]})})});
 const api={name:'QQMusicAPI',searchSong:async(a,t,c)=>{calls.push(c.explicit);return {id:42,artist:a,title:t,album:request.album,duration:120};},getLyrics:async(_,c)=>{assert.equal(c.explicit,expected);return {lines:[{text:'Invented words',timestamp:10}]};}};
 const service=createMusicRomanizeService({redis:null,speculativeDiscovery:false,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:aliases,
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,logger:{info(){},error(){}}});
 const res=createMockRes();await service({method:'POST',body:{...request,explicit:true,options:{lyric_sources_version:2}}},res);
 assert.equal(res.statusCode,200);assert.deepEqual(calls,[expected]);
});

test('conflicting verified territory ratings do not grant explicit source authority',async()=>{
 const aliases=await resolveCatalogAliases(request,{appleCatalog:null,fetchFn:async url=>({ok:true,json:async()=>({results:[{...catalog,trackExplicitness:new URL(url).searchParams.get('country')==='us'?'explicit':'notExplicit'}]})})});
 assert.ok(aliases.resolution);assert.equal(aliases.resolution.explicit,undefined);
 assert.ok(aliases.resolution.searches.every(s=>s.explicit===undefined));
});
