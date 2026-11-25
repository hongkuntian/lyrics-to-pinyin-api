import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {digest} from '../../api/utils/song-library/store.js';
import {prepareReadingAids,validateReadingAids,verifyReadingAids} from '../../api/utils/prepared-editions/reading-aids.js';
const document=language=>makeDocument({catalog_id:'123',storefront:'ca',title:'Synthetic',artist:'Fixture',duration:24},{song:{id:'1',duration:24,language,romanization_system:language==='ja'?'Hepburn':'Revised',title:{original:'Synthetic',romanized:'Synthetic'},artist:{original:'Fixture',romanized:'Fixture'}},quality:{synced:true,partial:false,instrumental:false},metadata:{version:'2.5.0',timestamp:'2026-11-25T00:00:00Z',source:'QQMusicAPI'},lines:[{original:language==='ja'?'青い鳥 ABC':'함께 노래해 ABC',romanized:'',timestamp:0}]},'test',{});
test('offline JA/KO preparation emits checked ordinary source-bound DTOs with matching Japanese canonical identity',async()=>{
 for(const language of ['ja','ko']){
  const doc=await prepareReadingAids(document(language));validateReadingAids(doc);await verifyReadingAids(doc);
  assert.deepEqual(Object.keys(doc.preparedReadingAids),language==='ja'?['ja-hepburn','ja-kana']:['ko-revised']);
  for(const aid of Object.values(doc.preparedReadingAids)){assert.equal(aid.documentID,doc.id);assert.equal(aid.sourceHash,doc.sourceHash);assert.match(aid.readingRevision,/^[a-f0-9]{64}$/);assert.ok(aid.lines[0].segments.some(s=>s.status==='resolved'));}
  if(language==='ja')assert.equal(doc.preparedReadingAids['ja-kana'].readingRevision,doc.preparedReadingAids['ja-hepburn'].readingRevision);
 }
});
test('publication rejects absent, foreign, stale, incomplete or unusable native reading help',async()=>{
 const ja=await prepareReadingAids(document('ja')),ko=await prepareReadingAids(document('ko'));
 for(const doc of [document('ja'),document('ko')])assert.throws(()=>validateReadingAids(doc),/prepared_reading_aids_required/);
 for(const mutate of [
  d=>{delete d.preparedReadingAids['ja-kana'];},d=>{d.preparedReadingAids.other=d.preparedReadingAids['ja-kana'];},
  d=>{d.preparedReadingAids['ja-kana'].sourceHash=digest('other');},d=>{d.preparedReadingAids['ja-kana'].profile.engineVersion='old';},
  d=>{d.preparedReadingAids['ja-kana'].lines[0].segments[0].lower=1;},d=>{d.preparedReadingAids['ja-kana'].lines[0].segments[0].status='unresolved';},
  d=>{d.preparedReadingAids['ja-kana'].lines[0].segments[0].reading='漢字';},d=>{d.preparedReadingAids['ja-kana'].readingRevision=digest('other-reading');}
 ]){const d=structuredClone(ja);mutate(d);assert.throws(()=>validateReadingAids(d));}
 const broken=structuredClone(ko);broken.preparedReadingAids['ko-revised'].lines[0].segments[0].reading='다른';assert.throws(()=>validateReadingAids(broken));
});
test('checked profile metadata and deterministic verification reject shape-consistent forged readings',async()=>{
 const d=await prepareReadingAids(document('ja'));
 for(const id of ['ja-hepburn','ja-kana']){
  const aid=d.preparedReadingAids[id],s=aid.lines[0].segments[0];s.reading='あ';s.aid=id==='ja-kana'?'あ':'a';
  aid.lines[0].text=aid.lines[0].segments.map((v,i,a)=>(id==='ja-hepburn'&&i>0&&v.status==='resolved'&&a[i-1].status==='resolved'?' ':'')+(v.aid??v.source)).join('');
 }
 validateReadingAids(d);await assert.rejects(verifyReadingAids(d),/prepared_reading_aids_changed/);
});
test('noncanonical JA/KO aliases cannot bypass required profile qualification',()=>{
 for(const language of ['ja-JP','ko-KR','JA','jpn','kor']){const doc=document('ja');doc.response.song.language=language;assert.throws(()=>validateReadingAids(doc),/unsupported_prepared_source_language/);}
});
