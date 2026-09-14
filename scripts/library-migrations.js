import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const migrationNames=['001-song-library.sql','002-dashboard-views.sql','003-correction-foundation.sql','004-correction-dashboard.sql','005-correction-batches.sql','006-batch-dashboard.sql','007-correction-publication.sql','008-publication-dashboard.sql'];
export async function migrateLibrary(database) {
  return database.transaction(async db=> {
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query('SELECT pg_advisory_xact_lock(71309,1)');
    await db.query('CREATE TABLE IF NOT EXISTS library_schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const applied=[];
    for(const name of migrationNames) {
      const sql=await readFile(new URL(`../db/${name}`,import.meta.url),'utf8');
      const hash=createHash('sha256').update(sql).digest('hex');
      const prior=(await db.query('SELECT sha256 FROM library_schema_migrations WHERE name=$1',[name])).rows[0];
      if(prior) {
        if(prior.sha256!==hash) throw Object.assign(new Error('migration_changed'),{code:'migration_changed'});
        continue;
      }
      // The runner owns the transaction so schema, backfill and receipts commit together.
      await db.query(sql.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
      await db.query('INSERT INTO library_schema_migrations(name,sha256) VALUES($1,$2)',[name,hash]);
      applied.push(name);
    }
    return applied;
  });
}
