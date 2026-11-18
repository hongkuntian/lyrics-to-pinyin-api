import {readFile} from 'node:fs/promises';
import {currentRoleSQL} from './namespace-history.js';

// 039 drops Sign in with Apple's account_identities. 025's immutable grant
// block still names it twice; a late role replays those grants without it.
// Any other count means the historical text drifted, so refuse.
export function withoutRetiredRelations(sql) {
  const retired='public.account_identities,';
  if(sql.split(retired).length-1!==2)throw new Error('membership_privilege_block_mismatch');
  return sql.replaceAll(retired,'');
}

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
    const block=currentRoleSQL(matches[0][1]);
    blocks.push((name==='025-memberships.sql'?withoutRetiredRelations(block):block)+';');
  }
  // Retained optional account data is absent together or catalog-checked.
  // Grant only its DELETE predicate column; never replay feature migrations.
  const privacySQL=await readFile(new URL('../db/036-account-data-privacy.sql',import.meta.url),'utf8');
  const privacyMatches=[...privacySQL.matchAll(/^DO \$account_data_privacy\$\n([\s\S]*?)\nEND \$account_data_privacy\$;/gm)];
  if(privacyMatches.length!==1)throw new Error('account_data_privacy_privilege_block_mismatch');
  blocks.push(currentRoleSQL(privacyMatches[0][1])+'\nEND;');
  // Anonymous accounts: hold column insert and the bounded expiry slide.
  const anonymousSQL=await readFile(new URL('../db/039-anonymous-accounts.sql',import.meta.url),'utf8');
  const anonymousMatches=[...anonymousSQL.matchAll(/DO \$\$ (BEGIN[\s\S]*?END) \$\$;/g)]
    .filter(match=>match[1].includes('pg_roles')&&match[1].includes('GRANT '));
  if(anonymousMatches.length!==1)throw new Error('membership_privilege_block_mismatch');
  blocks.push(anonymousMatches[0][1]+';');
  await db.query('DO $membership_role_replay$\nBEGIN\n'+blocks.join('\n')+'\nEND $membership_role_replay$;');
}
