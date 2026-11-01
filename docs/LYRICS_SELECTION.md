# Lyrics selection revision: 2026-09-08

The additive API 2.3.0 field `metadata.selection_revision` is `lyrics-selection-2026-09-08-durable`. It also participates in server cache keys and is checked on Redis reads. Old payloads are not stamped with the new revision. Lyrica only persists this revision; displaying an older server response during rollout does not renew its cache eligibility.

## Identity and discovery

NetEase tries 30 results, then a bounded 100-result fallback when no usable verified recording was found. Up to three tied candidates can hydrate their lyrics for comparison. LRCLIB tries its exact metadata lookup, then script-aware searches and a distinctive movement suffix when applicable. Both providers still validate the complete returned recording.

Metadata equivalence requires a numeric catalog ID, the same nonempty normalized album, and duration within 0.5 seconds. It handles a reversed two-word solo artist name, an explicitly known artist prefixed to a title, a single ASCII-letter typo in a long Latin title (preserving all other diacritics and numbers), or a narrow Chinese stage-name form. It does not discard featured performers or recording versions. Responses preserve the provider's original labels and carry a proof bound to the original request.

LRCLIB's spaced `Singer + Guest` delimiter can normalize to `Singer & Guest` only when the complete title and requested contributor set already match after that formatting change. Existing complete stage names and unspaced plus signs stay intact. This adapter does not change Spotify's structured credit matching, duration limits, version checks, or ambiguity rejection. For mixed catalog labels such as a Chinese title with English artist names, discovery tries a complete, server-verified localization with that title before the canonical international query; the same catalog, album, duration, contributor and query-budget checks still apply.

Spotify's independent provider path can resolve contributor names through NetEase's artist-ID profiles. Every requested complete credit must map to exactly one profile name or alias, preserving multiplicity and all recording/version/duration checks. Provider display labels remain unchanged. If NetEase has ambiguous lyric timelines, one bounded native-name retry lets another independent provider validate its own complete recording and supply its own lyrics/timing. Only verified contributor-name equivalence is shared; Apple catalog aliases, lyric text and timestamps are not transferred. The original Spotify request hash, independent source context and response binding remain separate.

Duplicated lyrics can normalize script, punctuation and production credits only when all remaining line timestamps agree exactly. Conflicting timelines remain ambiguous. A response containing timestamps proves structural timing availability, not acoustic alignment.

Spotify uses complete credited artist names and its own request-bound identity.
Explicit track-version labels, album annotations/suffixes and recognized phrases
such as “Live at” remain version evidence. Ordinary album prose such as “Live
Through Tomorrow” or “Cover Me” does not classify a recording as live or a cover.
Equal ISRC never overrides a real version conflict.

`api/data/rejected-lyrics.json` also supports exact Spotify `itemIDs` with reviewed
negative source-language/text evidence. The current Japanese アイドル item is
separate from its English release; localized title spelling does not change its
language guard. Unknown items do not inherit it by title, artist or script. The
same predicate checks provider and durable caches, model/review/retry input and
Live Lyrics rendering. It supplies no replacement words, Apple aliases or timing.

## Usable lyrics and instrumentals

For a title containing non-Latin script, a usable recording-compatible source
containing that script outranks an exclusively Latin-script transcript, even if
the latter has line or measured word timing. Han and Japanese script are
compatible for this comparison. This is a conservative script heuristic, not
proof of language or transliteration: Latin titles, bilingual lyrics and
unrelated scripts retain the ordinary selection rules. Existing performer,
version, duration and ambiguity checks run before this preference; titles are
not freely shortened to admit a different recording. A narrowly quoted Chinese
TV/film theme description after a dash can resolve through Apple catalog proof,
matching album and duration within 0.5 seconds. Spotify treats only that same
anchored description as presentation metadata while preserving its structured
credits, version and duration checks. Arbitrary dash subtitles are not removed.

Latin-only candidates remain last-resort fallbacks. They leave a fixed bounded
discovery window, do not flash as progressive readable results, and are returned
at completion if no better usable source is found. LRCLIB continues its existing
bounded searches after an exact timed fallback; outages or rate limits preserve
an already admitted positive. Explicit source previews remain available.

The acquisition capability includes `native-script-1`, invalidating old server
selection caches without changing the response contract or selection revision.
Latin-only fallbacks expire after five minutes, including timed ones. Existing
saved/native documents are not rewritten; Reload lyrics requests fresh selection.

Provider-declared language is optional evidence, not a recording or timing
criterion. Within the script preference above, complete measured timing keeps its existing priority even when a
language declaration is absent, broad or contradictory. At the response-size
limit, optional language diagnostics give way before measured cues. See
[PROVIDER_LANGUAGE_EVIDENCE.md](PROVIDER_LANGUAGE_EVIDENCE.md).

