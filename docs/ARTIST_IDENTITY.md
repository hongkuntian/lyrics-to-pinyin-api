# Automatic artist identity enrichment

Artist names are display labels. The Spotify lyric request retains a complete
ordered `metadata.artist_ids` array, parallel to `metadata.artists`, when catalog
IDs are available. Partial or duplicate ID sets are omitted by native catalog
projection and the background observer; contributors are never dropped.

Ordinary provider aliases remain the fast path. When a fresh NetEase performer
profile cannot resolve the original Spotify credits, one bounded Wikidata lookup
can recover multilingual names by exact Spotify artist ID. The resolver first
requires a unique non-deprecated entity mapping, then verifies its current ID
claim and entity revision. It never searches for a person by fuzzy name.

Every recovered contributor must match the entity's requested spelling and fresh
native provider canonical name. An available NetEase ID claim must agree. Without
that direct ID link, two distinct provider-profile names, including the canonical
name, must corroborate the entity. A sole homonym is insufficient. Contributor
assignment must be unique and complete. Artist evidence changes spelling only;
the normal recording/version/duration/ISRC/explicitness checks remain, and this
recovery additionally requires matching album metadata. Provider artist IDs and
the original catalog artist IDs are retained in separate source/request evidence.

The former manual NetEase artist alias entries are removed. This mechanism is
script-independent; unavailable aliases still produce ordinary provider or
readable fallback rather than guessed identity. Second-query discovery supports
ID-bearing titles in any script without increasing the existing two-query bound.

The optional lookup shares the caller's cancellation and existing provider
deadline, with a 2200 ms ceiling of its own. It uses no retry loop. Memory and
Redis entries are keyed by artist ID and capability: positive snapshots live at
most one day and confirmed missing/ambiguous mappings five minutes. Transient
transport failures are not cached as absence. Redis writes use the existing
acquisition-order writer so an older lookup cannot overwrite a newer refresh.
Malformed, oversized, changed, future or expired acquisition snapshots are misses.
Snapshot fingerprints cover ID, entity revision, names and provider-ID claims.

Saved documents keep their accepted historical identity snapshot after network
cache expiry. A refresh qualifies new evidence independently. `artist_ids`
participates in the exact request hash; its durable document preimage is
`["spotify-document-artist-ids-1", recordingKey, sourceHash, selectionRevision, requestHash]`.
Independent source hashes and the Spotify recording key remain stable. Different
artist-ID fingerprints cannot overwrite one immutable document's request evidence.
Old jobs remain attached to their original document; identical qualified model
input may reuse work under the existing translation policy.

Verification includes multilingual synthetic identity cases, homonyms, wrong
catalog/provider IDs, ambiguous mappings and duets, changed claims/revisions,
malformed/bounded data, cache expiry/corruption, cancellation, outage fallback,
actual library acquisition/save/reopen, and a shared backend/native hash vector.
The maintained discovery corpus carries real Spotify artist IDs only when the
exact track's complete ordered contributor names agreed with the frozen request.
No title search supplied an artist ID. Live provider availability and metadata
matching are separate from acoustic or physical-device timing verification.
