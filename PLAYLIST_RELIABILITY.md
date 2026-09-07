# Playlist lyrics reliability — September 7, 2026

The library audit reproduces failures using the Mac Music export's artist, title, album and duration. It includes 357 distinct recordings across the library and playlists, including 146 in My Playlist #3. The export has no Apple catalog IDs, so this specifically exercises metadata-only lookup rather than claiming identical MusicKit request coverage.

## Root causes and fixes

- LRCLIB searches are sensitive to Simplified versus Traditional Chinese. Retry discovery by base title in both scripts; still validate the complete recording before returning lyrics.
- Full ensemble credits may contain up to 1024 characters. The previous 300-character bound rejected a real multi-artist library recording before lookup; contributor names are never truncated.
- `Live` and `Live版` are equivalent title markers. Compare version evidence across title and album together; a provider can label the title as live while leaving the album suffix off. Live versus studio remains distinct. Repeated featured credits count each contributor once.
- Duet credit separators differ across catalogs (`&`, comma, slash, `feat.`). Canonicalize the complete contributor list and explicit title-feature credits. Never remove a guest or accept only the lead artist.
- Soundtrack and promotional title descriptions can be removed for discovery and identity comparison; descriptions containing recording-version labels are retained.
- Album `- Single` / `- EP` release suffixes provide fallback evidence. Exact album matches remain stronger; live/demo/instrumental distinctions and conflicting equally ranked lyrics remain protected.
- Catalog aliases can have an English artist and Chinese title. Validate each component against localizations of the same catalog ID. Add Simplified Chinese lookup alongside Traditional Chinese.
- Metadata-only requests may discover a catalog ID only when full names, duration and album match a unique authoritative result. Return the new `metadata_alias` proof bound to the original artist, title, duration and album. A supplied catalog ID never falls back to a different discovered ID.
- A failed LRCLIB discovery query no longer discards successful sibling queries. Transient upstream HTTP 502/503/504 responses receive one cancellation-aware, 150 ms delayed retry inside the existing deadline. No retry loop or rate-limit bypass.
- NetEase can verify translated performer names from `artist/detail` using the artist IDs in a plausible search result. Only exact aliases are accepted; all guests, duration and version guards remain. Artist metadata is bounded and cached, and unrelated titles/durations do not trigger artist lookups.
- NetEase receives Simplified Chinese query text when Han characters are available. English titles are never guessed into Chinese.

API version 2.3.0 invalidates cached responses from the older matching policy. `recording_match.method` now permits `metadata_alias`; `recording_match.album` binds that proof to metadata-only requests. Updated Lyra validates it before accepting differently localized provider names.

## Verification

82 hermetic checks pass: 39 unit, 37 integration and 6 contract tests. Fixtures cover wrong singers, missing/extra guests, different durations, live/instrumental versions, conflicting lyric duplicates, ambiguous catalog discovery, stale catalog IDs, partial outages and cancellation.

The reported duet resolves to LRCLIB 5657609, 222 seconds, with 36 timed lines. Additional live catalog checks outside the library pass for Left and Right (Charlie Puth & Jung Kook), Perfect Duet (with Beyoncé), and 珊瑚海 (feat. 梁心頤). Test fixtures use original lyric snippets; provider lyric text is not committed.

Use `node scripts/audit-library.mjs input.json output.ndjson [endpoint]` for repeatable, bounded live audits. Inputs are playlist arrays with `tracks` containing request metadata. Results contain recording metadata, HTTP status, provider and line counts, not lyric bodies. Live availability varies; retain failures rather than reporting retries across different runs as one clean pass.
