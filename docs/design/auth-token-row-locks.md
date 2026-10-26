# Auth token row-lock authority

Status: SOURCE ONLY. Tests are **AUTHORED NOT EXECUTED**. This proposal supplies
an unapplied migration, runner registration, grant replay and a dedicated test
file. It changes no auth writer, route, response, capability or deployment.
Root owns red/green execution, independent review, actual-role/concurrency
qualification, application and publication.

## Source and measured requirement

Backend base: `7c851bab92eca52abcf215bd77ede3a4f9b5cb90`. Read the full approved
Sessions architecture, SHA-256
`7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`,
backend AGENTS, migrations 001/021/025/028/029/030/031, actual migration/replay
helpers, APP_AUTH deployment security and existing role/migration/auth tests.
Maintained auth writers remain the supplied base; active author postimages
are separate and were neither inspected nor changed.

Root's retained `runtime-auth-lock-privileges-1.json` at
`/Users/hongkuntian/.codex/lyra-workflow/evidence/redesign-parity-20261025/`
records `lyra_runtime_v1` token SELECT=true, any token UPDATE=false and table
UPDATE=false. `SELECT digest FROM public.library_tokens WHERE false FOR UPDATE`
was refused with SQLSTATE 42501; users NO KEY UPDATE, keys FOR UPDATE and
sessions FOR UPDATE admitted zero rows. This is supplied read-safe runtime
evidence, not an experiment performed by this source author. No DB was opened.

Coordinated auth writers/current-auth need a real token FOR UPDATE lock under
the approved canonical users -> tokens -> keys order, after any required
earlier settings/identity anchors. PostgreSQL requires UPDATE privilege on at
least one column for row-locking SELECT. A SELECT grant alone is insufficient.
This patch supplies that missing prerequisite; it does not qualify ordering,
deadline handling, real role inheritance or concurrent writer correctness.

## Selected authority and alternatives

Add `public.library_tokens.auth_lock_anchor boolean NOT NULL DEFAULT false`
with named CHECK `auth_lock_anchor IS FALSE`. Grant only
`UPDATE(auth_lock_anchor)` to an already-existing `lyra_runtime_v1`. No grant
option, role creation, SELECT expansion or other role grant is added. Ordinary
auth paths keep selecting their explicit fields and taking the token row lock;
they do not perform a dummy UPDATE.

The only admitted anchor value is false. A same-value UPDATE is possible and
can create a tuple version/WAL and hold a row lock; it confers no identity or
credential state. True and NULL refuse. Runtime still cannot update digest,
user_id, revoked, created_at or expires_at, insert/delete/truncate tokens,
create schema, rotate/unrevoke/reassign/extend credentials or grant unlimited
access. Existing account/owner powers are preserved, not redesigned here.
Future code must keep the anchor nonsemantic and avoid introducing a trigger
or policy that derives auth authority from its same-value writes.

| Alternative | Benefit | Reason not selected |
| --- | --- | --- |
| Inert false-only anchor | Per-token FOR UPDATE without granting any existing token field; default preserves named-column inserts | One extra internal column; same-value writes remain possible; schema/role qualification required |
| UPDATE on digest, owner, revoked, created_at or expires_at | No extra column | Grants real token mutation authority, including a no-op-looking grant that also permits changed values; rejected |
| Table UPDATE or account-role reuse | Simple privilege administration | Grants rotation, unrevocation, owner/expiry and other powers; rejected |
| Weaker lock or timing-only check | No UPDATE grant | Does not preserve the required token FOR UPDATE serialization; rejected |
| SECURITY DEFINER lock function | Could encapsulate a privileged lock | Adds an explicitly prohibited privileged function/security boundary; rejected |
| Separate lock/identity table or global/advisory auth mutex | Can serialize outside token privileges | Adds another authority structure or changes contention/ordering rather than locking the existing token; rejected |

## Migration, drift and receipt boundary

Migration 032 touches only public.library_tokens and the existing runtime
role's anchor-column ACL. It neither reads nor depends on listening_v2 or
030/031. Register 032 immediately after 029; leave 030 and 031 unregistered.
Do not renumber/rewrite historical migrations or change historical receipts.

`BEGIN;` is the first bytes and `COMMIT;` terminates the file, matching the
actual runner's anchored stripping regex. The runner retains its existing
single transaction and advisory migration lock: schema, backfills from any
earlier fresh migrations, grants and checksummed receipts commit together.
No new auth mutex or transaction boundary is introduced. A SQL or receipt
failure must roll back the whole fresh run/upgrade. Exact direct reapplication
is supported; it does not manufacture a runner receipt.

