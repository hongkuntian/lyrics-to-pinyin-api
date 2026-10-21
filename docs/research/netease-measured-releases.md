# Measured timing across NetEase releases

The reported 大約在冬季 by Chyi Chin exposed discovery failures, rather than a
missing YRC decoder. The 232.827-second Apple catalog item `1720480778`, on
时光的碎片, resolved to a line-only NetEase compilation. NetEase `2113005420`
has the corresponding album and 232.826-second duration but returned no YRC.
Other releases for performer `4813` returned complete measured editions. A
bounded live check on October 20, 2026 selected `1891383417` with 412 cues
covering all 412 meaningful lyric graphemes. The 231.467-second 摘金寶典 item
`1443337235` already obtained YRC from `28819044` before this change.

An English artist lookup previously resolved only its first three plausible
rows against NetEase performer profiles. Later rows for the same verified ID
could not compete, including the exact requested compilation. Reuse those
already fetched profiles across the page, without expanding the profile budget.

After ordinary recording selection establishes an unambiguous primary, allow
an optional measured source edition. Candidate releases must have the same
complete NetEase performer-ID set, independently pass request-name matching,
preserve version markers, and differ from both the request and primary duration
by at most 0.5 seconds. Conflicting known ISRCs and explicitly marked covers are
excluded. Do not enter optional acquisition for a family larger than 16 rows.
Cross-release discovery is limited to unqualified album names. Bracketed unknown
qualifiers and named mixes, versions, channels and remaster years require the
complete same release label; matching rendition categories are insufficient.

Fetch the primary lyrics first. A complete measured primary, partial document,
instrumental or empty document needs no companion lookup. Otherwise inspect at
most three companions, in stable metadata-score and numeric-ID order, within a
fixed 1.5-second sub-budget of the unchanged provider deadline. Every accepted
companion must have complete validated source-bound word timing and identical
complete normalized lyric text after credit cleanup. No approximate text edits
or missing verses qualify. Adopt the first complete verified edition and cancel
remaining requests; an unavailable or slow peer cannot discard an already valid
edition. If none arrives within the optional budget, retain the primary. Caller
cancellation still cancels the operation.

This selects a complete source edition, including its own text, row timestamps,
word intervals, source ID and revision. Different annotations for the established
recording need not have equal timestamps; select one complete edition.
Never transplant cues to the primary transcription, mix sheets, rescale times or
infer durations. Existing ambiguous primary metadata remains rejected.

Increment acquisition-cache policy and verified-context policy so prior line-only
results and ID hints do not bypass the improved search. The wire contract and
native renderer remain unchanged. Synthetic regression lyrics exercise Apple
and Spotify handlers, source admission, deterministic editions, cancellation and
readable fallback; provider lyric bodies are not repository fixtures.

The live result demonstrates provider metadata admission and complete measured
coverage. It is not acoustic synchronization proof, a stock Dynamic Lyrics
runtime trace, or confirmation of the user's exact Spotify item. Recording links
are needed to qualify those specific playback versions.
