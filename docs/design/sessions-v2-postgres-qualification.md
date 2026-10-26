# Local PostgreSQL transaction qualification

The explicit manual suite is `tests/postgres/listening-v2-transactions.test.js`. It supplements the hermetic `npm test` gate and is outside its unit/integration/contract globs. Missing local configuration fails; it never creates a skipped pass or uses a production URL. Node's `pg` client and the installed PostgreSQL server execute separate real transactions.

## Owned local cluster

Use PostgreSQL binaries from their normal trusted installation and a new, task-owned data directory. Configure an owner-only socket directory named `/tmp/lyrica-sessions-pg-<unique>`, `listen_addresses=''`, socket permissions `0700`, and an unprivileged port identifier. No TCP listener or background service registration is needed. Keep `fsync` and synchronous commit enabled. Root's observed qualification uses PostgreSQL **17.11**, Unix socket port 6547, 12 maximum connections, 32 MB shared buffers, 3-second lock timeout, 8-second statement timeout and 15-second idle-transaction timeout. These are local test settings, not deployed pool or latency qualification.

Start with `initdb` using local trust and rejected host authentication, then start only that data directory through `pg_ctl`. The manifest is a regular, current-user-owned JSON file with:

```json
{
  "purpose": "lyrica-sessions-v2-local-qualification",
  "active": true,
  "TCPListening": false,
  "ownerUID": 502,
  "dataDirectory": "/absolute/owned/data",
  "socketDirectory": "/tmp/lyrica-sessions-pg-unique",
  "port": 6547,
  "user": "local-cluster-owner"
}
```

Use the actual UID, owner and paths. The suite verifies owner-only socket permissions, actual server `data_directory` and an empty `listen_addresses` before creating anything. It ignores database URLs and creates one randomized `lyrica_sessions_qual_<uuid>` database, applies the committed numbered migrations there, then drops only that database. Its synthetic NOLOGIN runtime/account roles live only in this owned cluster. It never alters an existing application database or starts the default Homebrew cluster.

```sh
LYRA_TEST_POSTGRES_MANIFEST=/absolute/owned/manifest.json \
  node --test --test-concurrency=1 --test-reporter=tap \
  tests/postgres/listening-v2-transactions.test.js
```

Keep the cluster's manifest/logs and test output with the checkpoint evidence. Stop the exact owned server with `pg_ctl -D /absolute/owned/data -m fast -w stop` after execution. Retain the installed binaries and stopped task cluster when further service qualification needs them; remove only enumerated owned disposable outputs after their dependency ends.

## What the suite proves

The suite imports the actual `AppAuthStore.authenticate`, current-auth primitive and receipt gateway. It seeds synthetic users/credentials/attestation-key/session rows in the real schema. No App Attest verification, enrollment, Apple identity, provider or network service is invoked. Its composed receipt hook checks the actual bearer/auth rows and fixed synthetic key manifest; it has no retained persona, membership, consent, grant or output authority. It is deliberately not a production authorization hook.

Thirteen checks cover:

- Exact concurrent creation returning one committed room/receipt, and changed-body mutation retry returning conflict without a second write.
- Both orderings of credential and exact-session revocation, with current-authorized saved-receipt refusal afterward.
- Injected barrier-observation failures for both revocation types, proving pending-operation drainage, rollback, client release and absence of idle transactions before returning the error.
- Transaction identity across pooled-client reuse and real rollback after private reducer output.
- Actual server wall time crossing credential and creation-ticket deadlines during a held mutation, with all writes rolled back.
- The existing V2 runtime/account grant metadata, including column-only account cleanup insertion, denied guard deletion and denied schema creation.

Concurrency checks observe `pg_blocking_pids` and `wait_event_type='Lock'` before releasing the first transaction. The bounded polling is test coordination, not product retry logic. Barrier ownership includes failure paths: mutation barriers release before their operations drain; revocation-first clients roll back before draining the commands waiting on their locks. Revoker acquisition and rollback paths release their clients even if a query fails. Deadline cases deliberately hold a mutation over a preset 1.5-second expiry and sample PostgreSQL wall time; they do not replace the source guard with a fixture clock or extend a product deadline. Every test database is synthetic and disposable.

The revised suite passed **13/13, zero failures/skips**, on the reviewed runtime inputs `2afaa129e1e49f80b08e8a470bbdfd54e213868e`. Both injected-observer regressions first failed against the prior cleanup implementation, then passed with drainage and release in the encompassing ownership scope. The grant assertion checks the migration's narrow column permissions rather than requiring table-wide account INSERT. Run logs, exact harness hashes and the local manifest remain outside Git.

## Remaining qualification

The barrier clients use the local owner role. The last test checks real PostgreSQL metadata for V2 grants; it does not qualify the complete deployed runtime/account privileges, roles or pools. Shared lifecycle writers, privacy/controller/GuestLive composition, admission winners and grant races, output quarantine, real provider execution/terminality, backlog/load/WAL and deployed packaging/WAF remain separate gates. The approved architecture and its no-enable-until-qualified policy remain unchanged.
