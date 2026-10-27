# Sessions V2 output-terminal: manual PostgreSQL qualification source

This is an independently authored manual harness for the disabled first metadata/row slice. Its author read the frozen schema first and ran only JavaScript syntax checking. It is not an observed tests-first red, PostgreSQL pass, deployment receipt, or production role audit. Redesign Root owns application, source review, execution, any corrective implementation and delivery.

Backend authority is fefc00d1cac8f49ddb84972cb7d4ed4b6394052f plus the exact proposed SQL034 SHA256 217cd4b7b48809ea438a33dd6c14e0eebd2f46446c2763fff1ce493b49a1fc54 and terminal-codec SHA256 602c60e226caf67dbff8991f62afb5c59f245a0d859a42d0993aa456e9b76301. The approved architecture is 7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049; the approved auth/output-terminal R2 plan is d169891ee418cce32ce810d349a38640f1c67d8bd098102a58e585b8a5fedc5a. Root's approval record reports 95.75/95/95.75 for design only. Root separately reported 14/14 focused PGlite passes; this author did not execute or inspect that run.

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
| Exact 030–034 application in two fresh databases | Eight V2 relations; unchanged old table owners/ACL/RLS, columns, indexes and constraints apart from the two intended extended closed sets; the old kind/reference branches reconstruct verbatim; pure checker and invoker trigger properties; PUBLIC EXECUTE absent; no migration registration |
| Minimal DDL versus reconstructed observed roles | Fixed aliases exist before all conditional grants. Minimal runtime lacks public-key UPDATE. Reconstructed runtime exactly uses the observed public grant map in committed auth-token-lock-roles; account uses actual historical conditional grants. Both execute checker/row behavior; neither fixture is a deployed-role receipt |
| Unique unfinished selector contention | Two distinct clients/PIDs, owner insertion held before COMMIT, contender observed with Lock and pg_blocking_pids containing exact owner PID, owner COMMIT, loser 23505 even with a newer invalidation timestamp |
| Exact claim and full-envelope refund contention | Separate clients/PIDs and actual blocking witnesses; winner COMMIT, loser zero-row CAS, one debit/refund and monotone epoch. Injected observer failures independently validate both outcomes and pool/transaction drainage for all three races |
| Row continuation simulation | Nine failed-claim settlements remain charged; a failed speculative page/refund transaction rolls back; eleven strict full-cursor success pages cross preview namespaces through live10→pending9; separate complete publication remains9; original chronology preserved |
| Stale envelope/refund | Independently mismatched nonce, epoch, count, payload, identity, references, state and all chronology/terminal fields return zero; a lost-reply replay cannot refund twice; no-progress refund refuses |
| Exhaustion and handoff | Tenth failed claim is dead, cannot claim/reopen/refund/rewrite debt; newer timestamp cannot evade the unfinished slot; atomic state-only predecessor publication plus successor INSERT rolls back on fault and wins together, preserving original payload/count/cursor/chronology/completion/deletion truth |
| SQL-seeded metadata | Correct account capability proves tuple/version immutability, NULL→1 refusal, monotone safe generation and retained v1 DELETE denial; synthetic v1 metadata never establishes attestation, enrollment, source provenance or hardware identity |
| Bounded actual default-off auth method | SQL-seeded normal auth rows feed actual authenticate, prepareWriterAuthentication and AccountStore.signOut under restricted roles. Same-transaction unexpected generation drift is rejected by the actual stable-image finalizer and rolls back auth changes; unchanged NULL/0 signOut succeeds with final clock immediately before COMMIT |
| Account denial | No terminal repair INSERT, claim/refund UPDATE, semantic event INSERT or outbox DELETE; runtime cannot bypass retained terminal evidence DELETE trigger |

The continuation case performs SQL row simulations. It does not select or process eleven semantic rooms, prove a final full selector range, produce End/Leave/events/receipts, authenticate a negative source, qualify an era fence or implement a trusted terminal/repair store. The actual-method case does not call App Attest or Apple enrollment/crypto. Its synthetic stored auth preimages are explicit; an unused external cleanup callback prevents postcommit queue IO. The previously reported actual-method PGlite and old PostgreSQL 63 results remain separate receipts, never added to this source or a later run's count.

No claim-expiry fixture disables a trigger here. No sleep, retry loop, increased attempt bound or inflated deadline establishes acceptance. The blocker loop repeatedly queries actual database facts within the existing 2-second witness deadline; 3-second lock, 8-second statement, 15-second idle-transaction and 10-second barrier limits are safety bounds inherited from the current manual model. Root must preserve failures and measure their cause before changing any bound.

## LT-01: inherited metadata privileges remain an objection

The old observed runtime has table-level INSERT/UPDATE on public.app_attest_keys. Account already has table-level SELECT/INSERT/UPDATE/DELETE from 025. PostgreSQL table privileges extend to newly added columns. Therefore SQL034's absence of new GRANT statements does not make new metadata inaccessible to those reconstructed roles.

The harness positively demonstrates valid syntactic v1 INSERT and generation increment through those inherited privileges, while asserting minimal runtime 42501 separately. The v1 retained-anchor DELETE test uses account, which actually has DELETE, and expects trigger 23514; runtime's missing DELETE is not offered as trigger proof.

This is an exact least-privilege objection: the reconstructed runtime can set sessions_install_binding_version on INSERT and update sessions_authority_generation without the proposed narrow consuming ownership CAS; account can seed syntactic v1 without a verified enrollment producer. No table/column grant or invoker trigger authenticates provenance. A blanket assertion that runtime receives 42501 on new columns would be false for this footprint. Passing these characterization tests cannot close the R2 least-privilege or positive provenance gate. Root must resolve that separately under reviewed ownership; this task changes neither 034 nor old grants, codecs or runtimes.

## Cleanup and ownership

The suite takes the same fixed-role advisory lease as the committed token-role harness. Both lyra_runtime_v1 and lyra_account_v1 must be absent before creation. Only this run's successful CREATEs, recorded OIDs, exact comment tag and nonprivileged role attributes are cleanup candidates. No preexisting role is adopted, altered or removed.

Each fresh database name contains this run's random tag and minimal/observed suffix. Creation is tracked before subsequent setup steps; owner/OID/tag are checked before drop. A failure before COMMENT can clean only the exact successfully created name with the same owner/OID and no foreign tag. No preexisting database, DROP OWNED, forced termination or cluster stop is used.

Every transaction has finally-ROLLBACK/release, including failed DDL setup. Race finally blocks release the owner hold, drain both full outcome promises, validate unexpected contender errors independently of observer failures, and inspect pool borrowers and idle transactions. Teardown releases any remaining owned holds, drains pending outcomes, releases borrowers, closes the pool before database DROP, then drops only verified created roles and closes the admin client. Setup/manifest/import/observer/assertion errors all reach the encompassing finally. Unknown ownership or an unclosed/unaccounted session produces a cleanup failure and retained identity rather than destructive cleanup.

Actual evidence must record combined source commit, refreshed pin diff, server version/system identity, exact command, TAP and exit status, blocking PID witnesses, both footprint results, LT-01 disposition, cleanup and any failures. A test pass establishes only the above representation/SQL concurrency and bounded actual-method facts.

Public V2/cohorts/capabilities remain off; live retained-profile capacity remains0. Guard binding/account anchors/room mirrors/approval witnesses, actual enrollment/producers, semantic End, terminal store, full source/finite repair authorization, scheduling/retention/load, deployed pools/roles, provider Release and native/deployment qualification remain deferred.
