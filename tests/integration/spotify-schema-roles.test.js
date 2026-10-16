import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('Spotify migration grants runtime data access and narrow account cleanup without schema authority',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE ROLE lyra_runtime_v1; CREATE ROLE lyra_account_v1;');
 await db.exec(await readFile(new URL('../../db/027-spotify-background.sql',import.meta.url),'utf8'));
 for(const role of ['lyra_runtime_v1','lyra_account_v1']){
  for(const table of ['spotify_connections','spotify_outbox','spotify_snapshot_capabilities']){
   for(const action of ['SELECT','INSERT','UPDATE','DELETE']){
    assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,table,action])).rows[0].allowed,true,`${role} needs ${action} on ${table}`);
   }
  }
  assert.equal((await db.query("SELECT has_schema_privilege($1,'public','CREATE') AS allowed",[role])).rows[0].allowed,false);
 }
 assert.equal((await db.query("SELECT has_table_privilege('lyra_runtime_v1','spotify_provider_circuits','UPDATE') AS allowed")).rows[0].allowed,true);
 assert.equal((await db.query("SELECT has_table_privilege('lyra_account_v1','spotify_provider_circuits','UPDATE') AS allowed")).rows[0].allowed,false);
});