Explicit production-credit lines and instrumental placeholder prose are excluded from vocal lyrics. Invalid or out-of-duration timestamps become untimed text. A credit-only synced field can fall back to a usable plain transcription. Only an explicit provider instrumental flag (including NetEase's fixed full “纯音乐，请欣赏” marker) with no vocal text yields `quality.instrumental: true`, `quality.synced: false`, and `lines: []`. Do not count these as lyric coverage.

## Recording-bound timing correction

Apple catalog 966805806, Faye Wong / 王菲, 匆匆那年, 241 seconds has a reviewed source correction. The rejected 30-line timestamp fingerprint was confirmed in the reported phone cache. It is late against multiple alternative source tracks; this is not an application clock-offset repair. LRCLIB 38130197 supplies a replacement timeline, guarded by a content/timing hash and the recording metadata. The correction has its own bounded fetch budget inside the provider deadline. If the source changes or cannot be fetched, known-bad timing becomes readable untimed text while another provider can still win. This temporary degraded response omits cache eligibility revision and is not stored in server or native caches, so a later request can retry the replacement.

Every replacement row must normalize to the corresponding original row to preserve the exact original spelling and character ranges. Otherwise the complete verified replacement transcription is used, and clients must not blindly migrate edits. `metadata.timing_correction.source_fingerprint` identifies the upstream replacement track, not the final text-preserving payload. A catalog-bound Chinese localization uses catalog alias proof; reversed English name formatting uses metadata equivalence proof.

Independent provider agreement is evidence for this correction, not proof from listening. The opening replacement timestamp is 28.32 seconds; the user confirmed the corrected timing against Apple Music on 2026-09-08.

## Regression evidence

Hermetic tests cover retries, bounded discovery, recording/version/guest rejection, explicit instrumentals, credit-only fallback, stale server caches, request-bound proofs, correction fingerprints and fallback deadlines. An independent matrix contains 11 valid controls and 108 wrong performer, guest, version, title or duration variants; all pass. Full-library coverage must be measured through the native client as well, because authenticated MusicKit localization is unavailable to a direct backend-only audit.

## Durable recovery and freshness

Automatic lookup includes a bounded Kugou fallback with exact full title/credits, one-second duration tolerance and recording-version checks including versions present only in the requested album. Only official recommended lyric candidates are eligible; tied candidates must agree. Transport credentials never enter the public response or caches.

Reviewed cross-catalog discoveries are metadata-only registry entries. Every request revalidates its complete accepted Apple catalog signature and the exact NetEase recording ID, album ID/name, paired contributor IDs/names, duration, and noncontradictory lyric headers. Changed sources fail closed. This recovers the Tomorrow Will Be Better ensemble and Eason Chan Arcane recording without broadening ordinary performer matching.

A separately reviewed official description can provide partial untimed words when no complete source is available. Exact catalog, official channel/video identity and paragraph hash must still validate live. `quality.partial` labels this state; clients must disclose missing repeats/timing and exclude it from complete lyric counts. Complete plain or timed words supersede partial words; instrumental candidates cannot erase verified vocals.

An unusually early final vocal cue opens bounded completeness discovery; it does not prove that a song is incomplete. Discovery requires a known duration, at least 80% timed vocal rows, at least 60 normalized text characters, a final cue before 60% of the recording and at least 45 seconds remaining. Instrumental tails and genuinely short vocals therefore remain readable when no corroborating source exists.

A fuller source corroborates an excerpt only after both sources independently validate against the same acquisition's recording metadata, including duration within three seconds. Localized targets share an internal acquisition identity only after catalog admission; arbitrary similar display names do not establish that relationship. The fuller transcription must have at least 1.5 times the normalized text and 80 additional characters, and contain at least 90% of the excerpt's characters in row order, consuming repeated occurrences. A fuller plain transcription can then beat a timed excerpt, including an excerpt with measured word timing. Rewrapping, punctuation changes, unrelated lyrics and incompatible recordings cannot establish completeness. The source objects are not mutated, and existing durable source/document/learning identities are not migrated.

Discovery aliases are separate from completeness evidence. When current Apple territories omit a native title, a reviewed label-backed search alias requires the complete accepted request signature and a matching live catalog anchor: catalog ID, artist, title, album and duration within 0.5 seconds. The reviewed Blue Bird compilation entry uses Apple's disc/track metadata and Sony's matching official track listing to search for `ブルーバード` within the existing bounded query count. This does not claim a live Apple storefront equivalent or grant timing authority; `catalog_items` contains only actual fetched catalog records. Changed or unavailable anchors disable the reviewed alias, and provider recording admission still runs independently.

LRCLIB checks fuller plain text alongside an abbreviated synced field and continues its existing bounded search for suspicious exact matches. Cross-provider discovery uses at most two concurrent lookups and a fixed, nonrenewing completeness window within the existing request/provider deadlines. Suspicious progressive snapshots wait for that decision; exhaustion, timeout or upstream failure retains the original readable fallback without falsely marking it partial. Known timing quarantines remain in force even when their untimed text supplies the fuller transcription.

Plain, partial and unresolved early-cutoff results expire after five minutes in server response caches; ordinary full timed and instrumental results retain the normal one-day lifetime. Reading Redis or disk preserves the original remaining freshness. Optional catalog localizations can upgrade plain lyrics within the existing bounded lookup; unavailable upgrades preserve readable words. The `corroborated-completeness-1` capability invalidates response, canonical and verified-context selection caches without changing API response version `2.5.0`, selection revision `lyrics-selection-2026-09-30-storefront-1`, or the public response shape.

Automatic durable-library heads use this same freshness policy, using the playback request duration even when the source response omits it. A stale early-cutoff positive rechecks with `refresh:true`; an upstream outage retains the readable stored edition. The whole-document retention comparison also applies corroborated completeness before protecting timing: a verified fuller untimed edition can replace a timed excerpt, and a subsequent timed excerpt cannot regress the fuller head. Apple comparisons require matching server-bound request keys; localized source names additionally need the same validated canonical recording. Spotify comparisons retain the admitted candidate evidence stored with the source. Refresh creates or selects an immutable edition rather than rewriting the old source, its hash or existing learning/translation records. Exact-text timing-donor attachments remain separate and cannot append missing verses.
