# Recording reliability checkpoint — September 6, 2026

## Reproduction and repair

Unbreakable Love / Eric Chou / 258.264 seconds returned 409 without an album. LRCLIB records 6822199 and 36456654 contain equivalent timed lyrics under English and Chinese album names. The matcher now accepts a stable representative of equivalent top-ranked results. Conflicting text/timing, unknown lyrics, different durations, covers and live/demo/version conflicts remain rejected.

Romanization is selected from the fetched lyrics instead of the search labels, unless the caller explicitly specifies a language. Standard Traditional Chinese words containing 係 no longer cause false Cantonese detection. Latin-only lines and catalog names remain intact.

## Additive API contract (2.2.0)

- Optional request `catalog_id`: numeric Apple catalog song ID as a string.
- Optional request `storefront`: lowercase two-letter country code, sourced from the MusicKit catalog URL.
- After ordinary provider lookup fails, a bounded fallback looks up the same catalog ID in English and Traditional Chinese using Apple's public catalog lookup. At least one localization must match the caller's names and duration before an alternate localization can be tried. No user-supplied translations or fuzzy title guesses are accepted. This initial alias resolver covers English/Traditional Chinese; other language localizations can be added separately.
- Alias matches retain the provider's original title/artist and add `metadata.recording_match` with `method: catalog_alias`, `catalog_id`, requested `artist`, `title`, and `duration`. Lyra validates this evidence against the request. Older clients ignore the additive field and may still reject localized names.
- Provider attempts retain individual deadlines, and all lookup rounds share a 16-second budget. Catalog lookup has a maximum 2.5-second budget; its failure does not turn an otherwise ordinary lookup into a server error. Cache keys include catalog identity, storefront and response version.
- Bounded `lyrics_lookup` diagnostics record provider and result reason without lyric text or library contents.

## Verification

All 52 hermetic tests pass: 23 unit, 23 integration, 6 contract. Fixtures use actual provider metadata with original test lyrics. Coverage includes playlist-style missing album metadata, equivalent versus conflicting duplicates, English labels with Mandarin lyrics, preserved Latin lines, trusted versus mismatched catalog identity, explicit language selection, malformed input and deadlines.

Live local checks resolved Unbreakable Love through LRCLIB with English metadata and through NetEase with catalog-verified Chinese metadata. Both return Mandarin pinyin. Publication and device results are recorded after the final checks.
