# Private Sessions admission authority composition

This disabled composition is assembled on published backend `c1276490933b163d2fc716826993bed4e6e3c39e`. The retained worker assignment was `d95b75932dd6c9b4966e256d28df2d7fc1957b2d`. Authority is the full approved architecture, SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049` (Root's 92/92/91.5 gate). The pre-service audit `sessions-privacy-composition-r1.md` was reconciled against the actual current-auth, receipt gateway, admission domain, SQL service and migration 030 at this assignment. Its proposed public permit interface is not the delivered API.

The original three-file composition is extended by the coordinated lifecycle candidate based on `b88a1486fe0b5bc013ea7012695360aecbf61758`. Its private methods require the additive 033 controller-epoch and transfer-bridge fields; construction still performs no SQL. The complete A+B lifecycle checkpoint, actual PostgreSQL/role qualification and later enablement gates remain required. V2 routes/capabilities, migration registration, broker and providers remain off/untouched. Root owns combined verification, integration and delivery.

## Executable API

```js
import {createPrivateAdmissionService} from '../../api/utils/listening-v2/privacy-context.js';
const service = createPrivateAdmissionService({
  db, environment, policy,
  bindingKeys, activeBindingKeyVersion,
  receiptKeyPolicy: {environment, keys: [{version, verificationHash}]},
  ticketKeys, activeTicketKeyID,
  pairKeys, pairPolicyRevision,
  antiAbuse: {authorize}
});
await service.execute({bearer, rawCommand});
await service.readReceipt({bearer, rawCommand});
await service.readAdmission({bearer, rawQuery});
```

The factory is the only export. It constructs an actual `AppAuthStore`, `createCurrentAuthContext` and `createAdmissionStore` internally. There is no caller-supplied authentication tuple, current-auth instance, privacy predicate, clock, transaction, persona list, controller list, resolver, permission flag or reducer. No internal scope/permit escapes. All public inputs are closed own-data records. Capture exact bearer/raw text before awaiting. The bounded raw JSON parser rejects duplicate/escaped aliases, unsafe source numbers and over-16-KiB input before domain work.

`execute` supports only these accepted local admission intentions:

| Action | `expected` | `payload` |
| --- | --- | --- |
| `admission.decide` | `{requestVersion}` | `{requestID, decision:'approve'|'deny'}` |
| `admission.cancel` | `{requestVersion}` | `{requestID}` |
| `leave` | `{memberLeaseVersion}` | `{}` |

Their common envelope is `{version:2,action,sessionID,commandID,expected,payload}`. The response is the accepted receipt gateway's small `{version,sessionID,commandID,status,result,replayed}` projection. It carries no installation/persona/controller/credential/profile or audio authority. Both host and exact active guest members may decide. Cancel is exact requester-only. Leave is guest-only and preserves the captured lease CAS. A new unauthorized operation throws before writes; valid domain revision conflicts retain the existing service's durable refusal semantics.

`readReceipt` accepts the same exact intention. It performs current authorization and hash/action comparison, returns the same small saved result, and writes nothing. Missing results refuse `not_found`. `execute` exact retries also perform current authorization before returning or disclosing a changed-body conflict. Neither method reruns the original active lease precondition to read a saved Leave result; a former member with current privacy rights can receive that receipt without recovering current membership. A different principal/key does not inherit old receipt HMAC bindings after an account move.

`readAdmission` accepts exactly `{version:2,action:'admission.read',sessionID,payload:{requestID}}` as `rawQuery`. It returns `{version:2,sessionID,admission}` for the requester/current private controller only. A pending result has `id,version:1,status:'pending',expiresAtMS`; a due pending request refuses `expired` until the real terminal transition exists. A retained terminal result has `id,version:2,status,memberID,memberLeaseVersion`; these are historical references, not current lease authority. No host-only projection, profile/photo, asset, whole-room state, name, controller identifier or credential is exposed. This is a private local API, not a published HTTP/wire extension.

Create, admission request, profile/consent writes, resolve/capture, settings, Forget, End, lifecycle removal/expiry, transport, execution, sharing and every other action explicitly refuse `unavailable`. There is no fallback registry or implicit capability. Missing positive-work dependencies refuse, not default-allow.

## Trusted construction dependencies

`db` supplies `query` and a same-client `transaction(callback)` with immediate COMMIT after success and ROLLBACK after exceptions. The two methods are captured at construction. Root must configure bounded statement/lock/transaction deadlines and qualify actual role privileges and shared database identity. The service takes no second pool and does not own a runner.

`policy` is the real AppAuthStore policy `{audience,environment,prefix,bundles}`. Its closed copied snapshot is frozen; current-auth enforces deployment/attestation/audience/bundle configuration. `prepare` invokes the actual `AppAuthStore.authenticate` on the exact submitted `lyra_s_` bearer. No extracted prior tuple can replace it. Synthetic SQL auth rows in tests still pass through this real method.

Receipt and ticket rings are separately copied, bounded to four versions, and closed to `{version,secret:Buffer}` / `{id,secret:Buffer}`. Receipt descriptors are independently provisioned server policy, not derived from the caller-supplied manifest. Construction computes each actual ring verification HMAC over `['sessions-v2.receipt-key-check',version,environment]`, compares the complete sorted descriptors to that policy, then snapshots their SHA-256 manifest. The receipt hook checks its supplied descriptors and manifest hash against this independently validated snapshot. Replacement secrets under the same version refuse construction; later mutation of the original buffers/policy/descriptors cannot change the service. Ticket keys remain required by the accepted gateway even though creation is unavailable.

`pairKeys` is a fixed optional one-to-four-version server ring. A pending approve/deny needs exactly one matching digest:

```js
HMAC_SHA256(secret, JSON.stringify([
  'sessions-v2.returning-pair', version, environment, hostInstallScope, originalGuestKeyID
]))
```

The accepted pending row supplies the exact digest; this composition verifies it rather than substituting the active key/version. Existing grant version must match. `pairPolicyRevision` is a fixed trusted nonnegative safe integer; no request overrides it. Missing keys/revision or an ambiguous/mismatched digest refuse. The new random member/grant IDs are server generated; a known rejoin reuses its exact member ID. No unrelated grant is enumerated. Pair provisioning and consistent policy/key retention across cooperating deployments remain trusted configuration obligations.

Positive pending approval additionally requires fixed `antiAbuse.authorize(request)`. Its closed request is `{version:1,environment,principalID,keyID,sessionID,commandID,bodyHash,pairDigest}`. Its closed answer repeats every binding exactly and adds `{status:'allowed'|'denied'|'unavailable',notAfterMS}`. Only a matching allowed, finite, currently valid result qualifies; its deadline enters the final minimum. This boundary must perform short bounded local/transaction-safe work with no provider/network IO, extra database transaction or earlier lock acquisition. Tests explicitly fixture this external antiabuse boundary. Deployment/install/principal/room/pair budgets, enrollment/resolve circuits and cleanup readiness are not implemented here. Negative cancellation/denial/Leave and saved retries do not depend on a new positive-work permit. The service consumes retained pending profile/consent references; profile creation/update and resolve verification remain unsupported, not permissively stubbed.

## Discovery, locking and fresh liveness

Initial reads are nonlocking and target one addressed room's validated admission slice, one exact receipt namespace across the retained ring, at most two targeted terminal UUIDs, the exact actor origin and one target pair/grant. They never use the room's historical cleanup mirror or enumerate terminal history. The practical source envelope is at most 25 retained members plus 10 pending requests, plus actor, host, exact terminal/receipt and grant-side dependencies. Actual slice byte limits can refuse before these count maxima coexist.

Deduplicated user/token/key lists are separately capped at 64, and the real current-auth primitive independently adds actual owners and enforces its final per-list bounds. No list is trimmed or enlarged to force success. Hundreds of unrelated terminal references do not add live credential checks. Closed member metadata remains available to the service without requiring its old token or a nonrevoked key.

Exactly one `currentAuth.discover` and `lock` occurs in the transaction. The order is sorted users, tokens, all keys, exact bearer session, sorted personas, target host grant row/absence, then the existing gateway's room/receipt/event/outbox work. The original host key is precollected even when no grant exists; it serializes absent-grant creation among cooperating writers. No connection/output guard is relevant to these metadata-only operations. There are no guard reads or writes, initialization, Release, audio claims or provider actions.

Canonical persona and retained key metadata snapshots are compared after locks. The locked room, receipt, known terminal outcomes and pair/grant preimage must still match discovery. Newly referenced identity, changed controller/origin/generation/metadata or scope drift throws and rolls back; there is no late earlier lock or scope expansion. The same client/xid and immutable command are revalidated. The accepted gateway alone may retry SQLSTATE 40001/40P01; composition conflicts require an external fresh attempt of the same intention, not an internal polling/retry loop.

Every positive or exposed guest persona is checked with a materialized SQL `clock_timestamp()` CTE against the actual tables: canonical live generation/controller, enabled guest original principal, exact bound token owner/digest/nonrevocation, finite conservatively decoded actual expiry equal to the retained deadline and at most persona-created+90 days, and exact original key owner/nonrevocation/bundle/audience/attestation environment. Null, unsafe, nonfinite, changed or missing dependencies refuse. No other participant's current 15-minute bearer is required. A host's valid bearer cannot authorize another expired guest. Supplemental locks alone never count as GuestLive.

Apple-controlled private history instead requires current enabled Apple controller A. It does not require old guest C or require K still to belong to A. **Active** member/pending installation authority additionally requires the exact original principal still to be its controller, current retained key ownership/nonrevocation, exact installation metadata and the current service member/lease. Thus current controller history rights cannot admit a moved installation or authorize old guest writes.

The permit deadline is the minimum of actual actor session/credential, every positive-reference guest expiry and any positive-work permit. Positive pending approval and pending projection also include the exact admission expiry; an already due positive approval refuses `expired`, and crossing after authorization rolls back. Read-only revalidation repeats the current bearer, persona/controller/dependency and scope checks on the same transaction before mutation/replay/conflict disclosure and after writes. The gateway/read wrapper's final fresh SQL clock covers time spent inside the hook. No caller clock is accepted; `now()` is never privacy liveness proof. The database wrapper must immediately commit; no application check guarantees that wall time cannot cross a deadline during COMMIT itself.

## Historical facts and deliberate refusals

Readable/current authority and exact historical terminal metadata have separate closure-private brands. Historical origin principal/key comes from the canonical persona, and bundle/audience/attestation metadata comes from its retained App Attest key, never the deciding actor or the key's new owner. Missing/scrubbed metadata refuses with no new winner/member/grant. Closed `left`/`removed` member references may retain a non-regressed later canonical generation solely as negative markers; this grants no current rights or projected private data.

At `d95b759`, the accepted service deliberately requires a current live exact-generation persona before invoking terminal hydration. This composition preserves that refusal for withdrawn terminal losers. A revoked/expired positive pending reference also refuses; the later coordinated lifecycle checkpoint owns permanent withdrawal/terminal closure. No new lifecycle mutation is smuggled through denial, Leave or a read.

An Apple positive projection additionally requires the persona's captured `controller_privacy_epoch` to equal its enabled controller's current `sessions_privacy_epoch`. Every revalidation checks that canonical equality using fresh SQL; an erase fence denies reads, saved outcomes and changed-body disclosure while materialized cleanup is stopped. This does not disable the account or require an original guest credential to remain live.

Only `readAdmission` may map a branded, server-retained terminal reference whose generation equals the canonical persona's exact `private_transfer_from_generation` to that persona's current generation. The current Apple controller must authenticate and pass canonical liveness/epoch checks. No other older generation is accepted. The stored event is unchanged, and the result still contains only minimal historical status/member identifiers. Pending references, active admission/lease rights, image or write capabilities and G's principal/key-bound command receipts never use this bridge. A direct legacy Apple row with a null bridge refuses an older reference. Synthetic SQL fixtures exercise these distinctions; they do not establish actual sign-in transfer, room/image consent or lifecycle execution. Actual transfer writers and every later PII surface remain part of the coordinated lifecycle work.

The assembled base `c127649` includes both interface-preserving service repairs: overdue admission-expiry scheduling and numeric wake watermark decoding. The worker qualification checkout did not include them; Root must verify this combined source before publication. Their inclusion supplies no real-PG privacy or lifecycle qualification.

## Executed evidence and retained limitations

Affected-suite command, Node `v24.14.1`, installed PGlite `0.5.8`, one test process/file at a time:

```sh
node --test --test-concurrency=1 \
  tests/integration/listening-v2-privacy-context.test.js \
  tests/integration/listening-v2-auth-context.test.js \
  tests/integration/listening-v2-admission-store.test.js \
  tests/integration/listening-v2-receipt-store.test.js
