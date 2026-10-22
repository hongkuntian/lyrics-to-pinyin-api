import test from 'node:test';
import assert from 'node:assert/strict';
import {runBuildPreflight} from '../../scripts/build-preflight.mjs';

test('forwards bounded structured preflight records beyond the old child buffer',async()=>{
 const events=[];
 const source=`for(let i=0;i<1200;i++)console.log(JSON.stringify({event:'language_expansion_chunk',index:i,data:'x'.repeat(2000)}));`;
 await runBuildPreflight({args:['--input-type=module','-e',source],emit:event=>events.push(event)});
 assert.equal(events.length,1200);
 assert.equal(events[0].index,0);assert.equal(events.at(-1).index,1199);
 assert.ok(events.reduce((n,e)=>n+JSON.stringify(e).length,0)>2*1024*1024);
});
test('retains earlier records and safe failure status when a later child step fails',async()=>{
 const events=[];
 await assert.rejects(runBuildPreflight({args:['-e',`console.log(JSON.stringify({event:'language_expansion_settled',id:'case-a',resultHash:'a'.repeat(64)}));process.exitCode=7`],emit:e=>events.push(e)}),error=>error.code==='build_preflight_failed'&&error.exitCode===7);
 assert.equal(events.length,1);assert.equal(events[0].id,'case-a');
});
test('discards arbitrary output and forwards allowlisted schema diagnostics',async()=>{
 const events=[];
 const source=`console.log('not structured'); console.error('postgres://never-print.example');console.log(JSON.stringify({event:'other_event',secret:'do-not-forward'}));console.log(JSON.stringify({event:'library_schema_ready',migration:'029-listening-sessions.sql'}));`;
 await runBuildPreflight({args:['-e',source],emit:e=>events.push(e)});
 assert.deepEqual(events,[{event:'library_schema_ready',migration:'029-listening-sessions.sql'}]);
});
test('handles chunked UTF8 and final line without a newline',async()=>{
 const events=[];
 const source=`const b=Buffer.from(JSON.stringify({event:'language_expansion_chunk',source:'อ่าน / किताब / 音'}));process.stdout.write(b.subarray(0,60));setTimeout(()=>process.stdout.write(b.subarray(60)),5);`;
 await runBuildPreflight({args:['-e',source],emit:e=>events.push(e)});
 assert.equal(events[0].source,'อ่าน / किताब / 音');
});
test('fails closed on oversized output records without exposing their text',async()=>{
 const events=[];
 await assert.rejects(runBuildPreflight({args:['-e',`console.log(JSON.stringify({event:'language_expansion_chunk',data:'x'.repeat(20000)}));`],emit:e=>events.push(e)}),error=>error.code==='build_preflight_output_invalid');
 assert.equal(events.length,0);
});
