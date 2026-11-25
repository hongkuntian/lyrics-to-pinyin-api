import test from 'node:test';
import assert from 'node:assert/strict';
import {artifact,variantKey,validateBundle,publicationGrant,editionIdentity} from '../../api/utils/prepared-editions/core.js';
import {bundle} from '../helpers/prepared-edition.js';
test('publication binds exact identities and complete artifacts; any missing or foreign content is rejected',()=>{
 const b=bundle();assert.equal(validateBundle(b),b);
 assert.throws(()=>validateBundle({...b,artifacts:b.artifacts.slice(1)}));
 assert.throws(()=>validateBundle({...b,coverage:{...b.coverage,complete:false}}));
 assert.throws(()=>validateBundle({...b,rights:{...b.rights,derivatives:false}}));
 assert.throws(()=>validateBundle({...b,artifacts:[{...b.artifacts[0],content:{}},...b.artifacts.slice(1)]}));
 assert.equal(artifact('document',{a:1}).id,artifact('document',{a:1}).id);
 assert.notEqual(variantKey({provider:'apple',catalogID:'1',storefront:'ca'}),variantKey({provider:'apple',catalogID:'1',storefront:'tw'}));
});
test('grants never imply offline or client-supplied territory and expire at source expiry',()=>{
 const b=bundle(),now=Date.now();b.rights.expiresAt=new Date(now+1000).toISOString();
 assert.equal(publicationGrant({bundle:b,generation:'1',state:'published'},'read',null,now).expiresAt,b.rights.expiresAt);
 b.rights.worldwide=false;b.rights.territories=['CA'];
 assert.throws(()=>publicationGrant({bundle:b,generation:'1',state:'published'},'read',null,now),/prepared_unavailable/);
 assert.ok(publicationGrant({bundle:b,generation:'1',state:'published'},'read','CA',now).onlineRequired);
});
test('publication rejects empty, blank, mismatched and foreign payloads even when every artifact is rehashed',()=>{
 const corrupt=mutate=>{const b=bundle();mutate(b);b.coverage.requiredArtifactIDs=b.artifacts.map(a=>a.id);b.editionID=editionIdentity(b);return b;};
 const change=(kind,fn)=>b=>{const i=b.artifacts.findIndex(a=>a.kind===kind),a=b.artifacts[i];fn(a.content);b.artifacts[i]=artifact(a.kind,a.content,a.selector);};
 for(const mutate of [
  change('batch',v=>{v.items=[];}),change('batch',v=>{v.items[0].meaning='  ';}),change('batch',v=>{v.items[0].sourceQuote='Other';}),
  change('explanation',v=>{v.meaning='';}),change('explanation',v=>{v.sourceQuote='Other';}),
  change('translation',v=>{v.lines=[];}),change('translation',v=>{v.lines[0].lyricText='';}),
  b=>{b.artifacts.push(artifact('explanation',{meaning:'foreign'},{}));}
 ])assert.throws(()=>validateBundle(corrupt(mutate)),/invalid_publication/);
 const b=bundle();b.variants.push({...b.variants[0],storefront:'tw'});b.recordingEvidence.variants=b.variants;b.documentVariant=b.variants[1];
 assert.throws(()=>validateBundle(b),/invalid_publication/);
});
test('publication review flags must be booleans, never truthy imported strings',()=>{
 for(const flag of ['timingVerified','listeningVerified']){const b=bundle();b.recordingEvidence[flag]='false';assert.throws(()=>validateBundle(b),/invalid_publication/);}
 const b=bundle();b.coverage.complete='false';assert.throws(()=>validateBundle(b),/invalid_publication/);
});
test('publication requires the real native LyricsResponse decoding fields and never fills missing provider metadata',()=>{
 const rewrite=mutate=>{const b=bundle(),i=b.artifacts.findIndex(a=>a.kind==='document'),a=b.artifacts[i];mutate(a.content);b.artifacts[i]=artifact(a.kind,a.content,a.selector);b.coverage.requiredArtifactIDs=b.artifacts.map(a=>a.id);b.editionID=editionIdentity(b);return b;};
 const accepted=bundle();assert.equal(validateBundle(accepted),accepted);
 for(const path of [['response','song','title','romanized'],['response','song','artist','romanized'],['response','song','romanization_system'],['response','metadata','timestamp'],['response','metadata','version']]){
  const b=rewrite(d=>{let value=d;for(const key of path.slice(0,-1))value=value[key];delete value[path.at(-1)];});
  assert.throws(()=>validateBundle(b),/invalid_publication/,path.join('.'));
 }
 for(const mutate of [d=>{d.response.song.title.romanized=42;},d=>{d.response.metadata.timestamp=null;},d=>{d.response.lines[0].romanized=null;},d=>{d.structure.occurrences[0].sourceText='other';}])assert.throws(()=>validateBundle(rewrite(mutate)),/invalid_publication/);
});
test('present optional native DTOs are validated, and valid recording metadata is retained',()=>{
 const rewrite=mutate=>{const b=bundle(),a=b.artifacts[0];mutate(a.content);b.artifacts[0]=artifact(a.kind,a.content,a.selector);b.coverage.requiredArtifactIDs=b.artifacts.map(a=>a.id);b.editionID=editionIdentity(b);return b;};
 for(const field of ['recording_match','catalog_resolution','language_details','timing_quality','timing_correction'])assert.throws(()=>validateBundle(rewrite(d=>{d.response.metadata[field]={};})),/invalid_publication/,field);
 for(const field of ['song_details','provider_translation','lyric_structure'])assert.throws(()=>validateBundle(rewrite(d=>{d.response[field]={};})),/invalid_publication/,field);
 const b=rewrite(d=>{
  d.response.metadata.recording_match={method:'catalog_id',catalog_id:'1817103029',artist:'Test',title:'Test',duration:10};
  d.response.metadata.language_details={version:1,primary:'en',languages:['en'],scripts:['Latn'],mixed:false,confidence:'high',pronunciation_basis:'source',lines:[]};
  d.response.song_details={source_id:'1',source:'QQMusicAPI',credits:[{role:'composer',contributors:['Test'],source:'QQMusicAPI'}]};
  d.response.provider_translation={language:'en',source:'QQMusicAPI',kind:'provider',lines:[{sourceID:'L0001',sourceText:'Hi',text:'Hi',original:'Hi'}]};
 });assert.equal(validateBundle(b),b);
});
test('trusted translation imports match native speaker turns, prefix text and source-note evidence',()=>{
 const b=bundle({speaker:true});assert.equal(validateBundle(b),b);
 const rewrite=mutate=>{const x=structuredClone(b),i=x.artifacts.findIndex(a=>a.kind==='translation'&&a.selector.target==='fr'),a=x.artifacts[i];mutate(a.content);x.artifacts[i]=artifact(a.kind,a.content,a.selector);x.coverage.requiredArtifactIDs=x.artifacts.map(a=>a.id);x.editionID=editionIdentity(x);return x;};
 const withNote=rewrite(v=>{v.sourceNotes=[{sourceID:'L0001',sourceQuote:'Hi',kind:'ambiguous_reading',explanation:'A greeting.'}];});assert.equal(validateBundle(withNote),withNote);
 for(const mutate of [v=>{v.lines[0].startsTurn=false;},v=>{v.lines[0].text='Hi';},v=>{v.lines[0].text='Bob: Hi';},v=>{v.sourceNotes=[{}];},v=>{v.sourceNotes=[{sourceID:'L0001',sourceQuote:'Other',kind:'ambiguous_reading',explanation:'A greeting.'}];}])assert.throws(()=>validateBundle(rewrite(mutate)),/invalid_publication/);
});
