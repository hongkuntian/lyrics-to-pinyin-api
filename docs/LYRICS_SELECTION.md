# Lyrics selection revision: 2026-09-08

The additive API 2.3.0 field `metadata.selection_revision` is `lyrics-selection-2026-09-08`. It also participates in server cache keys and is checked on Redis reads. Old payloads are not stamped with the new revision. Lyra only persists this revision; displaying an older server response during rollout does not renew its cache eligibility.

## Identity and discovery

NetEase tries 30 results, then a bounded 100-result fallback when no usable verified recording was found. Up to three tied candidates can hydrate their lyrics for comparison. LRCLIB tries its exact metadata lookup, then script-aware searches and a distinctive movement suffix when applicable. Both providers still validate the complete returned recording.

Metadata equivalence requires a numeric catalog ID, the same nonempty normalized album, and duration within 0.5 seconds. It handles a reversed two-word solo artist name, an explicitly known artist prefixed to a title, a single ASCII-letter typo in a long Latin title (preserving all other diacritics and numbers), or a narrow Chinese stage-name form. It does not discard featured performers or recording versions. Responses preserve the provider's original labels and carry a proof bound to the original request.

Duplicated lyrics can normalize script, punctuation and production credits only when all remaining line timestamps agree exactly. Conflicting timelines remain ambiguous. A response containing timestamps proves structural timing availability, not acoustic alignment.

## Usable lyrics and instrumentals

Explicit production-credit lines and instrumental placeholder prose are excluded from vocal lyrics. Invalid or out-of-duration timestamps become untimed text. A credit-only synced field can fall back to a usable plain transcription. Only an explicit provider instrumental flag (including NetEase's fixed full “纯音乐，请欣赏” marker) with no vocal text yields `quality.instrumental: true`, `quality.synced: false`, and `lines: []`. Do not count these as lyric coverage.

## Recording-bound timing correction

Apple catalog 966805806, Faye Wong / 王菲, 匆匆那年, 241 seconds has a reviewed source correction. The rejected 30-line timestamp fingerprint was confirmed in the reported phone cache. It is late against multiple alternative source tracks; this is not an application clock-offset repair. LRCLIB 38130197 supplies a replacement timeline, guarded by a content/timing hash and the recording metadata. The correction has its own bounded fetch budget inside the provider deadline. If the source changes or cannot be fetched, known-bad timing becomes readable untimed text while another provider can still win. This temporary degraded response omits cache eligibility revision and is not stored in server or native caches, so a later request can retry the replacement.

Every replacement row must normalize to the corresponding original row to preserve the exact original spelling and character ranges. Otherwise the complete verified replacement transcription is used, and clients must not blindly migrate edits. `metadata.timing_correction.source_fingerprint` identifies the upstream replacement track, not the final text-preserving payload. A catalog-bound Chinese localization uses catalog alias proof; reversed English name formatting uses metadata equivalence proof.

Independent provider agreement is evidence for this correction, not proof from listening. The opening replacement timestamp is 28.32 seconds; audible verification against the Apple Music recording remains separate acceptance work.

## Regression evidence

Hermetic tests cover retries, bounded discovery, recording/version/guest rejection, explicit instrumentals, credit-only fallback, stale server caches, request-bound proofs, correction fingerprints and fallback deadlines. An independent matrix contains 11 valid controls and 108 wrong performer, guest, version, title or duration variants; all pass. Full-library coverage must be measured through the native client as well, because authenticated MusicKit localization is unavailable to a direct backend-only audit.
