import test from 'node:test';
import assert from 'node:assert/strict';
import {playlistCorpus,comparePlaylistReports,positivePlaylistCorpus} from '../../scripts/playlist-timing-eval.mjs';
const item=(id='a'.repeat(22))=>({uri:'spotify:track:'+id,entityType:'MUSIC',title:'Invented title',artists:[{name:'First'},{name:'Guest'}],album:'Invented album',durationMS:30000});
const snapshot=()=>({version:1,inventoryComplete:false,inventoryLimit:'Connector discovery is bounded.',conflictingURIs:[],collections:[{collection:{uri:'spotify:playlist:fixture',name:'Private'},pages:[{page:1,status:'READY',returned:2,totalItems:2,hasNext:false,explanations:[]}],items:[item(),item()]}]});
const result=(caseID,complete,status=200)=>({caseID,mode:'candidate',run:1,status,elapsedMS:10,summary:status===200?{readable:true,lineTimed:true,completeMeasured:complete,source:{provider:'NeteaseAPI',itemID:'42',timing:complete?'netease:42:yrc':null}}:null});
const report=results=>({runs:1,results});
test('playlist import validates every page and deduplicates exact recording IDs without inventing hints',()=>{
 const corpus=playlistCorpus(snapshot());assert.equal(corpus.cases.length,1);assert.equal(corpus.snapshot.occurrences,2);
 assert.deepEqual(corpus.cases[0].request.recording.metadata.artists,['First','Guest']);
 assert.equal('explicit' in corpus.cases[0].request.recording.metadata,false);
 assert.equal('market' in corpus.cases[0].request.recording,false);
 for(const change of [s=>s.collections[0].pages[0].hasNext=true,s=>s.collections[0].pages[0].returned=1,
  s=>s.collections[0].pages[0].status='LOADING',s=>s.collections[0].pages[0].explanations=['filtered'],
  s=>s.collections[0].items[1].durationMS=31000,s=>s.collections[0].items[0].artists=[]]){
  const s=snapshot();change(s);assert.throws(()=>playlistCorpus(s),/invalid_playlist_snapshot/);
 }
 const s=snapshot();s.collections[0].items[1]=item('b'.repeat(22));assert.equal(playlistCorpus(s).cases.length,2);
});
test('comparison keeps failures and every attempt in a common availability denominator',()=>{
 const corpus=playlistCorpus(snapshot()),id=corpus.cases[0].caseID;
 const before=report([result(id,true)]),after=report([result(id,false,504)]);
 const compared=comparePlaylistReports(corpus,before,after);
 assert.equal(compared.baseline.availableAttempts,1);assert.equal(compared.candidate.availableAttempts,1);
 assert.equal(compared.candidate.availableHitRate,0);assert.deepEqual(compared.lost,[id]);assert.equal(compared.noObservedRegressions,false);
 const frozen=positivePlaylistCorpus(corpus,before,after);assert.equal(frozen.cases.length,1);assert.equal(frozen.cases[0].availabilityEvidence.source.itemID,'42');
 // Every repetition counts; a success followed by failure is not best-of-two.
 const repeated={runs:2,results:[result(id,true),{...result(id,false,504),run:2}]};
 assert.equal(comparePlaylistReports(corpus,before,repeated).candidate.availableHitRate,.5);
 for(const bad of [report([]),report([result(id,true),result(id,true)]),report([result('unknown',true)])])
  assert.throws(()=>comparePlaylistReports(corpus,before,bad),/incomplete_playlist_report/);
});
test('unknown availability is not absence, and private exports cannot leak through corpus import',()=>{
 const s=snapshot();s.collections[0].items[0].play_uri='secret';s.collections[0].items[1].play_uri='secret';
 const corpus=playlistCorpus(s),id=corpus.cases[0].caseID;
 assert.equal(JSON.stringify(corpus).includes('secret'),false);assert.equal(JSON.stringify(corpus).includes('Private'),false);
 const compared=comparePlaylistReports(corpus,report([result(id,false)]),report([result(id,false)]));
 assert.equal(compared.knownAvailable,0);assert.equal(compared.candidate.availableHitRate,null);assert.equal(compared.unknownAvailability,1);
});
