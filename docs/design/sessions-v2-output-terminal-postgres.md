# Sessions V2 output-terminal: manual PostgreSQL qualification source

This manual harness proposes the disabled LT01 metadata-privilege correction against immutable `ce6d0d03ae3c3fc163cdbb3aba71acfbb2096a4d`. The original harness followed frozen034; the affected LT01 assertion bodies were sealed before the new privilege behavior. This author ran JavaScript syntax checks only. It is not an observed semantic red/green, PostgreSQL pass, deployment receipt, or production role audit. Redesign Root owns pin refresh, application, source review, execution, any corrective implementation and delivery.

The prior SQL034 SHA256 217cd4b7b48809ea438a33dd6c14e0eebd2f46446c2763fff1ce493b49a1fc54 is retained in the initial test pins for honest chronology; it is not the proposed SQL identity. Root must review the separate post-freeze pin-refresh diff and independently pin the assembled candidate before execution. The terminal-codec SHA256 remains 602c60e226caf67dbff8991f62afb5c59f245a0d859a42d0993aa456e9b76301. Approved architecture/R2 hashes remain 7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049 / d169891ee418cce32ce810d349a38640f1c67d8bd098102a58e585b8a5fedc5a; three design reviews approved95.75/95/95.75. Root's prior PG17 parent passed two footprints, six exact-client lock witnesses and structural/accounting simulations; those test databases are gone. That receipt and prior canonical2102 result remain historical, never post-fix qualification.

The separately published unused install encoder at 649c918e36a3d20bf52cea1684f87166002c00cc does not replace those old runtime/DDL inputs. This harness imports applied maintained paths only. Artifact implementations must never be imported as substitutes.

## Entry and refusal boundary

After applying and reviewing the combined candidate, Root supplies two explicit environment variables:

    LYRA_TEST_POSTGRES_MANIFEST=/absolute/private/local-marker.json
    LYRA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT=<independently-approved-40-hex-combined-commit>

Run only this manual file, from that applied backend checkout:

    LYRA_TEST_POSTGRES_MANIFEST=/absolute/private/local-marker.json \
    LYRA_TEST_POSTGRES_EXPECTED_SOURCE_COMMIT=<approved-commit> \
    node --test --test-concurrency=1 tests/postgres/listening-v2-output-terminal.test.js

Use the existing installed pg dependency and supported Node version; this task does not install dependencies. The test is intentionally outside routine hermetic globs. No package script, CI, migration list, deployment switch or credential configuration is changed. Missing or invalid manifest is a failing refusal, never a skipped test. Remove ambient PG* variables. Neither DATABASE_URL nor account/library URLs, .env, pg service files or password files select a connection.

Before importing pg or application modules, the test compares externally approved commit = HEAD = manifest.sourceCommit, requires BASE ancestry, rejects source/index and nonignored untracked changes outside node_modules, requires maintained target paths to be tracked, and validates its embedded source pins. It also verifies the migration source remains unregistered. The new test and this document are verified through the exact approved clean Git commit, avoiding a circular self-hash. Root must independently approve the combined commit and supply that value; deriving the expected value from the manifest or HEAD would defeat this boundary.

The embedded pins cover 001–034, the frozen six-file schema proposal, relevant old auth/protocol source, the three existing PG harnesses and migration runner source. They are exact input pins, not a claim that every hashed transitive module or historical migration was fully reviewed by this author. The approved clean commit supplies the broader transitive application-source boundary. The Root runner separately checks the exact approved installed dependency inventory before and after execution, including the task-owned npm-ci restoration; the source cleanliness exception is limited to node_modules. Installed dependency integrity and runtime qualification remain Root obligations.

## Private local manifest

The explicit current-user-owned regular file must have mode exactly 0600 and one link. It is opened with O_NOFOLLOW, bounded to 16 KiB, read through that same descriptor and closed even on parsing failure. The consumed fields are:

| Field | Required value |
| --- | --- |
| purpose | lyrica-sessions-v2-local-qualification |
| active / TCPListening | true / false |
| ownerUID | current process UID |
| sourceCommit | exact independently approved Root expected commit |
| systemIdentifier | decimal string from this local cluster's pg_control_system().system_identifier |
| socketDirectory | /tmp/lyrica-sessions-pg- followed by a local tag |
| dataDirectory | absolute owned private directory, final component not a symlink |
| port | integer 1025–65535 for the Unix socket filename |
| user | explicit local bootstrap role, checked against current_user and session_user |

