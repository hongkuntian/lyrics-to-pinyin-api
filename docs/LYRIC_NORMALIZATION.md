# Lyric annotations and vocal text

The shared `cleanLyrics` path uses `lyric-annotations-3` to separate recognized
production credits and performer cues from sung text before romanization. It
does not delete arbitrary colon-containing lines, deduplicate refrains, rewrite
words, or move a cue's timestamp onto a vocal line.

Production roles have explicit Chinese and English aliases. Rights and release
roles also use a complete-label grammar: recording/composition scope lists,
copyright duties and entities, and joint/exclusive production, publishing or
distribution activities compose without adding individual compound labels.
For example, `词 + 版权 + 管理 + 方` and `(录音作品 + 及 + MV) + 版权`
are credits. Any unconsumed sentence text keeps a colon row readable. The same
grammar and fixture corpus run in native display cleanup, including offline
saved sources. Credits remain in Song details; their extraction never shifts a
retained vocal timestamp or reassigns a saved occurrence ID.

A bilingual label must consume the whole label and refer to one role. Unknown suffixes and
ambiguous chorus text remain readable. Performer labels require names from
verified artist metadata, explicitly supplied performer identities, or the
reviewed artist roster in `api/data/lyric-performers.json`. The roster is scoped
to the group, not one song. Complete combined labels require every member to
match. Generic chorus/gender cues require a confirmed named-performer cue in
the same document. Unknown names and bracketed sung words remain unchanged.

Production labels can list multiple complete roles with `/`, `&`, `+`, `、`,
`及` or English `and`. Every component must independently be an unambiguous
production role; an unknown or spoken component preserves the entire row.
Engineering duties compose recording/mixing/mastering with processing or
production terms. Artwork roles compose cover/visual/poster/packaging/video
subjects with design, illustration, coordination, editing and production duties.
This recognizes `混音/母带处理` and `封面设计` without song-specific rules.
A single backing-singer name still requires corroborating production rows;
`和声：一起唱` remains sung text even beside a credit block.

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
model input keep real performer turns. Native display validates that canonical
row/prefix evidence before exempting a projected vocal body from credit cleanup.
An inherited public speaker ID without a removed prefix does not exempt a row. IDs and hashes identify that canonical
document, independent of its API view. Existing clients remain compatible without
requiring a coordinated rollout of the saved-translation feature. Legacy documents are reprocessed into clean revisions by the explicit production migration; old IDs retain retirement records, not raw lyric payloads.

The response selection revision is `lyrics-selection-2026-09-30-storefront-1`.
Backend cache keys also include the normalization version. Native memory/disk
cache admission and durable song-library lookups use the matching revision;
older results remain readable during rollout but must be refetched rather than
recertified as current. Changes to occurrence structure or selection semantics must update these
versions together. Corrections that recognize additional production-role
combinations use the existing embedded-credit stale-source checks to refresh
only contaminated caches and reject new generation from their old immutable
documents; unaffected sources keep their identities. Existing translations are not regenerated in the background.

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

## Provider notices and bracket preservation

`api/data/lyric-notice-policy.json` is the authoritative version-1 declarative
notice policy, mirrored byte-for-byte into the app. Both runtimes compare whole
rows after NFKC, Traditional-to-Simplified conversion, lowercase and whitespace
removal. Comparison never rewrites retained lyrics or removes punctuation.
Rows containing CR, LF, VT, FF, NEL, LS or PS are not notices. At most one
balanced outer `[]` or `【】` pair is admitted; malformed, mixed or nested square
wrappers preserve the row. Round parentheses remain meaningful inside the legal
use-action clause. Arbitrary bracketed words, background vocals in parentheses,
unknown English/Japanese/Korean notices, quotations and sung copyright prose
remain readable. No row-position, timestamp or first-N heuristic is used.

The Chinese rights grammar consumes a formal rights holder, missing permission
or authorization, a prohibition and a bounded list of explicit use actions. The
longer declaration form consumes the rights-reservation clause, the same
permission/use clause (including an optional parenthesized action enumeration),
and an optional exact AI-training prohibition sentence. The existing complete
owner declaration remains recognized. Unconsumed prose preserves the entire
row; the former `本作品声明 ... 著作权 ... 权利保留` wildcard rule is removed.
Promotion recognition is limited to the evidenced `银河计划X星斗推` campaign
template with normalized X/×, script, width and spacing. Unknown A×B rows remain
lyrics. Production-role credits continue to use their separate complete-label
grammar, including English role labels.

`tests/fixtures/lyric-notice-grammar.json` separates three observed rows from
synthetic regression variants and adversarial preserved rows. The two screenshot
rows are from a screenshot headed 五十年以后 / 海来阿木; its raw provider ID and
duration were not verified. The longer rights row was printed from the
[NetEase item 3425563499 lyric endpoint](https://music.163.com/api/song/lyric?id=3425563499&lv=-1&kv=-1&tv=-1)
at 4.99 seconds on 2026-10-22. Only that printed notice is retained here, not a
full raw source payload or song lyrics. Other grammar variants are synthetic.

The same classifier removes notices from visible lines and canonical source
rows before romanization, source hashing and model input, and detects stale
embedded metadata in caches and generation preflight. Notices do not become
contributor credits. Notice-only responses are missing text, not instrumentals.
Recognized complete wrapped instrumental markers remain a separate rule;
unknown section labels such as `[Verse 1]` and `[Chorus]` are preserved. LRC
parsing consumes only leading valid timestamp syntax and whole recognized
header rows, preserving unknown brackets and inline bracketed words. Existing
fraction, repeated-timestamp and invalid-second behavior remains covered.

Verified raw performer cues are resolved before metadata classification. A
stripped performed body is protected on subsequent passes only by a valid
canonical row/prefix/annotation mapping. Every cue annotation must also name its
referenced performer through its captured source label, canonical name or
reviewed aliases; an unrelated standalone label cannot borrow a speaker ID.
Generic cue aliases retain their explicit All/Male/Female identity. Uncorroborated
custom aliases retain separate compact speaker labels. An unchecked prefix or inherited
speaker ID cannot exempt a notice. Selected-source previews carry optional
`candidate.lyricStructure` only when validated removed-prefix evidence exists.
Admission validates it against the exact previewed words, freezes the candidate,
then binds it as `selectedSourceCapsule.lyricStructure` in the immutable
`sourceHash` and projects it as `response.metadata.lyric_structure`. The validator
requires the response metadata to equal the bound capsule mapping. Existing
selected documents without this additive field keep their identities and public
speaker projection. Selection still binds the ordered visible bytes through
`expectedTextHash`: admission never cleans words after that hash, and changed or
still-contaminated choices return `selected_source_changed` for reselection.

`lyric-annotations-3`, the automatic selection revision and the selected-source
revision are unchanged. Targeted stale-source detection reacquires a new
immutable document while leaving old stored sources and saved results readable.
New translation and original Study against a contaminated old source fail before
allowance reservation or model invocation. There is no bulk migration or
background regeneration of saved content.
