import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {MembershipStore} from '../../api/utils/membership/store.js';
import {validateSchema} from './schema-validator.js';
const schema=JSON.parse(await readFile(new URL('../../contracts/membership.schema.json',import.meta.url),'utf8'));
test('membership responses keep account, allowances and actual capabilities in a versioned contract',async t=>{
 const f=await libraryDB();t.after(()=>f.db.close());const store=new MembershipStore(f.store.db);
 for(const kind of ['beta','guest']){
  await f.db.query('UPDATE library_users SET access_kind=$1 WHERE id=$2',[kind,'reader-a']);
  const value={version:1,...await store.snapshot('reader-a')};
  assert.deepEqual(validateSchema(schema,value),[]);
  assert.equal(value.account.kind,kind);assert.equal(value.capabilities.purchases,false);
  // Every account carries its own StoreKit appAccountToken.
  assert.match(value.account.appAccountToken,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof value.liveLyricsIncluded,'boolean');
 }
 const value={version:1,...await store.snapshot('reader-a')};
 assert.equal(value.libraryTranslations.remaining,3);
 assert.ok(validateSchema(schema,{...value,tier:'lifetime'}).length);
 assert.ok(validateSchema(schema,{...value,tier:'plus'}).length);
 // Sign in with Apple accounts no longer exist; the token is never null.
 assert.ok(validateSchema(schema,{...value,account:{...value.account,kind:'apple'}}).length);
 assert.ok(validateSchema(schema,{...value,account:{...value.account,appAccountToken:null}}).length);
 const {liveLyricsIncluded,...missing}=value;assert.ok(validateSchema(schema,missing).length);
});