Root may add the missing identity/source fields to its current local marker after independently inspecting its disposable local cluster. This author has not accessed an actual marker, server, configuration or credential. No field accepts SQL, connection strings, arbitrary client options, fixture identities, database names or role-grant overrides.

Socket/data directories must be current-user-owned and private; the final socket must be owned and actually a socket. Server checks require the named local data directory, port, system identifier, Unix-only client/server addresses, empty listen_addresses, current database postgres, exact bootstrap owner, PostgreSQL 17+, fsync on, synchronous_commit on and UTC. Fully explicit pg options select only that Unix socket. These facts qualify a disposable local server when executed, not configured or deployed databases.

## Cases and actual evidence boundary

| Discriminator | Assertions |
| --- | --- |
| Exact 030–034 application in two footprint databases plus a late-role fixture | Eight V2 relations; unchanged old table owners/RLS, column definitions, indexes and constraints apart from the two intended extended closed sets; key-table INSERT/UPDATE intentionally narrow to preserved effective old-column rights; all unrelated ACLs remain; pure checker and invoker triggers; PUBLIC EXECUTE absent; no migration registration |
| Minimal DDL versus reconstructed observed roles | Fixed aliases exist before all conditional grants. Minimal runtime lacks public-key UPDATE. Reconstructed runtime exactly uses the observed public grant map in committed auth-token-lock-roles; account uses actual historical conditional grants. Both execute checker/row behavior; neither fixture is a deployed-role receipt |
| Unique unfinished selector contention | Two distinct clients/PIDs, owner insertion held before COMMIT, contender observed with Lock and pg_blocking_pids containing exact owner PID, owner COMMIT, loser 23505 even with a newer invalidation timestamp |
| Exact claim and full-envelope refund contention | Separate clients/PIDs and actual blocking witnesses; winner COMMIT, loser zero-row CAS, one debit/refund and monotone epoch. Injected observer failures independently validate both outcomes and pool/transaction drainage for all three races |
| Row continuation simulation | Nine failed-claim settlements remain charged; a failed speculative page/refund transaction rolls back; eleven strict full-cursor success pages cross preview namespaces through live10→pending9; separate complete publication remains9; original chronology preserved |
| Stale envelope/refund | Independently mismatched nonce, epoch, count, payload, identity, references, state and all chronology/terminal fields return zero; a lost-reply replay cannot refund twice; no-progress refund refuses |
| Exhaustion and handoff | Tenth failed claim is dead, cannot claim/reopen/refund/rewrite debt; newer timestamp cannot evade the unfinished slot; atomic state-only predecessor publication plus successor INSERT rolls back on fault and wins together, preserving original payload/count/cursor/chronology/completion/deletion truth |
| Metadata privileges and owner-only seeds | Both metadata columns deny runtime/account INSERT/UPDATE42501 in both footprints. All old key columns retain effective rights and applicable actual positive writes/defaults. Owner-only syntax seeds prove tuple/version immutability, NULL→1 refusal and monotone safe generation; account has DELETE and really reaches retained-anchor23514. No attestation/enrollment/provenance/hardware claim |
| Real replay and late role provisioning |034 applies with roles absent; actual fixed roles are then created and the actual helper replayed. After every actual autocommit replay query, a distinct client tries metadata writes. One indivisible statement is required; split broad GRANT/correction exposes a failing boundary. Also try while replay's outer transaction is uncommitted and after COMMIT; all metadata writes deny |
| Bounded actual default-off auth method | SQL-seeded normal auth rows feed actual authenticate, prepareWriterAuthentication and AccountStore.signOut under restricted roles. Unexpected generation drift is an explicitly owner-only same-client fixture injection, with account role restored before the actual stable-image verifier. Auth changes and drift roll back; unchanged NULL/0 signOut succeeds with final clock immediately before COMMIT |
| Account denial | No terminal repair INSERT, claim/refund UPDATE, semantic event INSERT or outbox DELETE; runtime cannot bypass retained terminal evidence DELETE trigger |

The continuation case performs SQL row simulations. It does not select or process eleven semantic rooms, prove a final full selector range, produce End/Leave/events/receipts, authenticate a negative source, qualify an era fence or implement a trusted terminal/repair store. The actual-method case does not call App Attest or Apple enrollment/crypto. Its synthetic stored auth preimages are explicit; an unused external cleanup callback prevents postcommit queue IO. The previously reported actual-method PGlite and old PostgreSQL 63 results remain separate receipts, never added to this source or a later run's count.