```

**136 passed, zero failed/cancelled/skipped** in 23.223 seconds: then-25 composition cases, 35 current-auth, 46 admission-store and 30 receipt-store regressions. Final review then added the pending-admission deadline regression and correction. The final composition-only run passed **26/26, zero failed/cancelled/skipped**, in 5.159 seconds; the unchanged 111 dependency regressions retain the matching earlier proof. Thus 137 distinct affected tests have passing evidence, across these two runs, not a claimed single 137-test run. The composition suite applies the actual unchanged 001/021/025/030 migrations and invokes actual AppAuthStore/current-auth/receipt/admission code. Auth rows are synthetic; only antiabuse and the renewal assertion verifier are explicit external-boundary fixtures. No actor-only boolean auth permit supplies a positive result.

The real pending-admission expiry regression first committed after its 120-second boundary despite live credentials. Folding that exact deadline into the permit made the regression pass and roll back all effects. Its red-to-green patch/hashes and failure log are retained. The real active-install regression first failed with “Missing expected rejection” because Apple history authority admitted a moved key. The owned composition correction made it pass; its exact red-to-green patch/hashes and both logs are retained. A separately labeled mutation control temporarily removed supplemental GuestLive, then failed on revoked OTHER guest replay; the original source was restored byte-for-byte before the 136-test gate. Initial missing-module and fixture-setup failures are also retained, not counted as passing proof.

Coverage includes other-guest revocation/expiry across host mutation/saved replay/read/conflict disclosure; a real DB deadline crossed during receipt INSERT rolling back all room/grant/event/outbox/receipt changes while `now()` remained stale; expiry with cleanup absent; exact bearer renewal through actual challenge/session methods; retained closed history with deleted old token/revoked key; grant approver liveness; 299 unrelated terminal events with only two live auth scopes; new room/terminal/controller/receipt identity drift; same-xid refusal; independent manifest checks and immutable configuration; metadata scrub/substitution; exact saved Leave retries; and unchanged sent/uncertain guard evidence/reservations.

The xid-mismatch test deliberately faults a driver result; scope/reference race tests inject SQL at transaction boundaries on one embedded connection. They establish refusal/rollback, **not concurrent PostgreSQL blocking, deadlock ordering or live role qualification**. Real App Attest/Apple sign-in, shared lifecycle/no-resurrection, global revocation indexes, distributed policy/antiabuse, roles/pools, real PostgreSQL barriers/deadlines, Full/npm gate, HTTP/provider/native and deployment qualification remain Root-owned. No PostgreSQL cluster was started or touched.

Actual AppAuthStore import succeeded with the existing restored dependencies, so no `npm ci` ran and there are no tracked dependency changes. Before bounded runs the installed workflow helper reported normal memory pressure and no native owners; execution was held during a high CPU-load interval. No daemon/native/long-CPU job was launched. Unapplied three-file patch, postimages, exact source/test/doc hashes, unchanged-input proof and focused logs are retained under ignored `artifacts/sessions-v2-privacy-composition-r1/`. This loaned Root checkout and the handoff evidence remain intact for integration; no commit, stash, reset, branch switch, publication or preview was performed.
