# Authentication token row-lock admission

## Maintained contract

`db/032-auth-token-row-locks.sql` supplies the narrow token-row write privilege required by ordered authentication readers and writers. Generic authentication is maintained independently of the retired shared-listening feature. See [writer ordering](auth-writer-order.md), [current authentication](current-auth-context.md) and [manual PostgreSQL qualification](auth-token-lock-postgres.md).

PostgreSQL locking reads require an UPDATE privilege even when the query changes no business value. The migration adds `public.library_tokens.lock_anchor boolean NOT NULL DEFAULT false`, guarded by a named validated false-only CHECK, then conditionally grants exactly `UPDATE(lock_anchor)` to the existing `lyra_runtime_v1` role. It grants no token identity, owner, revocation, expiry or other authority-field UPDATE; no INSERT, DELETE, TRUNCATE, GRANT OPTION or schema CREATE; no role, login or credential is created. The anchor never reaches a public DTO.

Readers retain token `FOR UPDATE`; ordered writers use `FOR NO KEY UPDATE`. Their lock matrix and actual reader/writer operations require real PostgreSQL proof, not an inference from successful setup. Neither the anchor nor a successful zero-row locking query grants user authorization.

## Catalog and replay guards

The migration fixes name/operator lookup to `pg_catalog` while validating exact relation/column/constraint catalogs. The anchor must have the built-in boolean type, scalar typmod/dimensions, NOT NULL, ordinary local noninherited/nonidentity/nongenerated form and explicit false default. Its named CHECK must be local, validated, nondeferrable, false-only and bound to exactly this column with the expected canonical catalog expression. Different definitions refuse with SQLSTATE 23514 and fixed `auth_token_lock_*_catalog_mismatch` diagnostics; they are never silently repaired.

These are checks of the migration's authority objects, not a complete database, trigger, RLS, inheritance or effective-ACL audit. Catalog deparser behavior needs target-PostgreSQL qualification.

The active migration manifest is 001–028, 032 and 036. Retired feature SQL 029/030/031/033/034/035 remains immutable but unregistered. Existing historical receipts remain intact. The runner skips matching receipts and refuses changed SQL hashes with `migration_changed`; it is not a general drift auditor. Never edit an old migration or receipt to hide drift.

`replayMembershipRoleGrants` reads the unchanged conditional privilege bodies from 025/028/032 and the neutral retained-account-data body from 036 in one atomic outer DO statement. It does not replay retired feature SQL, perform DDL/data backfill or alter migration receipts. The 032 replay validates the existing anchor before granting and refuses missing or changed definitions without recreating them. If schema precedes role creation, later provisioning must replay and verify the narrow grant. Replay does not invent token SELECT or missing historical bootstrap privileges.

## Data and authorization consequences

Existing named-column token inserts receive false by default. Token identity, revocation and expiry do not change; no app local data migrates. Internal whole-row SQL would now contain the anchor, so maintained public paths must continue explicit projections. Current-auth handles, canonical user/token/key/session lock order, preimage revalidation, deliberate-mutation postimages, deadline checks and Spotify revocation remain independent requirements. Authentication sessions are retained and are not shared listening Sessions.

The 036 retained-data repair is independent of token row locking. It checks the optional historical V1 family and grants only `SELECT(user_id)` on its rate-window table to an existing account role. It does not recreate feature schemas or establish full late-role prerequisites. Account deletion refuses a retained `listening_v2` namespace until a qualified data-only disposition exists; the retired admission/protocol runtime is not an erasure implementation.

## Verification and deployment

The hermetic integration suite uses real migration SQL, the actual runner/replay helper and restricted synthetic roles. Its baseline is exactly 001–028, followed by 032/036. Assertions cover pre-032 permission failure, zero/populated-row lock admission, authority-field denials, anchor/check drift, immutable receipts, transactional grant/receipt rollback, hostile search paths, role absence and late replay. These fixtures do not prove deployed roles, production bootstrap or real PostgreSQL concurrency.

Run the [manual qualification](auth-token-lock-postgres.md) on the explicitly approved clean commit for actual-method, restricted-role and two-client lock evidence. Record that result separately from `npm test` and read-only database inventory. Historical results qualify only the original archived commit.

Apply and verify 032 with schema-owner authority before deploying a live writer/current-auth path requiring token locks. Verify both schema receipt and actual effective runtime/account permissions, database identity and late-role replay. Keep migration credentials outside runtime configuration. A receipt does not establish the later role's grant. Rollback retains the additive false-only anchor and narrow grant; roll code back only to a compatible version, never drop the anchor or widen authority-field UPDATE as a shortcut.
