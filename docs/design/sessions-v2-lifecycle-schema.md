# Sessions V2 lifecycle storage support

Unregistered additive storage support based on backend `692b757d7a2c2f050b5e785a7b8e9455edf7c9e0` (git692). Authority is the complete approved [architecture](sessions-v2-architecture.md), SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`, [030 storage contract](sessions-v2-storage-schema.md), and Root's retained app audit `artifacts/review-static/sessions-privacy-composition-r1.md` (SHA-256 `c2c77e05cd6947911cff0bbf40dd4e32a0e00dcaef4d4740d1359abb3ee49c1a`). The audit's own earlier backend pin is historical; implementation facts here were reread from git692 objects, without another worker's postimages.

This slice owns only new `db/031-listening-v2-lifecycle-support.sql`, `tests/integration/listening-v2-lifecycle-schema.test.js`, and this document. Exactly eight V2 tables remain. It adds eight access indexes and one exact-selector unique outbox index; it replaces only 030's closed kind/reference checks and adds a closed dependency-hint shape. No identity table, role, function, trigger, provenance column, enlarged cap, grant, migration registration, route, auth writer, lifecycle service, scheduler, controller-transfer behavior or output execution is implemented. Root owns application, red/green, review, full gates and delivery. No maintained source was changed by the worker.

## Actual source and grants

Public identity authority is the existing `library_users`, `library_tokens`, `app_attest_keys`, `app_auth_sessions` and `account_identities`. Read complete migrations 001/021/025, 029/030, current-auth and actual account/auth/admin/library/Spotify writer paths at git692. Public tokens and keys are globally keyed; a global invalidation cannot stop at the initiating request's V2 environment. `AccountStore.signIn` moves the current key but retains its original metadata; no demonstrated consumer requires an additional controller-transfer provenance column here.

030:531–532 permits account INSERT of exactly `environment,job_id,job_key,kind,persona_id,asset_id,privacy_generation,payload,created_at_ms,due_at_ms,retry_until_ms`. SELECT on V2 tables already exists. It does **not** permit account UPDATE/DELETE of outbox or INSERT of room/guard/revision/send columns. A dependency hint uses the permitted columns and NULL/default values for every reference/fence. Account can enqueue it without new grants. It cannot merge timestamps, advance cursors, claim jobs, create executions or call a privileged shortcut. Runtime's existing outbox SELECT/INSERT/UPDATE/DELETE grants permit the later trusted CAS service, but DDL does not make arbitrary runtime SQL safe.

025:70–78 supplies account's existing public user/token/key/session grants. 030 supplies the V2 grants only if the roles already exist. The role replay helper currently handles 025/028 only, and the runner ends at 029; neither is changed. Actual deployed roles/pools were not contacted. Root must qualify role presence, same authoritative database/schema, row-lock permissions and the complete transaction entrypoints. Separate `LYRA_ACCOUNT_DATABASE_URL` and `LYRA_LIBRARY_DATABASE_URL` do not prove atomicity. Missing authorization/permissions remain a refusal; there is no second-pool or after-commit privacy workaround.

031 relies on the pinned 030 generated names `outbox_kind_check` and `outbox_check3` (the kind-reference table CHECK). Its named replacements are `outbox_lifecycle_kind`, `outbox_lifecycle_references`, `outbox_privacy_dependency_shape`. A leading anonymous DO block refuses a missing/renamed or mixed original/candidate check set before replacement; it creates no stored function. Names do not fingerprint definitions. Root must inspect the complete catalog against actual 030 before application; drift is a different candidate. Reapplying these exact bytes drops/readds only those checks and uses `CREATE INDEX IF NOT EXISTS`; matching-name index drift is **not** validated by IF NOT EXISTS. The authored catalog/idempotence tests check the intended definitions. This is migration-owner DDL with index-build/table locks; no online-build or deployment-duration claim follows.

## Access paths and exact queries

All text index keys here use `COLLATE "C"`, equivalent to current-auth's UTF-8 byte ordering. The query predicate, keyset comparison and ORDER BY must use the same collation. UUID order supplies the complete suffix. Use separate first-page and successor statements; an optional-cursor OR can obscure the seek. Pages select at most 100 rows; discovered auth unions must still fit the existing 64-per-list bound, so process fewer when necessary and persist only the last **processed** cursor. LIMIT bounds results, not scanned history or lock work.

| Index | Keys / predicate |
| --- | --- |
| `privacy_personas_live_credential` | `(guest_credential_digest C,environment C,persona_id)`; guest + live |
| `privacy_personas_live_guest_user` | `(original_principal_id C,environment C,persona_id)`; guest + live |
| `privacy_personas_live_guest_key` | `(original_key_id C,environment C,persona_id)`; guest + live |
| `privacy_personas_live_apple_controller` | `(controller_principal_id C,environment C,persona_id)`; apple + live |
| `privacy_personas_live_guest_sweep` | `(environment C,persona_id)`; guest + live |
| `library_tokens_owner_digest` | `(user_id C,digest C)`; all rows |
| `app_attest_keys_owner_key` | `(user_id C,key_id C)`; all rows |
| `app_auth_sessions_key_digest` | `(key_id C,digest C)`; all rows |

`C` in the table means SQL `COLLATE "C"`. The four dependency selectors are trusted, closed statement choices; never interpolate caller-chosen column names. Credential successor query:

```sql
SELECT environment,persona_id
FROM listening_v2.privacy_personas
WHERE guest_credential_digest COLLATE "C"=$1::text COLLATE "C"
  AND controller_kind='guest' AND status='live'
  AND (guest_credential_digest COLLATE "C",environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::text COLLATE "C",$3::uuid)
