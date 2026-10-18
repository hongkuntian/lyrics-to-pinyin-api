# Lyric annotations and vocal text

The shared `cleanLyrics` path uses `lyric-annotations-3` to separate recognized
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

Instrument and engineering roles also accept bounded production modifiers:
numbered sections such as `1st Violin` and `3rd Violins`, principal/lead/solo
instruments, assistants, recording engineers, technicians and contractors.
Chinese instrument roles compose with production duties such as `弦乐 助理`
and `弦乐录音助理`. The complete label must match this grammar; an unknown
colon label, a name-like body or proximity to credits alone is insufficient.
`C.Bass` is accepted as a contrabass label. An anchored ISRC row retains the
12-character code even when the provider splits its final five digits with
extra hyphens, as in `ISRC：TW-C23-04-007-06`. Credit extraction never edits
the retained lyric text, timestamps, or measured YRC segments.

`metadata.lyric_structure` is an additive response field containing the
normalization version, performed source rows, performer cue annotations, performer
identities, and one occurrence per visible lyric row. Each occurrence preserves
its source row index, original text, removed prefix, clean text and explicit turn
metadata. Source timestamps are evidence; visible timestamps come from the
vocal rows and may reflect a separately verified timing correction. Repeated
normalization preserves the same mapping and cannot strip a second apparent
speaker prefix from already-cleaned sung words or reclassify a stripped vocal
body as a production credit or instrumental marker.

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
requiring a coordinated rollout of the saved-translation feature. Legacy documents are reprocessed into clean revisions by the explicit production migration; old IDs retain retirement records, not raw lyric payloads.

The response selection revision is `lyrics-selection-2026-09-30-storefront-1`.
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

Production credits live only in `song_details.credits`, persisted separately in `lyric_document_extras`. Source arrays contain no credit copies. Repeated Chinese^English pairs use the separate aligned `provider_translation` structure. See [source recovery](SOURCE_CONTENT_RECOVERY.md) for migration, refresh and listening gates.

## Corroborated performance credits

Compact Chinese personal names following 男声, 女声, or 戏腔 require corroboration: verified performer metadata, two adjacent distinct roles naming the same person, or two neighboring confirmed credit rows. A single backing-vocal name can also qualify at either edge of that block. Traditional labels normalize only for comparison. Unconfirmed names, sung chorus phrases, and already separated performer-cue bodies remain performed text. Extracted credits stay in Song details; source rows, romanization and new model input contain only the retained vocals, with unchanged timestamps and repeated words.

Cached responses containing recognized embedded credits revalidate through the existing recording-bound acquisition path, including Spotify memory/Redis and durable documents. This is a targeted repair under the existing selection contract. Reacquisition creates a new immutable source identity; saved translations are never remapped or regenerated automatically. The native projection keeps older copies readable offline without changing their source IDs/hashes and requests a throttled refresh for the newly recognized performance block. Clean sources with credits only in metadata do not trigger that refresh.

New translation or Study reservations against a legacy source that still embeds credits return `source_revision_superseded` before reserving allowance or invoking a model. Existing saved results and already reserved jobs keep their normal reuse/recovery paths.
