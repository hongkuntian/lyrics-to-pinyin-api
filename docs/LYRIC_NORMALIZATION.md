# Lyric annotations and vocal text

The shared `cleanLyrics` path uses `lyric-annotations-1` to separate recognized
production credits and performer cues from sung text before romanization. It
does not delete arbitrary colon-containing lines, deduplicate refrains, rewrite
words, or move a cue's timestamp onto a vocal line.

Production roles have explicit Chinese and English aliases. A bilingual label
must consume the whole label and refer to one role. Unknown suffixes and
ambiguous chorus text remain readable. Performer labels require names from
verified artist metadata, explicitly supplied performer identities, or the
reviewed artist roster in `api/data/lyric-performers.json`. The roster is scoped
to the group, not one song. Complete combined labels require every member to
match. Generic chorus/gender cues require a confirmed named-performer cue in
the same document. Unknown names and bracketed sung words remain unchanged.

`metadata.lyric_structure` is an additive response field containing the
normalization version, original source rows, removed annotation kinds, performer
identities, and one occurrence per visible lyric row. Each occurrence preserves
its source row index, original text, removed prefix, clean text and explicit turn
metadata. Source timestamps are evidence; visible timestamps come from the
vocal rows and may reflect a separately verified timing correction. Repeated
normalization preserves the same mapping and cannot strip a second apparent
speaker prefix from already-cleaned sung words.

Song-library documents validate the mapping against their exact response rows.
Translation receives only vocal occurrences and their performer context, not
production credit rows. Singer and narrator remain distinct; translations keep
turn metadata but their display text has no singer prefixes. Original sources
and normalization structure contribute to the document identity, so translations
for different row layouts cannot attach to each other.

The existing song-library API v1 still ties `sourceText` to the visible row and
`startsTurn` to a printed prefix. Its responses therefore project normalized
documents onto the clean vocal rows with empty printed prefixes and no printed
turn starts. Translation replies use that same view. The full annotation mapping
remains in `response.metadata.lyric_structure`; the canonical stored document and
model input keep real performer turns. IDs and hashes identify that canonical
document, independent of its API view. Existing clients remain compatible without
requiring a coordinated rollout of the saved-translation feature. Older saved
documents retain their original v1 speaker-prefix format when explicitly reopened.

The response selection revision is `lyrics-selection-2026-09-13-vocal-text`.
Backend cache keys also include the normalization version. Native memory/disk
cache admission and durable song-library lookups use the matching revision;
older results remain readable during rollout but must be refetched rather than
recertified as current. Future semantic normalization changes must update these
versions together. Existing translations are not regenerated in the background.

## Verified recording

Apple recording `1835909383` (TOP Debut Boy Group, 流星雨, 271.291 seconds)
matches NetEase `2734065329`. Its captured source has 67 rows: 18 production
credits, 12 standalone performer cues and 37 vocal rows. All 37 retained texts
and timestamps compare exactly with the reviewed vocal rows; the first vocal
timestamp is 17.03 seconds and the last is 252.76 seconds. This verifies cleanup,
not a new audio-alignment judgment. Live source bodies stay in ignored artifacts.

The committed regression fixture preserves label syntax and timestamps while
replacing sung words and credit values with original test text. Additional tests
cover bilingual aliases, combined and bracketed performers, ordinary colons,
clock times, unknown names, repeated lyrics, source mapping, translation turns,
cache migration and existing reviewed recording/timing repairs.

Sources: [Apple recording](https://music.apple.com/us/song/1835909383),
[NetEase source](https://music.163.com/song?id=2734065329),
[group's release announcement and members](https://www.weibo.com/7854957897/PEC5ClzmX).
