import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {createDeveloperToken,createAppleCatalog} from '../../api/utils/apple-catalog.js';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const credentials={teamID:'TEAM123456',keyID:'KEY1234567',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})};
test('server token is a short-lived ES256 signature with no user token',()=>{
 const token=createDeveloperToken(credentials,1000000),[header,payload,signature]=token.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',kid:credentials.keyID});
 assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iss:credentials.teamID,iat:1000,exp:2800});
 assert.ok(verify('sha256',Buffer.from(header+'.'+payload),{key:keys.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));
 assert.equal(createAppleCatalog({}),null);
});
test('catalog requests negotiate supported language tags, cache metadata and rotate tokens',async()=>{
 const calls=[];let now=1000000;
 const fetchFn=async(url,init)=>{
  calls.push({url,authorization:init.headers.Authorization});
  assert.equal(init.headers['Music-User-Token'],undefined);
  if(url.includes('/storefronts/'))return {ok:true,json:async()=>({data:[{attributes:{defaultLanguageTag:'ja-JP',supportedLanguageTags:['ja-JP','en-US']}}]})};
  const title=new URL(url).searchParams.get('l')==='en-US'?'English title':'日本の歌';
  return {ok:true,json:async()=>({data:[{id:'123',type:'songs',attributes:{name:title,artistName:'Artist',albumName:'Album',durationInMillis:220000,isrc:'USABC2300001'},relationships:{artists:{data:[{id:'42',type:'artists',attributes:{name:'Earth, Wind & Fire'}}]}}}]})};
 };
 const catalog=createAppleCatalog({...credentials,fetchFn,now:()=>now});
 const songs=await catalog.lookup('123','jp');assert.equal(songs.length,2);
 assert.deepEqual(songs[0].artist_ids,['42']);assert.deepEqual(songs[0].artist_entities,[{id:'42',name:'Earth, Wind & Fire'}]);assert.equal(songs[0].duration,220);
 await catalog.lookup('123','jp');assert.equal(calls.length,3);
 now+=1500001;await catalog.byISRC('USABC2300001','jp');
 assert.notEqual(calls[0].authorization,calls.at(-1).authorization);
 assert.deepEqual(new Set(calls.filter(c=>c.url.includes('/songs?')).map(c=>new URL(c.url).searchParams.get('l'))),new Set(['ja-JP','en-US']));
});
test('localization discovery failure still permits catalog lookup',async()=>{
 const catalog=createAppleCatalog({...credentials,fetchFn:async url=>({ok:!url.includes('/storefronts/'),status:403,json:async()=>({data:[]})})});
 assert.deepEqual(await catalog.lookup('123','ca'),[]);
});
