import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile,unlink} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import * as current from '../api/utils/recording-match.js';
import {recordingTransformations} from '../tests/helpers/recording-transformations.js';

const {values}=parseArgs({options:{baseline:{type:'string'},out:{type:'string'}}});
if(!/^[a-f0-9]{40}$/.test(values.baseline??''))throw new Error('--baseline requires an immutable 40-character commit SHA');
const root=new URL('../',import.meta.url),path='api/utils/recording-match.js';
const source=execFileSync('git',['show',`${values.baseline}:${path}`],{cwd:root,encoding:'utf8'});
const scratch=new URL(`api/utils/.recording-match-baseline-${randomUUID()}.mjs`,root);
const functions=['stripTitleDescription','stripThemeDescriptionSuffix','searchTitle','japaneseThemeSearchTitle','recordingNames','sameRecordingNames','sameSpotifyRecordingNames','sameRecordingVersions','metadataEquivalence','recordingScore','findRecording','findLyricsRecording'];
function cases() {
 const entries=recordingTransformations().flatMap(entry=>[entry,{
  label:`inverse:${entry.label}`,song:{...entry.request,recordingProvider:undefined},
  request:{...entry.request,...entry.song,recordingProvider:entry.request.recordingProvider}
 }]);
 const titles=['Song','Ｓｏｎｇ','Song (live版)','Song (feat. Guest)','Song [feat. Guest]','Song (with Guest) (live版)','Song (with Guest (live))','Song (アニメ全話OP)','Song (アニメ)','Song - 電影《作品》主題曲','Song [[From Film]]','Song [From Film - with Guest]','Song [From Film] [Unknown]','(feat. Guest) Song','Song [From\nFilm]'];
 const seed={id:'1',title:'Song',artist:'Singer',album:'Album',duration:188};
 for(const policy of ['legacy','spotify'])for(const title of titles)for(const duration of [undefined,null,-1,0,188,191,191.001,NaN,Infinity]) {
  const request={...seed,title,...(policy==='spotify'?{recordingProvider:'spotify',creditedArtistNames:['Singer']}: {})};
  entries.push({label:`${policy}:edge:${title}:${String(duration)}`,song:{...seed,duration},request});
 }
 for(const creditedArtistNames of [undefined,[],['Singer'],['Singer','Singer'],['Singer','Guest'],['Singer & Guest'],[null]]) {
  const request={...seed,recordingProvider:'spotify',creditedArtistNames:['Singer','Guest'],title:'Song (feat. Guest)'};
  for(const artist of ['Singer','Singer & Guest','Guest / Singer','Singer & Singer'])
   entries.push({label:`credits:${artist}:${JSON.stringify(creditedArtistNames)}`,song:{...seed,artist,creditedArtistNames},request});
 }
 for(const delta of [0,0.5,0.5001])for(const album of ['Album','Album - Single','Other Album'])
  entries.push({label:`soft:${album}:${delta}`,song:{...seed,artist:'Last, First'},request:{...seed,catalog_id:'123',artist:'First Last',album,duration:188+delta}});
 return entries;
}
function argumentsFor(name,{song,request}) {
 if(['stripTitleDescription','stripThemeDescriptionSuffix','searchTitle','japaneseThemeSearchTitle'].includes(name))return [request.title];
 if(name==='recordingNames')return [song];
 if(name==='findRecording'||name==='findLyricsRecording')return [[song,{...song,id:'2',lyricsData:{lines:[{text:'Synthetic lyric',timestamp:5}]}}],request];
 return [song,request];
}
function outcome(module,name,argumentsList) {
 try{return {result:module[name](...structuredClone(argumentsList))};}
 catch(error){return {error:{name:error.name,message:error.message,code:error.code,reason:error.reason}};}
}
await writeFile(scratch,source,{flag:'wx',mode:0o600});
try {
 const baseline=await import(scratch),entries=cases(),failures=[];let comparisons=0;
 for(const entry of entries)for(const name of functions) {
  const args=argumentsFor(name,entry),before=outcome(baseline,name,args),after=outcome(current,name,args);comparisons++;
  try{assert.deepEqual(after,before);}
  catch {failures.push({case:entry.label,function:name,before,after});}
 }
 const report={baseline:values.baseline,baselineMatcherSHA256:createHash('sha256').update(source).digest('hex'),node:process.version,cases:entries.length,functions,comparisons,mismatches:failures.length,examples:failures.slice(0,12)};
 if(values.out)await writeFile(values.out,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
 if(failures.length)process.exitCode=1;
} finally {await unlink(scratch);}
