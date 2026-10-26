import {readFile} from 'node:fs/promises';

// A role can be provisioned after schema receipts already exist. Replay only
// idempotent privilege blocks, never previously applied DDL or data migrations.
export async function replayMembershipRoleGrants(db) {
  for(const name of ['025-memberships.sql','028-selected-lyrics-learning.sql','032-auth-token-row-locks.sql']){
    const sql=await readFile(new URL(`../db/${name}`,import.meta.url),'utf8');
    const blocks=sql.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g)??[];
    for(const block of blocks.filter(b=>b.includes('pg_roles')&&b.includes('GRANT ')))await db.query(block);
  }
}