No claim-expiry fixture disables a trigger here. No sleep, retry loop, increased attempt bound or inflated deadline establishes acceptance. The blocker loop repeatedly queries actual database facts within the existing 2-second witness deadline; 3-second lock, 8-second statement, 15-second idle-transaction and 10-second barrier limits are safety bounds inherited from the current manual model. Root must preserve failures and measure their cause before changing any bound.

## LT01: proposed withholding; qualification remains pending

The old observed runtime has table-level INSERT/UPDATE on public.app_attest_keys. Account already has table-level SELECT/INSERT/UPDATE/DELETE from 025. PostgreSQL table privileges extend to newly added columns. Therefore SQL034's absence of new GRANT statements does not make new metadata inaccessible to those reconstructed roles.

The correction replaces those positive metadata characterizations with actual42501 assertions after explicit table-to-old-column narrowing. Every pre034 old-key column retains effective INSERT/UPDATE; table SELECT/DELETE and other privileges remain. Metadata syntax seeds/generation shape checks run only as migration owner. The v1 retained-anchor DELETE test still uses account with real DELETE and expects23514; runtime's missing DELETE is not offered as trigger proof.

034 contains one catalog-checked, privilege-only tagged block. The replay helper nests the exact025/028/032 grant bodies and that block inside a single DO statement; no separate autocommit broad-grant window is proposed. It also works in membership-admin's existing provision transaction. Roles-before034 and034-before-late-role orderings are both authored tests. Genuine V1 schema absence keeps old behavior; partial metadata/catalog or residual effective metadata access through owner/superuser/PUBLIC/inheritance refuses and rolls back without revoking unknown third-party roles. Replay does no unrelated DDL/data or034 registration. No production callbacks or actual auth/runtime API changes are used.

This source proposal does not close LT01 by execution or supply positive provenance. Root must refresh exact pins, establish semantic red (not source-pin/import refusal), execute the applied combined candidate, preserve six PID witnesses/owned cleanup/dependency and global staged-input admission, and independently review the results. Both test files' assertions remain sealed byte-for-byte; a separate pin-refresh diff necessarily changes only manual-harness declarations after behavior/docs freeze. A new helper pin declares its old ce6d hash before the behavior change and is explicitly included in that refresh. Enrollment, generation CAS consumers and general unrelated V2 late-role provisioning remain deferred; metadata grants stay withheld.

## Cleanup and ownership

The suite takes the same fixed-role advisory lease as the committed token-role harness. Both lyra_runtime_v1 and lyra_account_v1 must be absent before creation. Only this run's successful CREATEs, recorded OIDs, exact comment tag and nonprivileged role attributes are cleanup candidates. No preexisting role is adopted, altered or removed.

Each fresh database name contains this run's random tag and minimal/observed suffix. Creation is tracked before subsequent setup steps; owner/OID/tag are checked before drop. A failure before COMMENT can clean only the exact successfully created name with the same owner/OID and no foreign tag. No preexisting database, DROP OWNED, forced termination or cluster stop is used.

Every transaction has finally-ROLLBACK/release, including failed DDL setup. Race finally blocks release the owner hold, drain both full outcome promises, validate unexpected contender errors independently of observer failures, and inspect pool borrowers and idle transactions. Teardown releases any remaining owned holds, drains pending outcomes, releases borrowers, closes the pool before database DROP, then drops only verified created roles and closes the admin client. Setup/manifest/import/observer/assertion errors all reach the encompassing finally. Unknown ownership or an unclosed/unaccounted session produces a cleanup failure and retained identity rather than destructive cleanup.

Actual evidence must record combined source commit, refreshed pin diff, server version/system identity, exact command, TAP and exit status, blocking PID witnesses, both footprint results, LT-01 disposition, cleanup and any failures. A test pass establishes only the above representation/SQL concurrency and bounded actual-method facts.

Public V2/cohorts/capabilities remain off; live retained-profile capacity remains0. Guard binding/account anchors/room mirrors/approval witnesses, actual enrollment/producers, semantic End, terminal store, full source/finite repair authorization, scheduling/retention/load, deployed pools/roles, provider Release and native/deployment qualification remain deferred.

## Separate baseline limitation

The hermetic restricted-role auth fixture exposed a preexisting029 account-deletion refusal at listening_rate_windows (DELETE exists, SELECT(user_id) does not). Its owner-level positive deletion control is preserved; the restricted control records exact42501 and full rollback rather than adding a fixture-only grant. This manual harness's actual signOut finalizer proof does not qualify restricted account deletion. LT01 narrows only installation metadata; the unrelated cleanup privilege requires separate repair/qualification.
