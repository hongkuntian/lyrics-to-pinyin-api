import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {libraryDB} from '../helpers/library-db.js';
import {MembershipStore} from '../../api/utils/membership/store.js';
import {validateSchema} from './schema-validator.js';
const schema=JSON.parse(await readFile(new URL('../../contracts/membership.schema.json',import.meta.url),'utf8'));
test('membership responses keep account, allowances and actual capabilities in a versioned contract',async t=>{
 const f=await libraryDB();t.after(()=>f.db.close());const store=new MembershipStore(f.store.db);
 for(const kind of ['beta','guest','apple']){
  await f.db.query('UPDATE library_users SET access_kind=$1 WHERE id=$2',[kind,'reader-a']);
  if(kind==='apple')await f.db.query("INSERT INTO account_identities(subject_hash,user_id,app_account_token) VALUES('s','reader-a',$1)",[randomUUID()]);
  const value={version:1,...await store.snapshot('reader-a')};
  assert.deepEqual(validateSchema(schema,value),[]);
  assert.equal(value.account.kind,kind);assert.equal(value.capabilities.purchases,false);
 }
 const value={version:1,...await store.claimStarter('reader-a')};
 assert.deepEqual(validateSchema(schema,value),[]);assert.equal(value.allowances.study.remaining,10);
 assert.ok(validateSchema(schema,{...value,tier:'lifetime'}).length);
});
