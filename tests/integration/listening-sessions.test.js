import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ListeningStore} from '../../api/utils/listening/store.js';
import {ListeningSpotify} from '../../api/utils/listening/spotify.js';
import {scrubListeningAccount} from '../../api/utils/listening/account.js';
import {ListeningService} from '../../api/utils/listening/service.js';
const host={id:'host',keyID:'host-key',credentialDigest:'host-secret'},guest={id:'guest',keyID:'guest-key',credentialDigest:'guest-secret'};
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE library_users(id text PRIMARY KEY,disabled boolean DEFAULT false);CREATE TABLE app_attest_keys(key_id text PRIMARY KEY,user_id text,revoked boolean DEFAULT false);CREATE TABLE library_tokens(digest text PRIMARY KEY,user_id text,revoked boolean DEFAULT false,expires_at timestamptz);INSERT INTO library_users(id) VALUES('host'),('guest');INSERT INTO app_attest_keys VALUES('host-key','host',false),('guest-key','guest',false);INSERT INTO library_tokens(digest,user_id) VALUES('host-secret','host'),('guest-secret','guest');`);
 await db.exec(await readFile(new URL('../../db/029-listening-sessions.sql',import.meta.url),'utf8'));
 const sql={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn)},store=new ListeningStore(sql),messages=new Map();let time=1800000000000,crash=async()=>{};
 const service=new ListeningService({store,now:()=>time,crash:point=>crash(point),enqueue:async(message,options)=>{messages.set(options.idempotencyKey,message);return {messageId:options.idempotencyKey};},catalog:{lookup:async(room,id)=>({provider:room.provider,id,title:'Song '+id,artist:'Artist',album:'Album',durationMS:180000,artworkURL:null}),search:async()=>[]}});
 const create=async(provider='appleMusic')=>service.send(host,{version:1,action:'create',sessionID:randomUUID(),provider,title:'Friday',name:'Host',shareName:true,storefront:'us'});
 return {db,store,service,messages,create,advance:n=>time+=n,setCrash:f=>crash=f};
}
const command=(action,room,extra={})=>({version:1,action,sessionID:room.id,revision:room.revision,commandID:randomUUID(),...extra});
test('real SQL commit retries exactly once and rejects reused command payloads',async t=>{
 const f=await fixture(t),created=await f.create();let room=created.session;
 const join=await f.service.send(guest,{action:'join',invite:room.inviteCode,name:'Friend',shareName:false});room=join.session;
 const input=command('add',room,{trackID:'123'});
 const first=await f.service.send(guest,input),second=await f.service.send(guest,{...input});
 assert.equal(first.session.queue.length,1);assert.equal(second.session.queue.length,1);
 assert.equal((await f.db.query('SELECT count(*) AS n FROM listening_commands')).rows[0].n,1);
 await assert.rejects(f.service.send(guest,{...input,trackID:'999'}),{code:'session_command_conflict'});
 assert.equal((await f.store.read(room.id)).entries[0].track.id,'123');
});
test('concurrent SQL edits preserve one complete revision and never partially reorder',async t=>{
 const f=await fixture(t);let room=(await f.create()).session;
 room=(await f.service.send(host,command('add',room,{trackID:'123'}))).session;
 const a=command('add',room,{trackID:'456'}),b=command('remove',room,{entryID:room.queue[0].id});
 const results=await Promise.allSettled([f.service.send(host,a),f.service.send(host,b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'session_revision_changed');
 const actual=await f.store.read(room.id);assert.equal(actual.revision,2);assert.equal(actual.entries.length,2);
});
test('end freezes private history, share opt-in is revocable and public identity excludes credentials',async t=>{
 const f=await fixture(t);let room=(await f.create()).session;
 room=(await f.service.send(host,command('add',room,{trackID:'123'}))).session;
 room=(await f.service.send(host,command('start',room))).session;
 room=(await f.service.send(host,{action:'observe',sessionID:room.id,leaseID:room.playbackLeaseID,sequence:1,entryID:room.queue[0].id,trackID:'123',positionMS:1000,playing:true})).session;
 room=(await f.service.send(host,command('end',room))).session;
 assert.equal(room.history.length,1);assert.equal(room.shareURL,null);
 room=(await f.service.send(host,command('share',room))).session;
 const token=new URL(room.shareURL).searchParams.get('recap');assert(await f.store.byShare(token));
 room=(await f.service.send(host,command('unshare',room))).session;assert.equal(await f.store.byShare(token),null);
 assert(!JSON.stringify(room).includes('host-secret'));
 await assert.rejects(f.service.send(host,{action:'observe',sessionID:room.id,leaseID:room.playbackLeaseID,sequence:2,entryID:room.queue[0].id,trackID:'123',positionMS:2000,playing:true}),{code:'session_playback_replaced'});
});
test('committed successor survives queue receipt uncertainty and duplicate predecessor drains it',async t=>{
 const f=await fixture(t),room=(await f.create()).session,first=[...f.messages.values()][0];
 f.advance(8*3600000);let once=true;
 f.setCrash(async point=>{if(point==='tickCommitted'&&once){once=false;throw new Error('crash');}});
 await assert.rejects(f.service.tick(first),/crash/);
 await f.service.tick(first);assert.equal((await f.store.read(room.id)).status,'ended');
});
test('one active host room per account, opaque invites, and no outsider reads',async t=>{
 const f=await fixture(t),room=(await f.create()).session;
 await assert.rejects(f.create(),{code:'already_hosting_session'});
 assert.match(new URL(room.inviteURL).searchParams.get('join'),/^[A-Za-z0-9_-]{32}$/);
 await assert.rejects(f.service.send(guest,{action:'read',sessionID:room.id}),{code:'session_not_found'});
 const list=await f.service.send(guest,{action:'list'});assert.equal(list.summaries.length,0);
});

test('environment fences requests, invites, recaps and worker reads',async t=>{
 const f=await fixture(t),room=(await f.create()).session;
 const other=new ListeningStore(f.store.db,'preview');
 assert.equal(await other.read(room.id),null);assert.equal(await other.byInvite(room.inviteCode),null);assert.equal((await other.page(host)).rooms.length,0);
 await assert.rejects(other.mutate(room.id,()=>{}),{code:'session_not_found'});
});
test('polling budget is independent from mutation and catalog budgets',async t=>{
 const f=await fixture(t);
 for(let i=0;i<150;i++)await f.store.rateLimit(host.id,'read');
 await assert.rejects(f.store.rateLimit(host.id,'observe'),{code:'rate_limited'});
 await f.store.rateLimit(host.id,'add');await f.store.rateLimit(host.id,'search');
});
test('account deletion removes owned rooms and anonymizes guest credits in retained histories',async t=>{
 const f=await fixture(t);let room=(await f.create()).session;
 room=(await f.service.send(guest,{action:'join',invite:room.inviteCode,name:'Private Person',shareName:true})).session;
 room=(await f.service.send(guest,command('add',room,{trackID:'123'}))).session;
 await f.store.db.transaction(db=>scrubListeningAccount(db,guest.id));
 const actual=await f.store.read(room.id);assert.equal(actual.members[1].name,'Friend');assert.equal(actual.members[1].shareName,false);assert.equal(actual.members[1].userID,null);
 await f.store.db.transaction(db=>scrubListeningAccount(db,host.id));assert.equal(await f.store.read(room.id),null);
});
test('Spotify guest edit persists and reaches the playlist without a running host app; ticks record only observed songs',async t=>{
 const f=await fixture(t),A='a'.repeat(22),B='b'.repeat(22),C='c'.repeat(22),playlist='p'.repeat(22);
 let saved=[],current=A,position=12000,playing=false,context=null,shuffle=true,repeat='context';const calls=[];
 const connection={id:'connection',status:'connected',scope:['app-remote-control','user-read-playback-state','user-modify-playback-state','playlist-read-private','playlist-modify-private'],expiresAtMS:1900000000000,access:'encrypted'};
 const broker={owned:async()=>connection,credentials:async()=>connection,open:()=> 'fixture-access',store:{ownerValid:async()=>true}};
 f.service.spotify=new ListeningSpotify({broker,fetchFn:async(raw,options)=>{
  const url=new URL(raw),path=url.pathname,method=options.method,body=options.body?JSON.parse(options.body):null;calls.push({path,method,body});
  if(method==='GET'&&path==='/v1/me/player')return Response.json({device:{id:'phone',name:'Fixture phone',is_active:true,is_restricted:false},context:context?{uri:context}:null,item:{id:current,uri:'spotify:track:'+current},progress_ms:position,is_playing:playing,shuffle_state:shuffle,repeat_state:repeat});
  if(method==='GET'&&path==='/v1/me/player/queue'){const index=saved.indexOf(current);return Response.json({queue:saved.slice(index+1).map(id=>({id}))});}
  if(method==='POST'&&path==='/v1/me/playlists')return Response.json({id:playlist,public:false});
  if(path===`/v1/playlists/${playlist}/items`){if(method==='GET')return Response.json({items:saved.map(id=>({item:{id,uri:'spotify:track:'+id}})),next:null});saved=body.uris.map(uri=>uri.slice(14));return Response.json({snapshot_id:'fixture'});}
  if(path.endsWith('/shuffle'))shuffle=url.searchParams.get('state')==='true';
  if(path.endsWith('/repeat'))repeat=url.searchParams.get('state');
  if(path.endsWith('/play')){context=body?.context_uri??context;current=body?saved[body.offset.position]:current;playing=true;}
  if(path.endsWith('/pause'))playing=false;
  return new Response('accepted',{status:200});
 }});
 let room=(await f.create('spotify')).session;
 room=(await f.service.send(host,command('add',room,{trackID:A}))).session;
 room=(await f.service.send(host,command('add',room,{trackID:B}))).session;
 await f.service.send(guest,{action:'join',invite:room.inviteCode,name:'Mina',shareName:false});
 const target=await f.service.send(host,{action:'target',sessionID:room.id});
 room=(await f.service.send(host,command('start',room,{targetNonce:target.target.nonce}))).session;
 assert.deepEqual(saved,[A,B]);assert.equal(room.history.length,0,'An acknowledged play request is not observed playback');
 const tick=()=>[...f.messages.values()].at(-1);
 await f.service.tick(tick());room=(await f.service.send(guest,{action:'read',sessionID:room.id})).session;
 assert.equal(room.history.length,1);assert.equal(room.history[0].track.id,A);
 room=(await f.service.send(guest,command('add',room,{trackID:C}))).session;assert.deepEqual(saved,[A,B,C]);
 room=(await f.service.send(guest,command('reorder',room,{order:[room.queue[2].id,room.queue[1].id]}))).session;assert.deepEqual(saved,[A,C,B]);
 current=C;position=1200;f.advance(5000);await f.service.tick(tick());room=(await f.service.send(host,{action:'read',sessionID:room.id})).session;
 assert.deepEqual(room.history.map(h=>h.track.id),[A,C]);assert.equal(room.history[1].contributorName,'Mina');
 const next=command('control',room,{control:'next'});await f.service.send(host,next);await f.service.send(host,next);
 assert.equal(calls.filter(c=>c.path.endsWith('/next')).length,1,'An uncertain next command must never replay');
 room=(await f.service.send(host,command('end',room))).session;assert.equal(playing,false);assert.equal(shuffle,true);assert.equal(repeat,'context');assert.equal(room.syncError,null);
 assert.equal(calls.filter(c=>c.path.endsWith('/followers')&&c.method==='DELETE').length,1);
});
