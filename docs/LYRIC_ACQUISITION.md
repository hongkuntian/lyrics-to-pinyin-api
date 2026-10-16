# Verified lyric acquisition reuse

Milestone 2 keeps the `progressive-v1` delivery contract and all legacy JSON
responses unchanged. The backend now reuses verified discovery context, overlaps
one bounded discovery with catalog work, and shares eligible source work within
one function process. No generation, credentials or authentication rules change.

## Durable discovery context

`lyrics:verified-context:v1:*` stores a bounded six-hour memory/Redis context.
Catalog contexts contain the exact accepted request and policy revisions, explicit
aliases and serialized `aliases.resolution`, original verification/expiry times,
and at most one LRCLIB source-ID hint. Empty/unverified catalog responses cannot
create context. Explicit refresh bypasses context and hints. Reads and hint
updates preserve verification age; acquisition ordering prevents older work from
replacing a newer refresh, including an outstanding Redis read.

A hint contains only the selected source ID and whitelisted metadata/target
signatures. It never stores or trusts `song.lyricsData`. LRCLIB `/get/{id}` must
return the same ID with fresh metadata and words. Current title/version, album,
duration, contributor, ISRC/explicit, negative-source, lyric normalization,
recording rejection and timing-correction checks still run before publication.
A rejected/missing hint recovers through ordinary discovery inside the original
provider slot and deadline. The ID read has an 800 ms sub-budget; other providers
can hedge while it runs. It never starts a second serial six-second preflight.
Spotify contexts retain the complete V2 request fingerprint; fresh binding and
trusted WeakMap source-match evidence are constructed from the newly validated
provider candidate. Public binding DTOs do not become matching evidence.

Malformed or expired optional cache entries are misses. Persistent context and
existing content caches can be reused across function instances. Raw and library
routes remain separately packaged functions: no cross-instance in-flight broker
or distributed cancellation is implied.

## Catalog overlap and budgets

A cold eligible solo-artist request can start one original-query discovery while
catalog metadata resolves. Contributor-ambiguous requests, explicit preferred
sources and known reviewed/official source IDs skip this optional probe. Lyrics
cannot publish until catalog entities and reviewed-source precedence are settled.

The probe spends the existing first-provider query and original deadline. If the
original is the first admitted catalog target, that target adopts the probe. If
an alias precedes it, the probe is cancelled and settled before the alias starts
its normal two-provider hedge. A completed original result may be held for its
later admitted turn. A pending/failed original is never repeated against that
same provider. Discarded probes count against the existing four-target budget.
No source hedge has more than two active lookups. Two simultaneous cold callers
may each start their own pre-proof probe; joining a verified owner cancels the
joining caller's probe rather than creating a third pipeline. Cold localized
requests can spend an extra original discovery before the first canonical alias;
that bounded cost is recorded in localization tests rather than hidden.

## Same-process acquisition owners

Sharing requires a verified catalog proof and the same catalog ID, exact original
artist/title/album/duration/ISRC, server genres, contributor entities, catalog
search ordering, provider ordering, source preference, pronunciation/options and
source/normalization policy revisions. Storefront-only aliases meeting this
conservative boundary share one owner. Different catalog IDs, localized metadata
or policy contexts remain independent even when catalog canonical IDs agree.
This boundary protects exact rejection rules, timing corrections and formatting
from inheriting the first caller's policy inputs.

Each shared owner has an independent controller, fixed first-reader deadline,
owned formatting children and latest validated snapshot. Each reader rechecks
and rebinds the snapshot/final result to its own catalog proof. Snapshot replay
supports late readers. The first reader can leave while formatting is pending;
other readers continue. The last reader aborts source work. A joining reader
never renews source, cache or verification age. Cancellation cleanup is awaited,
with explicitly owned bounded cleanup continuation where needed. Refresh owners
are isolated and older ordinary results cannot replace newer cached content.
`lyrics_shared_source` logs the caller request ID, HTTP acquisition ID, shared
source acquisition ID, join flag and original deadline without credentials.

## Reproduction and interpretation

Run `node scripts/benchmark-lyric-delivery.mjs --acquisition` for the maintained
controlled replay. It retains cold 0/800 ms catalog, warm new-instance context,
expired context, explicit refresh, eligible alias sharing and first-reader
cancellation cases. The replay records first-readable/final event times, catalog,
search/source-ID/lyric call counts, discovery/source-ID concurrency and final source/request
identity. The replay concurrency counter excludes lyric-read lifetimes; it does
not measure comprehensive provider-network concurrency. Integration fixtures
separately retain lyric-read lifetimes when asserting the source hedge cap. Its owner-sharing cases deliberately disable optional speculation to
isolate owner savings. Integration tests separately cover simultaneous cold
aliases with speculation enabled and delayed catalog admission.

The injected delays measure backend scheduling and request counts, not provider
network performance, deployed streaming flush, playback or physical-device
latency. Compare matched harness bytes and repeated cases on both revisions;
small controlled samples do not establish real-world tail latency. Provider
deadlines remain unchanged pending representative production evidence.
