import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {migrateLibrary,migrationNames} from '../../scripts/library-migrations.js';

const migrations=await Promise.all(migrationNames.map(async name=>{
 const sql=await readFile(new URL('../../db/'+name,import.meta.url),'utf8');
 return {name,sql,sha256:createHash('sha256').update(sql).digest('hex')};
}));
const privacy=migrations.at(-1);
const reviewed=[{name:privacy.name,sha256:privacy.sha256}];

function fixture({missing=[privacy.name],changed}={}){
 const receipts=new Map(migrations.filter(({name})=>!missing.includes(name)).map(({name,sha256})=>[name,sha256]));
 if(changed)receipts.set(changed,'changed');
 const events=[];
 const database={transaction:async action=>{
  const next=new Map(receipts);
  events.push('BEGIN');
  try{
   const result=await action({query:async(sql,args)=>{
    if(sql.startsWith('SELECT sha256 FROM'))return {rows:next.has(args[0])?[{sha256:next.get(args[0])}]:[]};
    if(sql.startsWith('INSERT INTO library_schema_migrations'))next.set(args[0],args[1]);
    events.push(sql);return {rows:[]};
   }});
   receipts.clear();for(const [name,hash] of next)receipts.set(name,hash);
   events.push('COMMIT');return result;
  }catch(error){events.push('ROLLBACK');throw error;}
 }};
 return {database,receipts,events};
}

test('bounded migration applies only the exact reviewed pending name and digest under the runner lock',async()=>{
 const state=fixture();
 assert.deepEqual(await migrateLibrary(state.database,{expectedPending:reviewed}),[privacy.name]);
 assert.equal(state.receipts.get(privacy.name),privacy.sha256);
 const executed=state.events.filter(event=>event.includes('$account_data_privacy$'));
 assert.equal(executed.length,1);
 assert.ok(state.events.indexOf('SELECT pg_advisory_xact_lock(71309,1)')<state.events.indexOf(executed[0]));
 assert.equal(state.events.at(-1),'COMMIT');
});

for(const [label,expectedPending] of [
 ['empty',[]],
 ['wrong name',[{...reviewed[0],name:'029-listening-sessions.sql'}]],
 ['wrong digest',[{...reviewed[0],sha256:'0'.repeat(64)}]],
 ['duplicate',[...reviewed,...reviewed]],
 ['malformed',[null]],
 ['non-array',null]
])test('bounded migration rejects '+label+' plan before applying SQL or receipts',async()=>{
 const state=fixture();
 await assert.rejects(migrateLibrary(state.database,{expectedPending}),{code:'migration_plan_changed'});
 assert.equal(state.receipts.has(privacy.name),false);
 assert.equal(state.events.some(event=>event.includes('$account_data_privacy$')),false);
 assert.equal(state.events.at(-1),'ROLLBACK');
});

test('bounded migration rejects another missing active migration even when the final one is reviewed',async()=>{
 const state=fixture({missing:[migrationNames[0],privacy.name]});
 await assert.rejects(migrateLibrary(state.database,{expectedPending:reviewed}),{code:'migration_plan_changed'});
 assert.equal(state.events.some(event=>event.startsWith('INSERT INTO library_schema_migrations')),false);
});

test('bounded migration checks every existing active receipt before applying the reviewed change',async()=>{
 const state=fixture({changed:migrationNames[0]});
 await assert.rejects(migrateLibrary(state.database,{expectedPending:reviewed}),{code:'migration_changed'});
 assert.equal(state.receipts.has(privacy.name),false);
});

test('bounded migration requires a new empty plan for an already applied review',async()=>{
 const state=fixture({missing:[]});
 await assert.rejects(migrateLibrary(state.database,{expectedPending:reviewed}),{code:'migration_plan_changed'});
 assert.deepEqual(await migrateLibrary(state.database,{expectedPending:[]}),[]);
});

test('ordinary migration retains unrestricted pending application and idempotency',async()=>{
 const state=fixture();
 assert.deepEqual(await migrateLibrary(state.database),[privacy.name]);
 assert.deepEqual(await migrateLibrary(state.database),[]);
});
