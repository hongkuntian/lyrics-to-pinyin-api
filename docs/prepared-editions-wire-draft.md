# Prepared editions wire v1 — app integration draft

Endpoint: `POST /api/song-library`, existing `Bearer lyrica_s_…` session (guest accepted), private/no-store. Additive actions; old actions unchanged. No generation/unlock fallback on any denial. This draft is normative for the backend candidate; freeze with Root before production promotion.

## Eligibility

```json
{"action":"prepared_starters","languages":["cmn"],"variant":{"provider":"apple","catalogID":"1440850038","storefront":"ca"}}
```

`variant` is optional; when supplied only that exact server-mapped pool variant can qualify. IDs above are illustrative: use actual pool IDs, never title matching. Without variant, return eligible editions in the existing pool order, at most three per language. Unknown/unverified listener territory permits only editions explicitly worldwide. A client storefront establishes a requested variant, not listener territory. Apple playback capability stays app-owned. No Spotify lookup, credentials, or playback claim.

```json
{"version":1,"preparedStarters":[{"language":"cmn","songs":[{"songID":"cmn-hebe-little-happiness","editionID":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","generation":"3","variant":{"provider":"apple","catalogID":"1440850038","storefront":"ca"},"uses":["read","play"],"documentID":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceHash":"ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss"}]}]}
```

Actual content identities are lowercase SHA-256. Empty eligible groups have `songs:[]`. `play` here means publication permits timed use of that exact variant; it does not prove Apple subscription or playability. `read` is independent, untimed intent.

## Current grant and read

```json
{"action":"prepared_grant","editionID":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","generation":"3","use":"read"}
```

For play, include the exact `variant` above and `use:"play"`.

```json
{"version":1,"state":"ready","grant":{"editionID":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","generation":"3","documentID":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","sourceHash":"ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss","use":"read","onlineRequired":true,"expiresAt":"2026-11-25T08:05:00.000Z"},"artifacts":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"document"}]}
```

Grant maximum lifetime five minutes, further bounded by publication/source expiry. No offline grant. Check online before cached open, on foreground, at expiry, before further protected fetch. A grant is not a transferable bearer capability: every artifact fetch rechecks current publication and territory.

```json
{"action":"prepared_artifact","editionID":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","generation":"3","use":"read","artifactID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Response `{version:1,state:"ready",grant:<same shape with current expiry>,artifact:{id,kind,content}}`. Document content uses the ordinary public document serializer, translation content ordinary public translation, study batches/singletons existing public shapes. Catalog/recording and provider source/timing revisions remain in document content. Manifest artifact describes exact finite inspector actions and targets/recipes; original contexts never carry optional translation; translated contexts bind only their own exact target/revision. Artifact IDs are content-addressed over kind+content. IDs supplied by a client never select arbitrary DB content.

Denials: `400 invalid_request` (extra fields, malformed IDs, invalid use); `401 unauthorized`; `429 rate_limited`; `404 prepared_unavailable` (unpublished, withdrawn, expired, incomplete or no applicable rights/territory); `409 publication_changed` (generation stale); `403 variant_unavailable` (unmapped variant or use not allowed); `404 artifact_unavailable` (not in edition). Bodies exactly `{version:1,code:<code>}`. Missing migration/store: `503 store_unavailable`. All denials cancel the protected page; retry the same edition or return to choices. Never ordinary paid path. Tie every reply to edition+generation, discard stale replies. Withdrawal is detected by required online renewal (no push notification facility promised).

## Safety and publication status

No commercial pilot is published yet. Publication requires independently reviewed source permissions for advance generation, retained derivatives and serving, exact variant/recording evidence, complete five-target coverage, inspector manifest parity and listening alignment evidence. A complete pilot may publish independently of the 46-recording target. Public Spotify links remain off pending Root's product-wide gate. Existing shown/picked counters are never touched by these actions.
