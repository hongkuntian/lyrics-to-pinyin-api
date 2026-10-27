import {readFile} from 'node:fs/promises';

// A role can be provisioned after schema receipts already exist. Replay only
// privileges, never applied DDL/data. One DO statement is atomic both on a
// standalone pg.Client and inside membership-admin's existing transaction.
export async function replayMembershipRoleGrants(db) {
  const blocks=[];
  for(const name of ['025-memberships.sql','028-selected-lyrics-learning.sql','032-auth-token-row-locks.sql']){
    const sql=await readFile(new URL(`../db/${name}`,import.meta.url),'utf8');
    const matches=[...sql.matchAll(/DO \$\$ (BEGIN[\s\S]*?END) \$\$;/g)]
      .filter(match=>match[1].includes('pg_roles')&&match[1].includes('GRANT '));
    if(matches.length!==1)throw new Error('membership_privilege_block_mismatch');
    blocks.push(matches[0][1]+';');
  }
  // The optional V1 listening family is absent together or catalog-checked.
  // Grant only its account DELETE predicate column; never replay 027/029.
  const listeningSQL=await readFile(new URL('../db/035-listening-account-delete-privileges.sql',import.meta.url),'utf8');
  const listeningMatches=[...listeningSQL.matchAll(/^DO \$listening_account_delete_privileges\$\n([\s\S]*?)\nEND \$listening_account_delete_privileges\$;/gm)];
  if(listeningMatches.length!==1)throw new Error('listening_account_delete_privilege_block_mismatch');
  blocks.push(listeningMatches[0][1]+'\nEND;');
  // This narrow, catalog-checked block returns unchanged on genuine V1-only
  // schemas and refuses partial 034. Never replay 034's DDL or table data.
  const sql=await readFile(new URL('../db/034-listening-v2-output-terminal-support.sql',import.meta.url),'utf8');
  const matches=[...sql.matchAll(/^DO \$sessions_install_metadata_privileges\$\n([\s\S]*?)\nEND \$sessions_install_metadata_privileges\$;/gm)];
  if(matches.length!==1)throw new Error('install_metadata_privilege_block_mismatch');
  blocks.push(matches[0][1]+'\nEND;');
  await db.query('DO $membership_role_replay$\nBEGIN\n'+blocks.join('\n')+'\nEND $membership_role_replay$;');
}
