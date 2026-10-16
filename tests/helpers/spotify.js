import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SpotifyStore} from '../../api/utils/spotify/store.js';
import {SpotifyService} from '../../api/utils/spotify/service.js';
import {createVault,sha} from '../../api/utils/spotify/vault.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
export const user={id:'owner',keyID:'a'.repeat(43)+'=',credentialDigest:'digest',bundleID:'com.hongkuntian.Lyra',environment:'development'};
export const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Fixture',artists:['Artist'],album:'Album',duration_ms:240000}};
export function documentFor(r=recording){
 const selection='fixture-selection';
 const response={song:{id:42,title:{original:'Independent title'},artist:{original:'Independent artist'},language:'zh',romanization_system:'pinyin',duration:240},quality:{synced:true,partial:false,instrumental:false},metadata:{source:'LRCAPI',selection_revision:selection},lines:[{original:'Fixture original',romanized:'Fixture reading',timestamp:0},{original:'Next original',romanized:'Next reading',timestamp:20}]};
 response.recordingBinding=spotifyBinding(r,sourceCapsule(response),selection,response);
 return publicDocument(makeDocument(r,response,selection),r);
}
export const recipe={version:1,language:'en',reading:'sourceDefault',pronunciationAbove:true,alignment:'leading',showPronunciation:true,showTranslation:false,translationTarget:null,readyTranslation:null,timingCorrection:null,deviceAid:null};
export function playback(progress=10000,playing=true){return {timestamp:1800000000000,is_playing:playing,progress_ms:progress,currently_playing_type:'track',device:{id:'d',name:'Fixture device'},item:{type:'track',id:recording.item_id,name:'Fixture',artists:[{name:'Artist'}],album:{name:'Album'},duration_ms:240000,is_local:false}};}
export async function fixture(t,{path,overrides={}}={}){
 const db=new PGlite(path);await db.exec(`CREATE TABLE IF NOT EXISTS library_users(id text PRIMARY KEY,disabled boolean DEFAULT false);CREATE TABLE IF NOT EXISTS library_tokens(digest text PRIMARY KEY,user_id text,revoked boolean DEFAULT false,expires_at timestamptz);CREATE TABLE IF NOT EXISTS app_attest_keys(key_id text PRIMARY KEY,user_id text,bundle_id text,environment text,audience text DEFAULT 'fixture',revoked boolean DEFAULT false);INSERT INTO library_users(id) VALUES('owner') ON CONFLICT DO NOTHING;INSERT INTO library_tokens(digest,user_id) VALUES('digest','owner') ON CONFLICT DO NOTHING;`);
 await db.query('INSERT INTO app_attest_keys(key_id,user_id,bundle_id,environment) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[user.keyID,user.id,user.bundleID,user.environment]);
 if(!(await db.query("SELECT to_regclass('spotify_connections') AS name")).rows[0].name)await db.exec(await readFile(new URL('../../db/027-spotify-background.sql',import.meta.url),'utf8'));
 const sql={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn)},store=new SpotifyStore(sql);
 let time=1800000000100,polls=0,refreshes=0;const messages=new Map(),sends=[],provider={async refresh(token){refreshes++;return {accessToken:'fixture-access',refreshToken:token,expiresAtMS:time+3600000,scope:['app-remote-control','user-read-playback-state']};},async playback(){polls++;return {status:200,body:playback(10000+polls*2000),requestStartedAt:time-10,responseReceivedAt:time};}};
 const options={store,config:{clientID:'a'.repeat(32),rateBucket:'fixture-developer',environment:'preview',vault:createVault({active:'one',keys:{one:Buffer.alloc(32,1).toString('base64')}})},provider,now:()=>time,enqueue:async(kind,message,opts)=>{messages.set(opts.idempotencyKey,{kind,message,options:opts});return {messageId:opts.idempotencyKey};},send:async request=>{sends.push(structuredClone(request));},acquire:async r=>({status:200,document:documentFor(r)}),admit:async()=>{},...overrides};
 let service=new SpotifyService(options);
 t.after(()=>db.close());
 return {db,sql,store,messages,sends,provider,options,get service(){return service;},restart(changes={}){Object.assign(options,changes);service=new SpotifyService(options);return service;},advance(ms){time+=ms;},get now(){return time;},get polls(){return polls;},get refreshes(){return refreshes;},async enroll(){return service.enrollment(user,{enrollmentID:randomUUID(),refreshToken:'fixture-refresh',scopeRawValue:49152});},async arm(credential,extra={}){return service.arm(user,{...credential,armID:randomUUID(),installationID:randomUUID(),sessionID:randomUUID(),activityID:randomUUID(),activityGeneration:1,activityCreatedAtMS:time,token:'ab'.repeat(32),tokenVersion:1,frequentPushesEnabled:true,recipe,recording,...extra});},next(kind='tick'){return [...messages.values()].filter(x=>x.message.kind===kind).at(-1)?.message;}};
}
