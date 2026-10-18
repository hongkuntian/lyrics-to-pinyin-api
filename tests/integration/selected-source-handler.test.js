import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {createSongLibraryService} from '../../api/song-library.js';
import {selectedTextHash} from '../../api/utils/song-library/selected-source.js';
const candidate={provider:'lrclib',itemID:'123',title:'Independent live title',artist:'Independent artist',duration:180,lines:[{text:'Only these exact source words',timestamp:3}]};
const choice={action:'selected_source',provider:'lrclib',itemID:'123',expectedTextHash:selectedTextHash(candidate.lines)};
async function setup(t){
 const {db,store}=await libraryDB();t.after(()=>db.close());let fetches=0,generations=0;
 const pending=[];
 const handler=createSongLibraryService({store,loadSelectedSource:async()=>{fetches++;return structuredClone(candidate);},apiKey:'fixture',waitUntilFn:task=>pending.push(task),logger:{error(){}},
  generateFn:async()=>{generations++;return {content:{lines:[{sourceID:'L0001',lyricText:'Exact translated source.',speakerID:null,startsTurn:false}],sourceNotes:[]},actualMicros:1000,response:{id:'fixture'}};}});
 const call=async(body,user='reader-a')=>{const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.code=v;return this;},json(v){this.body=v;return this;}};
  await handler({method:'POST',lyricaUser:user?{id:user}:null,body},res);return res;};
 return {db,store,call,pending,get fetches(){return fetches;},get generations(){return generations;}};
}
test('selected registration is authenticated, provider fetched, immutable and never spends or creates a recording association',async t=>{
 const s=await setup(t);
 assert.equal((await s.call(choice,null)).code,401);
 for(const extra of [{target:'en'},{recording:{catalog_id:'123'}},{lines:[]},{allowGeneration:true},{url:'https://bad'}])assert.equal((await s.call({...choice,...extra})).code,400);
 assert.equal(s.fetches,0);
 const a=await s.call(choice),b=await s.call(choice);assert.equal(a.code,200);assert.equal(b.body.document.id,a.body.document.id);
 assert.equal(a.body.document.selectedSource.provider,'lrclib');assert.equal(a.body.document.response.song.title.original,candidate.title);
 assert.equal(a.body.document.selectedSourceCapsule,undefined);assert.equal(s.generations,0);
 assert.equal((await s.db.query('SELECT count(*) AS n FROM lyric_requests')).rows[0].n,0);
 assert.equal(Number((await s.store.usage()).jobs),0);
 assert.equal((await s.call({...choice,expectedTextHash:'0'.repeat(64)})).body.code,'selected_source_changed');
});
test('private source admission precedes cached derivatives and status recovery; beta still needs Generate',async t=>{
 const s=await setup(t),doc=(await s.call(choice)).body.document;
 const translate={action:'translate',documentID:doc.id,sourceHash:doc.sourceHash,target:'en'};
 assert.equal((await s.call(translate)).body.code,'generation_required');assert.equal(s.generations,0);
 assert.equal((await s.call({...translate,allowGeneration:true},'reader-b')).body.code,'selected_source_unavailable');
 const start=await s.call({...translate,allowGeneration:true});assert.equal(start.code,202);await Promise.all(s.pending);
 assert.equal(s.generations,1);assert.equal((await s.call(translate)).body.state,'ready');
 for(const body of [translate,{...translate,action:'current'},{action:'status',jobID:start.body.job.id},
  {action:'pronunciation',documentID:doc.id,sourceHash:doc.sourceHash,profileID:'unrelated'}])assert.equal((await s.call(body,'reader-b')).body.code,'selected_source_unavailable');
 assert.equal((await s.call(choice,'reader-b')).code,200);
 assert.equal((await s.call(translate,'reader-b')).body.state,'ready');assert.equal(s.generations,1);
 await s.db.query('DELETE FROM selected_source_access WHERE user_id=$1',['reader-a']);
 assert.equal((await s.call(translate)).body.code,'selected_source_unavailable');
 assert.equal((await s.call({action:'status',jobID:start.body.job.id})).body.code,'selected_source_unavailable');
});
