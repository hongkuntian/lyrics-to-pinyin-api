# Automatic artist identity enrichment

## Discovery before a provider candidate exists

`artist-discovery.js` fills the bootstrap gap when an international artist name
finds no plausible native provider candidate. An untimed/line-only candidate
starts optional identity discovery alongside the remaining provider searches.
The existing Wikidata snapshots are reused first. Otherwise the resolver follows
the exact Spotify artist URL to a unique active MusicBrainz artist, verifies its
reciprocal URL ID, and follows its unique Wikidata link only when that entity's
nondeprecated MusicBrainz claim points back to the same artist. Conflicting
Spotify claims, search-hint aliases, ambiguous links and malformed names abstain.
The requested artist spelling must occur in the verified names. No person-name
search or maintained artist-name mapping is involved.

When an ISRC is available, an optional Apple catalog lookup can also discover
localized names. It requires the original title/album, duration within 0.5 s,
version/rating agreement and consistent complete Apple artist-ID sets across
localizations of the same song ID. Multiple contributors need a unique exact
name assignment; a sole contributor is anchored by the matching recording.
Apple only supplies search metadata. The Spotify request, independent lyric
source and immutable document identity remain unchanged.

One bounded native-name continuation searches all eligible providers. Verified
MusicBrainz/Wikidata snapshots retain the entity's current NetEase artist-ID and
QQ singer-MID claims. QQ and NetEase can use those claims only through their
existing fresh provider-ID/profile admission rules, including exact QQ MID
echoes; a verified name without the provider evidence is insufficient. LRCLIB
can use the verified aliases only with matching album, duration within 0.5 s,
complete uniquely assigned contributors and all ordinary recording gates.
Its alias evidence binds the complete request and raw source metadata through
cache, acquisition and save/reopen. Recovered exact lookups still collect the
search candidates before choosing, so a conflicting duplicate sheet abstains.
Unknown title suffixes, covers and anniversary recordings are not normalized
away. Provider timestamps are preserved; this does not generate word cues.

MusicBrainz discovery has a 4 s ceiling inside the unchanged 16 s request
deadline. All MusicBrainz requests share a process gate and, when Redis is
configured, a shared NX lease at 1050 ms intervals. A busy 503 permits one
rate-gated retry per read within that ceiling. Shared-gate failure abstains.
Positive artist snapshots last one day; confirmed missing graph links last
five minutes. Transport failures/cancellation do not become negative cache
entries. Snapshot fingerprints and acquisition-order writes preserve identity
and prevent an older refresh from replacing newer evidence. Apple recording
localizations have a bounded one-day memory cache.

The exact 愛你 Spotify recording is covered by hermetic discovery, wrong-source,
ambiguity, cache and real library save/reopen regressions. The daily live workflow
also checks `docs/research/artist-discovery-corpus.json` with the separate
`--minimum-line-timed-rate 1` gate. Its 24 line-timed LRCLIB rows are never counted
as source-positive measured-word coverage. Acoustic alignment is not established
by metadata admission or these checks.

Source contracts: [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API),
[aliases](https://musicbrainz.org/doc/Aliases),
[Apple ISRC lookup](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-isrc),
[Apple localization](https://developer.apple.com/documentation/applemusicapi/storefronts-and-localization).

## Provider identity admission

Each Spotify acquisition shares one identity snapshot across provider lookups,
including explicit refresh. NetEase starts that bounded lookup when a plausible
recording has different contributor labels, in parallel with its artist-profile
request. Existing identity caches and all recording/source checks remain in force.
Cancelling one provider only cancels its wait; request completion or cancellation
retires the shared work. Identity failure still permits an independent readable
source and never establishes that lyrics or measured timing are absent.

Artist names are display labels. The Spotify lyric request retains a complete
ordered `metadata.artist_ids` array, parallel to `metadata.artists`, when catalog
IDs are available. Partial or duplicate ID sets are omitted by native catalog
projection and the background observer; contributors are never dropped.

Ordinary provider aliases remain the fast path. When a fresh NetEase performer
profile or QQ song detail cannot resolve the original Spotify credits, one bounded Wikidata lookup
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

QQ requires a direct non-deprecated `P10410` singer MID claim, not profile-name
corroboration. Every aliased contributor must have that exact MID in fresh
`get_song_detail_yqq` data. Search labels alone cannot authorize recovery. QQ
legacy search candidates that pass the unchanged non-artist and album gates
receive one bounded fresh-detail batch, with exact song ID and MID echoes,
before identity recovery. This also covers English credits absent from smartbox
suggestions; unresolved fresh contenders and lyric-sheet ties still fail closed.
QQ numeric singer IDs, singer MIDs, native names and the original Spotify artist IDs
remain bound in the evidence through memory/Redis caches and durable library
reopen. The QQ-specific recovery policy cannot be replayed as NetEase evidence.
Snapshot capability 2 fingerprints the QQ claims; original capability-1 NetEase
snapshots retain their historical validation semantics but cannot authorize QQ.
Spotify acquisition caches include the new identity capability.

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
