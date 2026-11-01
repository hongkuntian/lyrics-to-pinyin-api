# Blue Bird lyric reliability

## Root causes

Kugou lyric source 468823329 supplies a corrupt KRC timeline and an equally unreliable LRC sibling. The source advertises official/recommended lyrics but its KRC identifies AI-generated timing. In the inspected 215-second source, seven initial rows end within one second and 44 of 76 segments last at most 10 milliseconds. Syntactically complete cue coverage previously hid these implausible timings from discovery and refresh logic. This is not a global offset or a milliseconds conversion issue.

Dictionary analysis cannot infer the song's artistic readings. Reviewed published ruby establishes the three source-span corrections documented in PRONUNCIATION_AIDS.md. The real Kugou candidate has no album; source-bound matching must not borrow request album labels. The provider also supplies literal backslash-quote sequences in lyric bodies.

## Safeguards and identity

- Quarantine timing only for Kugou 468823329, across KRC and LRC. Keep original words readable and untimed; never rescale or invent timing. Other source IDs and providers remain eligible.
- Conservatively reject repeatedly collapsed meaningful rows, with separate tiny-cue corroboration. Sparse vocals and long instrumental tails are not rejection criteria. Raw timing remains available as source evidence, not authority to synchronize.
- Exclude rejected timing from usable/complete coverage and keep discovery open for a genuinely matching alternative. Untimed responses use a short cache lifetime. The acquisition capability changes so ordinary caches cannot revive old timing/readings; response version remains 2.5.0 and selection revision remains lyrics-selection-2026-09-30-storefront-1.
- Immutable saved document IDs, source hashes, translations and learning identity remain intact. A caller explicitly reacquiring a durable response can receive a new edition while historical documents remain accessible. The client does not automatically migrate a quarantined saved source merely to gain timing: it uses a separate validated timing donor path.
- Current Japanese pronunciation profiles are generated against the existing document identity. Remove unversioned Japanese fallback so stale embedded readings cannot outlive engine invalidation. Korean fallback is unchanged.
- Normalize only literal backslash-quote artifacts in Kugou lyric bodies before computing cue offsets/revisions. Preserve other backslashes.

Hermetic coverage exercises Apple and Spotify handlers, ordinary cache rejection, discovery alternatives, neighboring sources, generic collapsed timings, immutable durable refresh, selected-source readings and profile/offset controls. No trusted replacement timeline has been established for this exact release; untimed display is the safe result until independently validated timing is available.
