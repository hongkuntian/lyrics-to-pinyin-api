import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newRoom,applyCommand,roomDTO,observeApple,observeSpotify} from '../../api/utils/listening/model.js';
const host={id:'host',keyID:'key',credentialDigest:'credential'};
const guest={id:'guest',keyID:'guest-key',credentialDigest:'guest-credential'};
const song=n=>({provider:'appleMusic',id:String(n),title:'Song '+n,artist:'Artist',album:'Album',durationMS:180000,artworkURL:null});
function fixture(provider='appleMusic') {
 const room=newRoom(host,{sessionID:randomUUID(),provider,title:'Friday night',name:'Host',shareName:true,storefront:'us'},1000);
 applyCommand(room,guest,{action:'join',name:'UnsharedGuestName',shareName:false},1100);
 const add=n=>applyCommand(room,guest,{action:'add',revision:room.revision,entryID:randomUUID(),track:{...song(n),provider}},1200);
 return {room,add};
}
test('guests collaborate on upcoming occurrences, while host alone controls audio and end',()=>{
 const {room,add}=fixture();add(1);add(2);add(1);
 assert.equal(new Set(room.entries.map(e=>e.id)).size,3);
 const ids=room.entries.map(e=>e.id);
 applyCommand(room,guest,{action:'reorder',revision:room.revision,order:[ids[2],ids[0],ids[1]]},1300);
 assert.deepEqual(room.entries.map(e=>e.id),[ids[2],ids[0],ids[1]]);
 assert.throws(()=>applyCommand(room,guest,{action:'end',revision:room.revision},1400),{code:'host_required'});
 applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:randomUUID()},1500);
 assert.throws(()=>applyCommand(room,guest,{action:'remove',revision:room.revision,entryID:ids[2]},1600),{code:'upcoming_only'});
});
test('stale revisions, non-permutations and outsiders cannot change a room',()=>{
 const {room,add}=fixture();add(1);add(2);const before=structuredClone(room);
 assert.throws(()=>applyCommand(room,guest,{action:'remove',revision:0,entryID:room.entries[0].id},1300),{code:'session_revision_changed'});
 assert.throws(()=>applyCommand(room,guest,{action:'reorder',revision:room.revision,order:[room.entries[0].id,room.entries[0].id]},1300),{code:'invalid_queue_order'});
 assert.throws(()=>applyCommand(room,{id:'outsider'},{action:'add',revision:room.revision,entryID:randomUUID(),track:song(3)},1300),{code:'session_not_found'});
 assert.deepEqual(room,before);
});
test('history requires exact observed playing occurrence; skipped and queued songs are not played',()=>{
 const {room,add}=fixture();add(1);add(2);add(1);
 const lease=randomUUID();applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:lease},1400);
 const observation={leaseID:lease,sequence:1,entryID:room.entries[0].id,trackID:'1',positionMS:1000,playing:false};
 observeApple(room,host,observation,1500);assert.equal(room.history.length,0);
 observeApple(room,host,{...observation,sequence:2,playing:true},1600);assert.equal(room.history.length,1);
 observeApple(room,host,{...observation,sequence:3,entryID:room.entries[2].id,playing:true},1700);
 assert.deepEqual(room.history.map(h=>h.entryID),[room.entries[0].id,room.entries[2].id]);
 assert.throws(()=>observeApple(room,host,{...observation,sequence:4,trackID:'999',playing:true},1800),{code:'recording_changed'});
 assert.throws(()=>observeApple(room,host,{...observation,sequence:4,leaseID:randomUUID()},1800),{code:'session_playback_replaced'});
 assert.equal(room.history.length,2);
});
test('owner device and monotonic observation sequence fence stale reports',()=>{
 const {room,add}=fixture();add(1);const lease=randomUUID();applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:lease},1300);
 const o={leaseID:lease,sequence:1,entryID:room.entries[0].id,trackID:'1',positionMS:1000,playing:true};
 observeApple(room,host,o,1400);observeApple(room,host,{...o,positionMS:0},1500);
 assert.equal(room.playback.positionMS,1000);
 assert.throws(()=>observeApple(room,{...host,keyID:'another-device'},{...o,sequence:2},1600),{code:'host_device_required'});
});
test('private DTOs omit identity credentials; public recaps honor name consent and require ending',()=>{
 const {room,add}=fixture();add(1);const lease=randomUUID();applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:lease},1300);
 observeApple(room,host,{leaseID:lease,sequence:1,entryID:room.entries[0].id,trackID:'1',positionMS:1000,playing:true},1400);
 const dto=roomDTO(room,guest);assert.equal(dto.isHost,false);assert(!JSON.stringify(dto).includes('credential'));assert(!JSON.stringify(dto).includes('guest-key'));
 assert.throws(()=>roomDTO(room,null,{publicRecap:true}),{code:'session_not_shared'});
 applyCommand(room,host,{action:'end',revision:room.revision},1500);room.shared=true;
 const recap=roomDTO(room,null,{publicRecap:true});assert.equal(recap.history[0].contributorName,'Friend');
 assert(!JSON.stringify(recap).includes('UnsharedGuestName'));
 assert.equal(recap.inviteCode,undefined);assert.equal(recap.queue,undefined);assert.equal(recap.viewerID,undefined);
});
test('Spotify duplicate occurrences use exact remaining queue, not URI or a guessed clock',()=>{
 const {room,add}=fixture('spotify');add('aaaaaaaaaaaaaaaaaaaaaa');add('aaaaaaaaaaaaaaaaaaaaaa');add('bbbbbbbbbbbbbbbbbbbbbb');
 room.providerState.playlistID='pppppppppppppppppppppp';room.providerState.deviceID='device';
 applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:randomUUID()},1300);
 room.providerState.appliedRevision=room.revision;room.providerState.appliedOrder=room.entries.map(e=>e.id);
 const sample=(position,queue)=>({contextURI:'spotify:playlist:pppppppppppppppppppppp',deviceID:'device',trackID:'aaaaaaaaaaaaaaaaaaaaaa',positionMS:position,playing:true,queue});
 observeSpotify(room,sample(179000,['aaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbb']),1,1400);
 assert.equal(room.history[0].entryID,room.entries[0].id);
 observeSpotify(room,sample(1000,['bbbbbbbbbbbbbbbbbbbbbb']),2,1500);
 assert.equal(room.history[1].entryID,room.entries[1].id);
 observeSpotify(room,sample(0,['bbbbbbbbbbbbbbbbbbbbbb']),3,1600);assert.equal(room.history.length,2);
 observeSpotify(room,{...sample(0,[]),contextURI:'spotify:playlist:unrelated'},4,1700);
 assert.equal(room.history.length,2);assert.equal(room.playback.state,'detached');
});
test('a uniquely observed retired Spotify occurrence recovers its contributor without replaying skipped picks',()=>{
 const {room,add}=fixture('spotify'),A='a'.repeat(22),X='x'.repeat(22),B='b'.repeat(22),C='c'.repeat(22);
 for(const id of [A,X,B,C])add(id);
 const ids=room.entries.map(e=>e.id);
 applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:randomUUID()},1300);
 Object.assign(room.providerState,{playlistID:'p',deviceID:'phone',appliedRevision:room.revision,appliedOrder:ids.slice()});
 const sample=(id,queue)=>({contextURI:'spotify:playlist:p',deviceID:'phone',trackID:id,positionMS:1000,playing:true,queue});
 observeSpotify(room,sample(A,[X,B,C]),1,1400);
 applyCommand(room,guest,{action:'remove',revision:room.revision,entryID:ids[2]},1500);
 Object.assign(room.providerState,{appliedRevision:room.revision,appliedOrder:room.entries.map(e=>e.id),syncPending:false,nativeQueuePending:true});
 observeSpotify(room,sample(B,[C]),2,1600);
 assert.deepEqual(room.history.map(h=>h.track.id),[A,B]);assert.equal(room.history[1].contributorID,room.members[1].id);
 assert.deepEqual(room.entries.map(e=>e.id),ids);assert.equal(room.playback.entryID,ids[2]);assert(room.providerState.syncPending);
});
test('retired/active duplicate identity and indistinguishable long suffixes remain unconfirmed',()=>{
 const {room,add}=fixture('spotify'),A='a'.repeat(22),B='b'.repeat(22),C='c'.repeat(22);
 for(const id of [A,B,B,C])add(id);
 const ids=room.entries.map(e=>e.id);
 applyCommand(room,host,{action:'begin',revision:room.revision,leaseID:randomUUID()},1300);
 Object.assign(room.providerState,{playlistID:'p',deviceID:'phone',appliedRevision:room.revision,appliedOrder:ids.slice()});
 observeSpotify(room,{contextURI:'spotify:playlist:p',deviceID:'phone',trackID:A,positionMS:1000,playing:true,queue:[B,B,C]},1,1400);
 applyCommand(room,guest,{action:'remove',revision:room.revision,entryID:ids[1]},1500);
 Object.assign(room.providerState,{appliedRevision:room.revision,appliedOrder:room.entries.map(e=>e.id),syncPending:false});
 observeSpotify(room,{contextURI:'spotify:playlist:p',deviceID:'phone',trackID:B,positionMS:1000,playing:true,queue:[C]},2,1600);
 assert.equal(room.playback.state,'unconfirmed');assert.equal(room.history.length,1);
 const long=fixture('spotify');for(let i=0;i<24;i++)long.add(B);
 applyCommand(long.room,host,{action:'begin',revision:long.room.revision,leaseID:randomUUID()},1300);
 Object.assign(long.room.providerState,{playlistID:'p',deviceID:'phone',appliedRevision:long.room.revision,appliedOrder:long.room.entries.map(e=>e.id)});
 observeSpotify(long.room,{contextURI:'spotify:playlist:p',deviceID:'phone',trackID:B,positionMS:1000,playing:true,queue:Array(20).fill(B)},1,1400);
 assert.equal(long.room.playback.state,'unconfirmed');assert.equal(long.room.history.length,0);
});
