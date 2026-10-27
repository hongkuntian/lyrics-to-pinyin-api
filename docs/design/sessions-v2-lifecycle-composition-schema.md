# Sessions V2 lifecycle composition schema

Source candidate on backend `b88a1486fe0b5bc013ea7012695360aecbf61758` for the
Root-selected lifecycle foundation interface R1, SHA-256
`19b58796ebadc21d71dadb87b342430bcaa90be72a9da45f9432ffabe32a3252`.
The R2 plan is SHA-256
`f745e92b644ba09ccf121406fc459d99cdb4ca0d2345907a4816dee9e349841d`;
approved R5 remains
`7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`.
This document describes proposed source behavior. The bounded worker authored
and sealed tests first, but did not run them or apply any migration. Root owns
red/green, PostgreSQL, service composition, review and delivery.

## Additive storage API

033 adds exactly three columns, using the existing `listening_v2.safe_uint`
domain (`bigint`, inclusive 0 through 9007199254740991):

| Relation | Column | Null/default | Writer change |
| --- | --- | --- | --- |
| `public.library_users` | `sessions_privacy_epoch` | NOT NULL, default 0 | runtime/account UPDATE only this new user field |
| `listening_v2.privacy_personas` | `controller_privacy_epoch` | NOT NULL, default 0 | account UPDATE; runtime gains no UPDATE |
| `listening_v2.privacy_personas` | `private_transfer_from_generation` | nullable, no default | account UPDATE; runtime gains no UPDATE |

The persona's single normalized PostgreSQL JSONB-text aggregate is exactly:

```text
[environment, persona_id, original_principal_id, original_key_id,
 controller_kind, controller_principal_id, controller_key_id,
 privacy_generation, status, guest_credential_digest,
 guest_credential_expires_at_ms, withdrawn_at_ms, scrub_due_at_ms,
 scrub_cursor, created_at_ms, updated_at_ms, controller_privacy_epoch,
 private_transfer_from_generation]
```

All eighteen values share the same <=512-byte limit. The original sixteen-value
CHECK remains too. No other cap, domain, index, foreign key, function, existing
trigger or role privilege from 030/031/032 is replaced or removed. Exactly
eight V2 relations remain. There is no new table, identity family or execution
authority, and no runtime credential-state grant.

## Transition shape

Direct persona INSERT must have a NULL bridge. Guest personas always capture
epoch 0. New Apple personas supply the actual current controller epoch from
the service; SQL accepts only its safe-uint representation and does not look
up or authenticate the controller. Existing Apple rows get capture 0 and a
NULL bridge. NULL supplies no historical bridge; it is never a wildcard or
permission to reconstruct one. An existing Apple row with capture 0 must fail
positive service liveness if its actual controller epoch differs.

The sole bridge-creating UPDATE has old guest/live and new Apple/live state,
old bridge NULL, new bridge equal to exactly the old privacy generation, and
new privacy generation equal to exactly old + 1. Old maximum generation
refuses transfer. The unchanged 030 checks require clearing guest dependencies
and controller key, and require a nonnull Apple controller. The service sets
the captured target epoch in this same CAS; it may differ from the guest's 0.
Thereafter both bridge and captured epoch remain immutable, including through
withdrawal, further generation increments and final erasure. The bridge stays
strictly less than current generation and can exist only on Apple/erased rows.
The unchanged 030 trigger forbids a second controller transfer, origin edits,
generation regression and resurrection. Full compaction can DELETE a persona
after clearing its references under the existing restricted FKs; it cannot
clear immutable origin/capture/bridge fields in place.

User epoch UPDATE may repeat or increase a safe value; decreasing, NULL,
negative, unsafe or wrapping values refuse. The trigger does not require an
increment of exactly one or perform idempotency. Root's erase transaction must
increment once under the controller anchor with durable earliest-time
responsibility; repeated commands cannot increment again. A domain maximum
requires refusal, not reset or wrap.

## Authorization and composition obligations

