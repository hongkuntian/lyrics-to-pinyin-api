import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createArtistIdentityResolver,validArtistIdentity} from '../../api/utils/artist-identities.js';
import {buildArtistIdentityEvidence} from '../../api/utils/artist-alias-recovery.js';
import {recordingScore} from '../../api/utils/recording-match.js';
import {spotifySearchRequest} from '../../api/utils/song-library/spotify-recording.js';
import {qqIdentityFixture} from '../helpers/qq-artist-identity.js';
import {claim,artistIDs} from '../helpers/artist-identities.js';

test('QQ identity snapshots bind nondeprecated valid singer MIDs and preserve historical NetEase snapshots',async()=>{
 const fixture=qqIdentityFixture(),[identity]=await fixture.resolve([artistIDs[0]]);
 assert.deepEqual(identity.qqSingerMIDs,[fixture.detail.singer[0].mid]);
 assert.equal(validArtistIdentity({...identity,qqSingerMIDs:['00000000000000']}),false);
 const old={...identity,version:1,policy:'wikidata-artist-identities-1'};delete old.qqSingerMIDs;
 old.fingerprint=createHash('sha256').update(JSON.stringify([old.policy,old.spotifyArtistID,old.entityID,old.entityRevision,old.names,old.neteaseArtistIDs])).digest('hex');
 assert.equal(validArtistIdentity(old),true);
 for(const value of ['bad','ABCDEFGHIJKLMN','123456789012345']) {
  const row=qqIdentityFixture();row.entity.claims.P10410=[claim(value)];
  assert.deepEqual(await row.resolve([artistIDs[0]]),[]);
 }
 const row=qqIdentityFixture();row.entity.claims.P10410[0].rank='deprecated';
 assert.deepEqual((await row.resolve([artistIDs[0]]))[0].qqSingerMIDs,[]);
});

for(const row of [
 {itemID:'5pIcwtJYNJx93l420oR2Vm',title:'晴天',sourceTitle:'晴天',album:'葉惠美',sourceAlbum:'叶惠美',duration:269.746,sourceDuration:269,id:'97773'},
 {itemID:'77jIEebt4z9WzaI6LsntDG',title:'不能說的秘密',sourceTitle:'不能说的秘密',album:'不能說的秘密 電影原聲帶',sourceAlbum:'不能说的秘密 电影原声带',duration:296.533,sourceDuration:296,id:'403778'},
])test(`${row.title}: exact Spotify and QQ artist IDs authorize names only`,async()=>{
 const fixture=qqIdentityFixture(),spotifyID='2elBjNSdBE2Y3f0j1mjrql';
 fixture.entity.labels={en:{value:'Jay Chou'},native:{value:'周杰伦'}};fixture.entity.claims.P1902=[claim(spotifyID)];fixture.catalog.rows[0].spotify.value=spotifyID;
 const identities=await createArtistIdentityResolver({fetchFn:fixture.catalog.fetchFn})([spotifyID]);
 const song={source:'qq',id:row.id,title:row.sourceTitle,artist:'周杰伦',album:row.sourceAlbum,duration:row.sourceDuration,creditedArtistNames:['周杰伦'],creditedArtistIDs:['4558'],creditedArtistMIDs:[fixture.detail.singer[0].mid]};
 const target={recordingProvider:'spotify',recordingItemID:row.itemID,title:row.title,artist:'Jay Chou',album:row.album,duration:row.duration,creditedArtistNames:['Jay Chou'],creditedArtistIDs:[spotifyID]};
 const performers=[{id:'4558',mid:song.creditedArtistMIDs[0],name:'周杰伦'}],profiles=new Map(),proof=buildArtistIdentityEvidence(song,performers,target,profiles,identities);
 assert.ok(proof);assert.equal(recordingScore(song,target),-1);assert.ok(recordingScore({...song,artistAliasEvidence:proof},target)>=0);
 for(const changed of [{title:row.sourceTitle+' (Live)'},{album:'Other'},{duration:row.duration+4},{isrc:'USABC2600001'},{explicit:true},{creditedArtistNames:['周杰伦','Guest']},{creditedArtistMIDs:['00000000000000']}])
  assert.equal(buildArtistIdentityEvidence({...song,...changed},performers,{...target,isrc:'USABC2600002',explicit:false},profiles,identities),null,JSON.stringify(changed));
 for(const mutate of [value=>{value.source.artistMIDs=['00000000000000'];},value=>{value.performers[0].mid='00000000000000';},value=>{value.performers[0].id='7';},value=>{value.performers[0].identity.qqSingerMIDs=[];},value=>{value.request.itemID='0123456789ABCDEFGHIJKL';}]) {
  const changed=structuredClone(proof);mutate(changed);assert.equal(recordingScore({...song,artistAliasEvidence:changed},target),-1);
 }
 const old=structuredClone(identities[0]);delete old.qqSingerMIDs;
 assert.equal(buildArtistIdentityEvidence(song,performers,target,profiles,[old]),null);
});

