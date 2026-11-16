# Lyrica namespace contract

The installed app is **Lyrica** and its App Store marketing title is
**Lyrica: Learn with Lyrics**. Current app/backend protocols, environment keys,
SQL roles and schemas, dashboard cookies, provider metadata, diagnostics and
operator paths use that namespace. This prerelease cutover intentionally rejects
previous app credentials and session formats; there are no runtime aliases.

The descriptive `lyrics-to-pinyin-api` repository/package and production API
origin remain unchanged. The dashboard uses
`https://lyrica-dashboard.vercel.app` and the existing protected Vercel project.
Owner OAuth keeps its scopes and team restriction; retain only the canonical
`/auth/callback` registration after validating the new deployment.

## Database cutover

Apply `037-lyrica-namespace.sql` with schema-owner and role-administration
credentials before deploying the renamed API and dashboard. Use the normal
migration runner with an exact reviewed `expectedPending` entry; unrelated
pending migrations or altered historical receipts must stop the cutover.

The migration renames schemas and roles in place. It preserves schema/relation/
function/role OIDs, ACLs, owners, account and recording IDs, source documents,
learning data, paid results and prior migration receipts. It refuses a conflicting
target or independently edited owner-control function. The four reviewed
PL/pgSQL functions are replaced under their canonical schema because stored
function bodies contain textual schema references. A failed migration or receipt
insert rolls back the entire change. Old aliases are not recreated.

[PostgreSQL clears MD5 password verifiers during a role rename](https://www.postgresql.org/docs/current/sql-alterrole.html). Confirm the actual
role authentication format first; for any MD5 login, reapply that login's existing
password from its private credential file using the schema-owner connection in
the same transaction. Never emit passwords or connection URLs in logs.

Update private connection URL usernames to the corresponding canonical role,
keeping their passwords, host, database and TLS settings. Update both dashboard
reader/operator URLs and API runtime/account URLs. The reader's default search
path changes with its schema; its read-only setting and other role attributes
remain intact. Fresh account provisioning now migrates before creating the
canonical account role, then replays only current narrow grants.

If original scoped passwords are unavailable, an owner may rotate those four
passwords in the same transaction, keeping each role's identity and authority.
Construct replacement URLs from the actual database host/database/TLS settings
and store the new passwords privately. Preserve account-encryption, Spotify vault,
OAuth and signing key values when renaming their configuration keys; changing
those keys can invalidate stored encrypted data or external registrations.

The account refresh-token AAD remains the original subject hash. Spotify vault
AAD remains bound to the persisted owner/key/connection/epoch/client,
environments and purpose; retain those values and the keyring when reopening
old ciphertext. A new app's APNs topic cannot replace the topic of an existing
ActivityKit token. Finish any necessary terminal cleanup with its original
stored topic before retiring that deployed sender; the canonical sender accepts
only current release and Debug bundle IDs. Historical Apple revocation is
independent of active app admission, as described in
[the membership identity contract](memberships.md#identity-and-credentials).

## Coordinated deployment

1. With the old worker still deployed, stop new review admission and reconcile all
   unfinished provider batches. The provider's filename and metadata key change;
   do not abandon an uploading, submitted or unknown paid batch. Verify a zero
   unfinished count from `correction_batches` before the namespace migration.
2. Retain owner-only source configuration and a database rollback point. Inventory
   the actual roles, schema/function definitions, migration receipts, current
   feature controls and database URLs. Do not infer the production state from
   source or fixture tests.
3. Apply only the reviewed namespace migration under the migration runner's
   transaction and advisory lock. Validate canonical roles/schemas and unchanged
   retained data/ACLs before continuing.
4. Rename environment keys to `LYRICA_*` with their existing secret values and
   scopes. Update bundle/audience/store/APNs values to the replacement Apple app
   identities. Remove unused Redis aliases: the cache accepts only the complete
   `LYRICA_CACHE_KV_REST_API_URL` / `LYRICA_CACHE_KV_REST_API_TOKEN` pair.
5. Deploy the verified exact backend and dashboard commit. Verify protected owner
   login/logout, signed-out and cross-origin denial, read-only views, the two
   allowed owner controls, app authentication and StoreKit configuration before
   enabling new access. Retire the previous dashboard alias/callback and obsolete
   configuration after the canonical endpoints are observed working.

Do not claim this live sequence happened from hermetic test results. New Apple
app creation, signing, product registrations and real account acceptance are
separate delivery evidence owned by the iOS integration task.

## Historical material

Applied SQL through migration 036 is immutable, including retired, unregistered
feature migrations. It is migration history rather than a current naming alias.
Historical SQL contract tests retain the identities their original statements
exercise; current namespace tests separately prove the forward cutover and
canonical late-role replay. Measured research receipts retain their original
paths and provenance. Git history and Apple-uploaded identity records cannot be
truthfully rewritten as newly named evidence.

`tests/unit/naming-contract.test.js` checks current source and documentation for
old-brand references while verifying the exact recorded historical exceptions.