SQL guards only stored shape and local transition history. They do not prove
GuestLive, exact bearer survival, Apple identity, consent, target controller
epoch equality, controller status, expiry, no-resurrection across dependency
eras, receipt binding, claim/cursor ownership, scheduler capacity or Release.
No SQL trigger acquires user anchors, reads an auth table or introduces locks
outside its ordinary row operation. The actual service must hold the selected
user/token/key anchors, revalidate current source and target authority and
perform the exact CAS before writing these fields.

Positive Apple liveness requires equality with the actual controller user's
current epoch and its enabled/current authority. An epoch increment denies all
older captures before bounded materialization. Historical private-reference
projection may consume only the exact stored bridge with current controller,
epoch and private consent; stale caller writes, uploads, memberships, grants,
public consent and receipt bindings gain no rights. The original immutable
principal/key do not become an authentication alternative.

A current <=512-byte persona alone does not reserve a terminal postimage.
Root's closed codec/retention operation must pre-reserve all future numeric
growth, transfer/withdrawal expansion and the selected compact marker before
admission. Full scrub cursors remain in their typed job payload. This SQL does
not enforce the codec's marker grammar or implement retention admission. SQL
JSONB-text and codec byte agreement still requires Root's differential checks,
including UTF-8 and escaped strings; no tolerance or physical IO claim is
introduced here.

## Privileges and migration boundary

Two new trigger functions have explicit SECURITY INVOKER and fixed
`search_path=pg_catalog`; PUBLIC execution is revoked and no application role
receives EXECUTE. The original `protect_persona()` remains unchanged, with a
separate additive INSERT/UPDATE guard. Conditional column grants address only
existing roles. An absent role is not created; a later role receives no
automatic authority. Root's later catalog-qualified role replay is separate.
Existing INSERT privileges, including runtime persona INSERT, remain subject
to all new guards. Account has no general runtime event/counter/receipt INSERT,
guard DELETE or persona DELETE permission added by 033. Its existing auth
privileges remain unchanged; runtime's 032 token anchor remains false-only.

The migration begins with `BEGIN;` at byte zero and ends with `COMMIT;`, matching
the actual runner's transaction stripping. It intentionally has no blind
`IF NOT EXISTS` or direct-reapply promise. Existing new columns, incompatible
rows or oversized eighteen-value postimages abort the transaction, preserving
the old schema/data/grants. In particular a previously valid sixteen-value
512-byte row may refuse 033. There is no lossy backfill, truncation, automatic
compaction or widening. Root must resolve such a population explicitly.
Runner receipt idempotence and rollback/retry qualification belong to Root;
no migration/helper registration or replay file changes accompany this slice.

## Authored qualification surface and remaining gates

`tests/integration/listening-v2-lifecycle-composition-schema.test.js` applies
actual public fixture migrations followed by 030, 031, 032 and proposed 033 on
the PGlite engine, with synthetic NOLOGIN roles. It has no fake SQL-success
adapter or missing-migration fallback. It authors populated transition and
permission cases, exact 512/513 SQL-byte boundaries including Unicode/escaping,
numeric growth, unchanged old guards/catalogs/V1 data, role absence and rollback
after DDL/GRANT. The test source pins historical SQL and approved R5 bytes.
These are schema fixtures, not fabricated signIn/controller-auth success.

Root can run the exact sealed tests first with an explicitly supplied no-op
033 negative control on the immutable base, then the SQL postimage without
changing test bytes. Neither result was executed by the bounded worker.
Existing schema/lifecycle/public/auth regressions must also pass. Actual
restricted-role PostgreSQL, codec byte crosschecks, live target/session checks,
concurrency, rollback through real writers and A+B integration remain Root's
qualification responsibilities. No codec worker partial is imported here.

033 stays unregistered/unapplied. Construction-off service behavior must avoid
all V2 relations and new fields. Capability, retention, scheduling, routes,
provider/Release and live admission capacity remain off/zero. This isolated
foundation does not complete privacy lifecycle protection. Root must wire and
qualify the entire A+B candidate before claiming that outcome, and separately
qualify later schema/role deployment, scheduler, storage and enablement gates.
