import test from 'node:test';
import assert from 'node:assert/strict';
import {contentSnapshot} from '../../scripts/audit-content-quality.mjs';
test('audit starts a read-only transaction before bounded content-only queries',async()=>{
 const calls=[],db={transaction:async fn=>fn({query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}})};
 const snapshot=await contentSnapshot(db);
 assert.equal(calls[0].sql,'SET TRANSACTION READ ONLY');assert.deepEqual(calls.slice(2).map(c=>c.args),[[20],[40]]);
 assert.ok(calls.slice(1).every(c=>/^SELECT /i.test(c.sql)));assert.ok(calls.every(c=>!c.sql.includes('user_id')));
 for(const field of ['contract_version','explanation_language','study_text','selection_text_hash','generation_request'])assert.ok(calls[3].sql.includes(field));
 assert.deepEqual(snapshot.rows,[]);assert.deepEqual(snapshot.study,[]);
});
test('invalid limits never acquire a database transaction',async()=>{
 let calls=0;const db={transaction:()=>{calls++;}};
 for(const patch of [{songs:0},{songs:51},{studies:1.5},{studies:NaN}])await assert.rejects(contentSnapshot(db,patch));
 assert.equal(calls,0);
});
