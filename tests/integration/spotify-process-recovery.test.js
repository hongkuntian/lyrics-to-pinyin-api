import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=promisify(execFile);
test('process death after PostgreSQL tick+acquisition commit recovers all required queue executors from duplicate predecessor',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'spotify-process-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const worker=new URL('../fixtures/spotify-recovery-worker.mjs',import.meta.url).pathname;
 await assert.rejects(run(process.execPath,[worker,directory,'crash']),e=>e.code===73);
 const before=JSON.parse(await readFile(directory+'/queue.json','utf8'));assert.equal(before.length,1);assert.equal(before[0].message.ordinal,0);
 const {stdout}=await run(process.execPath,[worker,directory,'recover']);const proof=JSON.parse(stdout.trim());
 assert.deepEqual(proof,{ordinal:1,pending:0,queueKinds:['tick','acquire','tick'],queueOrdinals:[0,1]});
 const bytes=await readFile(directory+'/queue.json','utf8');for(const secret of ['fixture-refresh','fixture-access','ab'.repeat(32)])assert(!bytes.includes(secret));
});
