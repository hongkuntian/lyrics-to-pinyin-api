# Manual PostgreSQL authentication qualification

The maintained manual suites are outside the hermetic test globs:

- `tests/postgres/auth-token-lock-roles.test.js`: restricted-role token locking, migration/replay admission and concurrent real writer methods.
- `tests/postgres/auth-writers.test.js`: authentication writer ordering, exact bearer, preimage/postimage validation, deadlines, rollback and contention.
- `tests/postgres/listening-account-delete-privileges.test.js`: retained account-data deletion and the catalog-checked 036 privilege repair.

The contracts are [token row locks](auth-token-row-locks.md), [writer ordering](auth-writer-order.md), [current authentication](current-auth-context.md), [writer authentication](writer-auth-context.md) and [account exact bearer](account-exact-bearer.md). Shared listening is retired; these suites do not enable it.

## Source and cluster admission

Run only from an explicitly approved, clean, immutable source commit. Supply its full SHA in `LYRA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT`; each harness requires HEAD to match. Changed-input pins are read from that Git object, not refreshed from working-tree bytes. The token-lock suite retains literal pins for unchanged historical inputs and verifies the required ancestry.

`LYRA_TEST_POSTGRES_MANIFEST` must identify a private, nonsymlink, current-UID-owned file for an independently created disposable local cluster. Its marker must contain `purpose: lyrica-auth-local-qualification`, `active: true`, `TCPListening: false`, the exact `sourceCommit`, `ownerUID`, `socketDirectory`, `dataDirectory`, `port` and `user`. The socket directory is private, current-UID-owned and named `/tmp/lyrica-auth-pg-<owned suffix>`. The absolute data directory is likewise private, nonsymlink and owned. No production URL or arbitrary supplied database is an acceptable target.

Before creating fixtures, the harness checks the actual server's data directory, Unix socket, port, current role, superuser capability, absence of TCP listening and supported PostgreSQL version. The marker is evidence to validate, not sufficient authority by itself. Refuse a preexisting fixed fixture role instead of altering or adopting it.

## Migration and privilege boundary

The current registered manifest is 001–028, 032 and 036: 30 migrations. The token-lock upgrade control selects the exact 001–028 baseline through the actual exported manifest and `migrateLibrary`, restores the manifest in `finally`, then applies 032/036. Receipt checks bind names to immutable SQL bytes. The retained-data suite constructs the historical V1 footprint explicitly; it does not register or replay retired feature migrations. Historical 029/030/031/033/034/035 files remain unchanged and inactive.

Runtime fixtures reconstruct observed narrow privileges after removing existing table and column grants in the newly created database. Schema USAGE is fixture admission, not a claim about production ACLs. Runtime token UPDATE is restricted to `lock_anchor`; authority fields remain unwritable. Account fixtures use the real maintained grant helper and separately identified historical prerequisites. Never widen production roles to make a fixture pass.

Real-client assertions include token lock blocking, reader/writer and writer/writer ordering, zero-row admission, original deadlines with final database-clock verification, unchanged bearer authority, transaction rollback and actual account sign-out/deletion methods. The account final authentication verification remains the last SQL statement before COMMIT. PGlite tests complement these cases but do not establish actual PostgreSQL row-lock semantics, deployed role identity or cross-pool database identity.

## Execution and cleanup

With the independently verified owned cluster running and the private marker prepared:

`LYRA_TEST_POSTGRES_MANIFEST=<private marker> LYRA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT=<approved SHA> node --test tests/postgres/auth-token-lock-roles.test.js tests/postgres/auth-writers.test.js tests/postgres/listening-account-delete-privileges.test.js`

Each suite creates random fixture databases, records identity/provenance and checks them before cleanup. Terminate connections only to an exact database created and owned by that run, then drop that database and only its own roles. Never use DROP OWNED, stop another cluster, drop an arbitrary supplied database, rewrite receipts or change global timezone. Drain every held contender and return borrowed clients before cleanup. The external cluster owner stops its own server after the suites finish.

## Evidence limits

Historical PostgreSQL results in the source archive qualify only their original commits and environments, not this retirement candidate. New qualification requires results from the exact clean candidate and actual local cluster. A JavaScript syntax pass is not SQL, privilege or concurrency proof. Hermetic fixtures and read-only retained-data inventory are separate evidence and must be reported separately. No account-data erasure, provider cleanup, migration or deployment follows from reading this document.