ORDER BY environment COLLATE "C",persona_id LIMIT 100;
```

Keep both the dependency equality and the full prefixed successor tuple. With equal dependency values, that tuple has the same strict environment/persona ordering. On the retained populated PGlite fixture, a suffix-only tuple selected the sweep index and filtered 500 unrelated live rows (468 shared hits); the full tuple selected the credential index with zero filtered rows (3 shared hits). This is fixture evidence, not a universal planner or latency guarantee. For the first page omit only the tuple comparison. Guest-user replaces both occurrences of the dependency column with `original_principal_id`; guest-key uses `original_key_id`; Apple-controller uses `controller_principal_id` and literal `controller_kind='apple'`. All select **every** matching environment in this database. Key revocation's guest cleanup excludes Apple-controlled private history, whose current controller remains authoritative even if original K moved to B. Active-authority fencing/controlled grant revocation is separate lifecycle work. Original-key lookup across other statuses/controllers still has 030's existing environment-scoped key index; this hint does not grant rights over B's current key.

The rotating lost-hint sweep selects only the live guest partial index, then checks the actual bounded auth dependencies for those candidates:

```sql
SELECT environment,persona_id FROM listening_v2.privacy_personas
WHERE controller_kind='guest' AND status='live'
  AND (environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::uuid)
ORDER BY environment COLLATE "C",persona_id LIMIT 100;
```

First page omits the tuple comparison. Persist each processed keyset; at end of the whole index, durably complete that sweep pass and schedule the next pass from NULL. Do not repeatedly restart at the first 100 live rows. This bounds visited candidates even when most are still valid; it neither filters unbounded joined history before LIMIT nor scans retired rooms/personas. 030's per-environment deadline index remains available for known-expiry work. No schedule runs in this migration.

Public enumeration must include revoked/expired rows because those rows still participate in deterministic auth locks, closure and no-resurrection checks. For tokens:

```sql
SELECT digest FROM public.library_tokens
WHERE user_id COLLATE "C"=$1::text COLLATE "C"
  AND digest COLLATE "C">$2::text COLLATE "C"
