import test from 'node:test';
import assert from 'node:assert/strict';
import {logLookup} from '../../api/utils/lookup-diagnostics.js';

test('injected structured loggers retain structured match explanations',()=>{
 const calls=[],details={provider:'LRCAPI',match:{candidates:[{sourceID:'42',reason:'title_conflict'}]}};
 logLookup({info:(...args)=>calls.push(args)},'lyrics_lookup',details);
 assert.deepEqual(calls,[['lyrics_lookup',details]]);
 assert.doesNotThrow(()=>logLookup({},'lyrics_lookup',details));
});
test('the default console serializes complete nested match explanations instead of collapsing them',()=>{
 const original=console.info,calls=[],details={requestID:'fixture',match:{candidates:[{sourceID:'42',reason:'title_conflict',rules:['soundtrack_description']}]}};
 try {
  console.info=(...args)=>calls.push(args);
  logLookup(console,'lyrics_lookup',details);
  assert.equal(typeof calls[0][1],'string');
  assert.deepEqual(JSON.parse(calls[0][1]),details);
  assert.match(calls[0][1],/title_conflict/);
 } finally {console.info=original;}
});
