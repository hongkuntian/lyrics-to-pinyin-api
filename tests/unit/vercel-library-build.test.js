import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBuildSchema} from '../../scripts/vercel-library-build.js';
import {migrationNames} from '../../scripts/library-migrations.js';
const production={VERCEL:'1',VERCEL_ENV:'production'};
test('local and preview builds never access the production database',async()=>{
 for(const env of [{},{VERCEL:'1',VERCEL_ENV:'preview'}])await verifyBuildSchema({env,open:()=>assert.fail('database access')});
 await assert.rejects(verifyBuildSchema({env:{LYRA_LIBRARY_MIGRATE_ON_BUILD:'1'},open:()=>assert.fail('database access')}),/migration_requires_production_build/);
});
test('normal production build checks schema without applying migrations',async()=>{
 let closed=0;
 await verifyBuildSchema({env:production,open:()=>({query:async(sql,args)=>{assert.deepEqual(args,[migrationNames.at(-1)]);return {rows:[{name:args[0]}]};},close:async()=>closed++}),migrate:()=>assert.fail('migration'),log:()=>{}});
 assert.equal(closed,1);
});
test('missing schema fails the build and releases its connection',async()=>{
 let closed=0;
 await assert.rejects(verifyBuildSchema({env:production,open:()=>({query:async()=>({rows:[]}),close:async()=>closed++}),log:()=>{}}),/library_schema_migration_required/);
 assert.equal(closed,1);
});
test('explicit production migration runs before readiness check and logs only receipt names',async()=>{
 const events=[];
 await verifyBuildSchema({env:{...production,LYRA_LIBRARY_MIGRATE_ON_BUILD:'1'},open:()=>({query:async()=>{events.push('verify');return {rows:[{}]};},close:async()=>events.push('close')}),
  migrate:async()=>{events.push('migrate');return [migrationNames.at(-1)];},log:message=>{assert.ok(!message.includes('postgres'));events.push('log');}});
 assert.deepEqual(events,['migrate','log','verify','log','close']);
});
test('migration errors never continue to readiness and still close',async()=>{
 let closed=0;
 await assert.rejects(verifyBuildSchema({env:{...production,LYRA_LIBRARY_MIGRATE_ON_BUILD:'1'},open:()=>({query:()=>assert.fail('query'),close:async()=>closed++}),migrate:async()=>{throw new Error('migration_changed');},log:()=>assert.fail('log')}),/migration_changed/);
 assert.equal(closed,1);
});