ORDER BY digest COLLATE "C" LIMIT 100;
```

First page omits the `>` clause. Keys use the same statement with table `app_attest_keys`, owner `user_id`, suffix `key_id`; sessions use table `app_auth_sessions`, owner `key_id`, suffix `digest`. This matches owner-wide token/key invalidation and exact-key session replacement/deletion at git692. No session-by-credential or arbitrary predicate is silently covered by these indexes. Batch public writes must precollect/recheck the full relevant scope and lock exact rows in canonical category order. An unbounded bulk UPDATE remains unbounded even when an index exists. Do not use a public enumeration cursor to skip earlier locks.

## Closed dependency-hint envelope

The new kind is `privacy_dependency`. All `room_id,guard_id,persona_id,asset_id,privacy_generation,guard_revision,send_ordinal` are NULL. `job_key` is exactly `privacy-dependency:` followed by canonical `job_id` UUID; it identifies a row, not a dependency. Existing claim/attempt/retry/retention constraints remain intact. The hint cannot be `cancelled`: failed work stays `dead` and retains its coalescing slot. Published rows retain the existing completion+24h minimum; publishing is governed by durable handoff below.

The payload has exactly five keys:

```json
{"version":2,"environment":"test","selector":{"kind":"credential","value":"0000000000000000000000000000000000000000000000000000000000000001"},"cursor":null,"invalidatedAtMS":1800000000000}
```

- `version` is numeric 2, and `environment` exactly equals the outbox row's validated environment, from trusted configuration.
- `selector` is exactly `{kind,value}` for `credential` (64 lowercase hex), `guest-user` or `apple-controller` (exact nonempty stored identifier, <=160 UTF-8 bytes, no whitespace/control), or `guest-key` (canonical base64 encoding of 32 bytes, including canonical pad bits). It is exactly `{kind:"indexed-sweep"}` for the sweep. Unknown keys/kinds, nullable/oversized/wrongly typed values refuse. The service must independently check the actual trusted source row/access kind/ownership; syntactic validity is not authorization.
- `cursor` is JSON null for first page or exactly `[environment,canonicalLowercasePersonaUUID]`. This is a positional global index key, **not** an authorizing persona reference. No profile or persona-generation capability is carried. The target environment can differ from the hint's coordinator namespace by design; every selected target must subsequently use its own exact environment and actual current authority.
- Targeted `invalidatedAtMS` is an exact nonnegative safe integer, <=row creation time, sampled conservatively from actual DB time under the trusted invalidator's locks. It is the earliest retained invalidation, never current sweep/claim time. An indexed-sweep hint requires JSON null here; each expiry/dependency must supply its own actual evidence. A sweep timestamp cannot stand in for a missing revocation timestamp.

Both actual payload and its representation with a maximum 128-byte environment +36-byte UUID cursor must fit **512 normalized PostgreSQL JSON text bytes**. This reserves future cursor growth; it may refuse combinations of long environment/identifier strings that individually fit their field limits. Before retaining V2 data, the trusted admission/configuration gate must ensure all required dependency hints can be encoded with this reserve, as well as 030's <=512-byte eventual persona withdrawal record. No truncation, identity hash substitution or cap increase is allowed. Unsupported combinations keep retention/enablement refused rather than allowing a future mandatory hint to fail after data admission.

There is no room/guard/persona/asset reference or execution field outside that cursor's positional UUID. The exact key whitelist also rejects bearer/public-key/name/Release/execute fields. Existing nondependency outbox jobs retain 030's <=4096 payload limit; this does **not** enlarge anything. Event/result/persona limits stay <=512; guard/room/lifetime caps are untouched.

A trusted database-wide lifecycle coordinator has one fixed valid outbox environment namespace per authoritative database; every global public invalidator uses it. It may be a production, development/test or exact preview identity, selected in deployment configuration, never from the initiating HTTP request. This is where the global public dependency hint/cursor is owned, **not** a restriction to that environment's personas and not authority to expose data across environments. Separate databases have separate coordinators. Unrelated namespaces coalesce independently by SQL; deploying multiple writers with inconsistent coordinator namespaces would lose the single durable earliest record and must fail configuration qualification. Ordinary room/asset/persona jobs stay bound to their target environment. No caller can enqueue a selector or choose a coordinator through a public API in this slice.

## Coalescing, timestamp retention and precise service obligations

Coalescing identity is `(coordinator environment, exact selector JSONB)` under `kind='privacy_dependency' AND state<>'published'`. JSONB equality includes selector kind/value and ignores object key order. No digest collision, cursor, timestamp or random job UUID defines this identity. Pending, claimed and dead rows all retain the same unique slot. Published handoffs are excluded so a later genuine invalidation cycle can create a fresh row while its predecessor retains audit/retention fields. SQL uniqueness alone neither chooses the earliest timestamp nor proves handoff happened.

The later trusted service MUST implement these transactions; none is installed here:

1. **Invalidator/account transaction.** Acquire all applicable existing settings/identity anchors, sorted users/tokens, **all keys then sessions**, connections/guards/personas/grants/rooms as needed, and only then outbox rows. Derive one selector from the actual authorized source mutation, close the dependency and sample its conservative invalidation time with `clock_timestamp()` under those anchors. INSERT the complete hint using the existing account columns, `ON CONFLICT DO NOTHING RETURNING job_id`. On conflict, SELECT exactly the active selector through the unique index (use `environment COLLATE "C"` if the index uses that collation). It must be the same trusted closed identity, and its persisted targeted timestamp must be **<= incoming timestamp**. If that fails, is missing/malformed, or the row was concurrently completed and is no longer found, abort and roll back; retry only as a new bounded authorized attempt or arrange trusted runtime repair. Account cannot repair with UPDATE and must never silently treat DO NOTHING as successful timestamp merging. The common source anchors serialize invalidators; sample time after those anchors, not at transaction entry. A sweep selector has no invalidation time and coalesces its pass without resetting its cursor.
2. **Runtime timestamp repair/merge.** With required earlier identity locks already held, read the exact existing selector row; at the final outbox position use a CAS on row environment/job ID, complete observed payload, state and claim epoch. Pending/dead rows may merge `LEAST(storedInvalidation,incomingInvalidation)`. If incoming evidence is earlier, set cursor to JSON null so nothing is skipped under the corrected deadline. Preserve row identity, selector, creation/retry envelope and claim fencing. A claimed row cannot be stolen/merged by that statement; rollback and coordinate its fenced claim first. A stale CAS affects zero rows and authorizes no work. Do not substitute another selector, broaden the scope or acquire earlier locks from this phase.
3. **Claim and process.** A short outbox-only claim transaction can commit first, releasing its locks. Processing starts a new bounded transaction, discovers identities and acquires all earlier auth locks in the canonical order, then personas/grants/room and the exact outbox row last. Recheck selector, controller, guest dependency, environment, `status='live'`, expected generation, actual deadlines and the full claim epoch/nonce. Commit <=100 processed dependency/persona candidates, once-only withdrawal CAS, typed per-persona `privacy_scrub` jobs/deadline handoff, and the last processed cursor atomically. Each subsequent scrub transaction rewrites at most one <=256KiB room or 100 other bounded rows. Never hold a claimed outbox/persona row lock while trying to acquire an earlier auth row. Each read/commit still checks GuestLive independently of materialized cleanup.
4. **Retry/dead repair.** Keep the earliest timestamp and cursor across attempts and lease changes. Attempts stay <=10 and a row's retry window <=creation+24h. A dead/expired retry envelope is durable repair evidence, never automatic deletion or permission to reset the timestamp to a new creation/sweep time. A separately authorized repair may atomically hand all remaining work to a new bounded successor carrying the **same earliest timestamp**, then publish the old row; it cannot merely reset attempts/creation time in place or mark queue delivery as completion. A repair successor need not process all history at once. SQL does not implement this transition or guarantee scheduling.
5. **Completion and retention.** Only publish after the final candidate range has been rechecked under the same source anchors (including new-retention/no-resurrection serialization), and each selected persona was durably withdrawn/handed to typed scrub with its actual deadline, or positively proved irrelevant due to live transfer/current controller. Persist downstream deadline responsibility before relinquishing the unique slot. Do not publish/delete on a wakeup ACK, lease expiry, temporary scan failure or elapsed 24h. Retain dead/incomplete hints indefinitely pending repair; runtime DELETE privileges do not enforce this policy. Remove a published hint only after its existing retention and durable responsibility checks. New incarnation/reenablement requires proving **no** still-live dependent personas across every environment; a published hint alone is not that proof.

The merge SQL tested by this candidate is the storage recipe (not an implemented API):

```sql
UPDATE listening_v2.outbox SET
  payload=jsonb_set(jsonb_set(payload,'{invalidatedAtMS}',
    to_jsonb(LEAST((payload->>'invalidatedAtMS')::bigint,$6::bigint))),'{cursor}',
    CASE WHEN $6::bigint<(payload->>'invalidatedAtMS')::bigint THEN 'null'::jsonb ELSE payload->'cursor' END)
