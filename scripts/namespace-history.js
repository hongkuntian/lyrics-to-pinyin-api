// Fixed adapter for grant blocks from immutable applied migration history.
// Runtime code accepts only current identities; these names are migration input.
const roles=Object.freeze({lyra_runtime_v1:'lyrica_runtime_v1',lyra_account_v1:'lyrica_account_v1'});
export function currentRoleSQL(sql) {
  return sql.replace(/\blyra_(?:runtime|account)_v1\b/g,name=>roles[name]);
}