test('QQ recovers fresh details once and supports exact source reload',async()=>{
 const fixture=qqIdentityFixture(),target=spotifySearchRequest(fixture.recording);let lookups=0;
 const context={...target,resolveArtistIdentities:async()=>{lookups++;return fixture.resolve(target.creditedArtistIDs);}};
 const song=await fixture.api.searchSong(target.artist,target.title,context);
 assert.ok(song.artistAliasEvidence);assert.equal(song.artist,'Test');assert.equal(song.lyricsData.timingSource.source,'qq:123:qrc');assert.equal(lookups,1);
 assert.ok((await fixture.api.getRecording('123',context)).song.artistAliasEvidence);
 for(const mutate of [row=>{row.entity.claims.P10410=[];},row=>{row.entity.claims.P10410=[claim('00000000000000')];},row=>{row.entity.claims.P10410[0].rank='deprecated';},row=>{row.detail.singer.push({id:2,mid:'00000000000002',name:'Guest'});},row=>{row.detail.album.name='Other';}]) {
  const row=qqIdentityFixture();mutate(row);
  await assert.rejects(row.api.searchSong(target.artist,target.title,{...target,resolveArtistIdentities:()=>row.resolve(target.creditedArtistIDs)}),{code:'recording_mismatch'});
 }
 const ordinary=qqIdentityFixture(),exact={...target,artist:'Test',creditedArtistNames:['Test'],resolveArtistIdentities:()=>assert.fail('matching credits need no identity lookup')};
 assert.equal((await ordinary.api.searchSong('Test',target.title,exact)).id,'123');
});

test('QQ legacy discovery requires exact fresh detail before artist recovery',async()=>{
 const fixture=qqIdentityFixture(),target=spotifySearchRequest(fixture.recording);fixture.legacyOnly();let lookups=0;
 const context={...target,resolveArtistIdentities:async()=>{lookups++;return fixture.resolve(target.creditedArtistIDs);}};
 const song=await fixture.api.searchSong(target.artist,target.title,context);
 assert.equal(song.id,'123');assert.ok(song.artistAliasEvidence);assert.equal(lookups,1);
 assert.equal(fixture.calls.filter(url=>url.includes('musicu.fcg')).length,2);
 for(const mutate of [value=>({...value,id:124}),value=>({...value,mid:'00000000000124'}),value=>({...value,singer:[{id:2,mid:'00000000000002',name:'Test'}]}),value=>({...value,subtitle:'Live'}),value=>({...value,album:{...value.album,name:'Other'}}),value=>({...value,interval:124})]) {
  const row=qqIdentityFixture();row.legacyOnly();row.transformDetail(mutate);
  await assert.rejects(row.api.searchSong(target.artist,target.title,{...target,resolveArtistIdentities:()=>row.resolve(target.creditedArtistIDs)}),{code:'recording_mismatch'});
 }
 const unresolved=qqIdentityFixture();unresolved.legacyOnly();
 await assert.rejects(unresolved.api.searchSong(target.artist,target.title,{...target,resolveArtistIdentities:async()=>[]}),{code:'recording_mismatch'});
 const unknown=qqIdentityFixture();unknown.legacyOnly();
 await assert.rejects(unknown.api.searchSong(target.artist,target.title,target),{code:'recording_mismatch'});
 assert.equal(unknown.calls.length,2);
});