WHERE environment=$1 AND job_id=$2 AND kind='privacy_dependency' AND payload=$3::jsonb
  AND state=$4 AND claim_epoch=$5 AND state IN ('pending','dead')
  AND payload->'selector'->>'kind'<>'indexed-sweep' RETURNING *;
```

`$3/$4/$5` are the exact server-observed payload/state/epoch, `$6` is trusted validated evidence. No client supplies these as authorization. This SQL preserves the minimum and resets the cursor only for earlier evidence; the service validates identity and source chronology before it. Cursor progress and claim completion require a separate CAS including the current claim nonce/epoch, expected cursor/payload and current generation under the ordered locks. The tests exercise the recipe and stale/claimed refusals; there is no authored production CAS implementation to claim as qualified.

For guest materialization use the earliest proven source event: at minimum the exact credential deadline and, when earlier, the retained credential/user/key invalidation timestamp; never replace either with sweep time. An Apple controller's erasure/deletion uses its own trusted event evidence. A sweep that discovers a revoked/missing dependency but cannot recover its durable invalidation timestamp has found an evidence/repair failure: deny immediately, retain/alert the failure, stop unsupported new retention and repair from authentic retained evidence. Revocation booleans/absence do not timestamp a past event. Do not invent an on-time deletion claim. Known expiry can still use the original exact credential deadline. Queue loss cannot delete the authoritative outbox record; losing that record itself is a separate recovery failure.

## Authority and qualification remain closed

Schema selectors are hints for trusted negative-lifecycle work, never app-user authority, persona liveness, ownership transfer, membership, consent, grant, historical recap access or execution. Guests never execute audio. Lifecycle privacy must preserve exact recording/order/count truth and non-PII replay/guard evidence. It cannot delete guards, clear `may_have_been_sent`, retire possible-path credits, initialize a scope or satisfy Release. Account terminal/counter/event grants required by later real SQL must be separately reviewed; these indexes/hints do not grant them.

No-resurrection checks must use these live dependency/controller indexes before token deletion/reuse/unrevocation/expiry extension or user/key/controller reenablement. Withdraw a bounded batch permanently first, or refuse/defer while the authority remains closed. Do not scan/update all historical personas in an account transaction. Ordinary same-credential 15-minute bearer renewal does not withdraw a persona. Actual GuestLive applies for every audience even with jobs stopped; live narrow G/K→A transfer removes only that persona's dependency before C closes, sibling G/K2 denies immediately, and delete A selects A-controlled old G/K while excluding G/K2/B-owned keys. None of those behaviors is implemented or proven by 031.

Root executed all **11 focused tests: zero failures/skips**, on Node 24.14.1 / PGlite 0.5.8. Worker fixtures were corrected for SQL parameter typing, an all-numeric uppercase-UUID negative case and distinct live installation origins; the migration remained byte-identical. Query tests retain strict index/range/no-sequential-scan assertions, add zero-filter checks and execute EXPLAIN ANALYZE with buffer reporting. These are local single-connection SQL/role/fixture results; the full hermetic and actual PostgreSQL/deployed qualification remain separate. It uses complete unmodified relevant public migrations 001/021/022/025/029, then 030 and 031; it does not replace auth tables with stubs or import auth/provider modules. Coverage: transactional additive rollback/reapply/catalog, eight relations and unchanged columns/roles/functions/grants, V1 preservation, exact admitted/refused shapes, byte/cursor reserve, cross-environment index pages, forbidden references/account execution, exact selector coalescing and dead retention, documented earliest/no-reset/stale CAS, and representative selective plans among 5,000 retired +500 unrelated live personas and 5,000 unrelated public owner rows. Planner tests use real predicates/C collation/keyset suffixes and no forced `enable_seqscan=off`; LIMIT alone is not their evidence. Planned access on synthetic data is not physical IO, latency, deployed throughput or privacy-deadline proof.

Root retains the 030/no-op031 negative control and focused results, and owns the combined hermetic gate, independent source review and actual PostgreSQL catalog/privilege/rollback/barrier qualification under its owned cluster. Real tests must establish claim handoff races, both invalidator/processing orders, no-resurrection/registration/reenablement races, expiry vs transfer, cross-environment closure, complete auth-scope ordering/FK locks, canonical byte sorting under deployment collation, same database/pools and durable timestamp repair/dead retention. Actual scheduler/backlog, once-per-minute admission, cursor rotation, object <=24h/backup <=30d deletion, permission failures, manual PG execution and actual writer hooks remain unqualified. Migration application/registration, live flags, deployed auth/Apple, provider Release/shared writer gate/bootstrap, edge/packaging/load, native/device/phone behavior and complete redesign delivery remain Root's separate gates. No deployment, latency or deletion-deadline claim is made here.