There is no IF NOT EXISTS schema-fingerprint promise. A missing anchor may be
added only to the ordinary, nonpartitioned, noninherited public token table;
an orphan named constraint refuses. Both direct application and role replay
validate the anchor's built-in boolean type, scalar typmod/dimensions,
NOT NULL, ordinary/local/noninherited/nonidentity/nongenerated form, explicit
false default, and the named local validated nondeferrable false-only CHECK
with exactly this column key and canonical catalog expression. Missing or
different definitions raise SQLSTATE 23514 with a fixed
`auth_token_lock_*_catalog_mismatch` diagnostic. Equivalent-but-differently
defined objects are deliberately refused for review, not silently repaired.
These checks cover this migration's authority objects, not the whole token
schema, all ACL inheritance, triggers, RLS or a complete database fingerprint.
Catalog deparser behavior itself still needs Root's target-PostgreSQL proof.

The runner refuses changed bytes for an existing receipt with
`migration_changed`; it skips SQL for a matching receipt and therefore is
not a general post-receipt drift auditor. Do not edit receipts to conceal
drift. Grant replay revalidates its anchor before granting and fails closed
on drift; it never recreates a missing column/constraint or reruns DDL.

The actual role helper now reads 032 in addition to its unchanged 025/028
inputs. Its `DO $$ BEGIN ... END $$;` regex selects only 032's conditional
GRANT block, including its read-only catalog guard. The separate schema block
uses a distinct dollar tag. When schema precedes role provisioning, an absent
runtime role remains absent, with no login/credential invention. Later owner
provisioning may invoke the existing helper to replay the idempotent block.
Replay does not add token SELECT or other missing bootstrap privileges.

## Wire and local data consequences

Static inspection of all maintained api/scripts/db token references at the
pinned base found explicit token projections in AppAuthStore.credential and
authenticate, SongLibraryStore.authenticate/createUser, AccountStore's token
join, Spotify owner checks, current-auth and privacy composition. No token
`SELECT *`, `t.*`, `RETURNING *` or whole-token JSON serialization reaches a
public DTO. Wildcards on App Attest keys, account identities, other tables and
lyric documents do not project tokens. Existing named-column token inserts
receive false by default. No existing token identity/revocation/expiry value
is changed and no app local data migrates. An intentional internal SQL
`SELECT * FROM library_tokens` after application will include the new column;
future public code must continue explicit projections. Active R2 postimages
remain outside this inspection; Root must check the combined candidate.

## Authored proof and deployment gate

The new integration file uses actual public migration SQL, actual
`migrateLibrary`, actual `replayMembershipRoleGrants` and a restricted synthetic
NOLOGIN `lyra_runtime_v1`. The minimal observed-role fixture temporarily selects
the historical 001-029 manifest through the actual runner, restores it in
finally, and adds only measured token SELECT plus schema USAGE to existing
public-migration grants. It is not a full production bootstrap. No account
writer or current-auth implementation is mocked to grant extra privileges.

Authored cases cover pre-032 zero/populated-row 42501; post-032 zero and real
row lock admission; false-only anchor and all prior authority-field denials;
unchanged identity/expiry and old ACLs; no schema CREATE; exact manifest with
030/031 absent; checksums and immutable receipts; fresh/upgrade atomic rollback
after the grant but before its receipt; direct idempotence under a hostile
search_path; role absence/late replay with no DDL/backfill or tuple rewrites;
and table/type/default/nullability/generated/check drift and replay refusal.
These tests have not run. Syntax-only Node checks do not parse SQL or prove
PostgreSQL privileges, atomicity, production bootstrap or concurrency.

Root must run the sealed tests-only red candidate against the immutable base,
then the combined green candidate and applicable full gate, independently
review it, and qualify actual runtime/account roles and concurrent ordered
writers on the target PostgreSQL version. **Apply and verify 032 with owner
authority before deploying any live writer/current-auth path that requires
token FOR UPDATE.** The ordinary production build verifies the latest receipt;
keep migration credentials outside runtime configuration as APP_AUTH requires.
If schema ran before role provisioning, verify the later replay before writer
deployment. A receipt alone does not prove that the later role has its grant.
No V2 query, route, capability or feature enablement follows from this patch.

Rollback keeps the additive false-only schema and narrow grant. Roll back
dependent writer code only to a compatible version; do not drop the anchor,
widen token UPDATE or rewrite migration history as a recovery shortcut. No
down migration, role creation, DB change or deployment was performed here.
