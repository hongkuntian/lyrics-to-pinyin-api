// Build-only administration: no HTTP endpoint and no exported credentials.
import {open} from 'node:fs/promises';
import {runEvaluation} from './evaluate-multilingual.js';
import {pathToFileURL} from 'node:url';
import {database} from '../api/utils/song-library/database.js';
import {migrateLibrary,migrationNames} from './library-migrations.js';

export async function verifyBuildSchema({env=process.env,open=database,migrate=migrateLibrary,log=console.log}={}) {
  const requested=env.LYRA_LIBRARY_MIGRATE_ON_BUILD==='1';
  const production=env.VERCEL==='1'&&env.VERCEL_ENV==='production';
  if(requested&&!production)throw new Error('migration_requires_production_build');
  if(!production)return;
  let db;
  try {
    db=open(env);
    if(requested){
      const applied=await migrate(db);
      log(JSON.stringify({event:'library_migrations_applied',migrations:applied}));
    }
    const {rows}=await db.query('SELECT name FROM library_schema_migrations WHERE name=$1',[migrationNames.at(-1)]);
    if(!rows.length)throw new Error('library_schema_migration_required');
    log(JSON.stringify({event:'library_schema_ready',migration:migrationNames.at(-1)}));
  } finally {await db?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    await verifyBuildSchema();
    if(process.env.LYRA_MULTILINGUAL_EVALUATE_ON_BUILD==='1') {
      if(process.env.VERCEL!=='1'||process.env.VERCEL_ENV!=='production')throw new Error('evaluation_requires_production_build');
      // Vercel's legacy multi-function builder can invoke this hook repeatedly.
      // One build container evaluates once; other invocations leave it alone.
      const claim=await open('/tmp/lyra-multilingual-evaluation.lock','wx').catch(error=>{if(error.code!=='EEXIST')throw error;});
      if(claim){await claim.close();await runEvaluation();}
    }
  }
  catch {console.error('Library build verification failed. Inspect the schema or evaluation receipt before promotion.');process.exitCode=1;}
}
