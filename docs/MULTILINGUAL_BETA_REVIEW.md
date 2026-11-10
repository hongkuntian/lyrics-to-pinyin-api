# Initial multilingual beta review

The beta offers English, French, Spanish and Simplified Chinese as independent
translation and explanation choices. The admission lists are versioned in
`evaluation/multilingual/beta-policy.json`; deployment requires applying both lists
explicitly. The existing `*:en` admission remains. Other output targets have no
wildcard admission. Non-English automatic correction remains outside this release.
Traditional Chinese output was added on 9 November 2026 (last section).

## Evidence and fixes

The September 21, 2026 live review used the production request builders and the
complete ten-line source for every request: 12 direct translation directions,
12 original selections, and 12 selections from French, Spanish and Chinese
translations explained in each of the four languages. The final review deployment
was `lyrics-to-pinyin-rjzyziw14-patricks-projects-6b005567.vercel.app` (unpromoted).
Full decoded provider outputs are retained in the task's ignored evaluation
artifacts, with source lines, response IDs, usage and selected text.

Earlier runs translated the name Luz as Light/光 and strengthened ordinary past
negation into never. Current translation recipes explicitly preserve names and
negation scope. The final outputs retained Luz, distinguished not asking someone
to stay from asking them not to stay, retained the window/door contrast, preserved
the changed refrain occurrences, and left the addressee and possible relationship
unstated. Chinese experiential 过 was rendered as ever in one English line; this is
supported by that source and differs from the earlier unsupported never insertion.

A Chinese explanation of Spanish Nadie initially assigned it grammatical gender.
The new non-English explanation recipe limits grammar claims to useful, confident
features and avoids gender claims for invariant pronouns. The final response
correctly described its indefinite-pronoun role, singular agreement and negative
subject. The translated-selection review distinguished Au/Al from the whole dusk
phrase and 黄昏 from its surrounding sentence, with exact selected quotes. All four
explanation languages preserved that distinction without claiming the translated
words occur in the original recording.

## Limits and operating decision

This is a constrained beta admission based on source-grounded model-assisted review,
not independent bilingual certification or a representative commercial-song quality
benchmark. The four original evaluation songs are parallel stress cases, not four
independent musical styles. Some French poetic ellipses remain literal or awkward;
Chinese window/door ellipses can be terse. These are retained as beta quality risks,
not scored as proof of polished literary translation. Broader real-song evaluation
should cover more genres, duets, regional idioms and long mixed-language sections
before expanding admission or claiming general quality.

The backend's `en` source label can represent a Latin-script fallback. Its direction
list is an operational gate, not proof of precise source-language classification.
The app recognizes the complete lyric text and only skips same-language generation
when all meaningful lines support that decision. Mixed lines remain translatable.
No lyric source, accepted translation or user practice data was replaced by these
evaluations. Existing accepted translations are reused, and accepted provider
requests retain their exact snapshots across deployments.

Rollback new generation by restoring both environment policies to `["*:en"]` and
deploying normally. Saved target-specific content remains readable. No destructive
migration or cache reset is needed.

## Japanese, Korean and Portuguese directions (8 November 2026)

`evaluation/multilingual/expansion-corpus.json` adds one authored ten-line stress
case each for `ja`, `ko` and `pt` (denied agency, whose-tomorrow, negated saying
versus negative request, a name that is also a common word, unstated speaker and
addressee). The production builders translated each case into en/fr/es/zh-Hans and
explained one original selection in each language: 12 translations and 12
explanations, USD 0.036 recorded usage. They ran in an evaluation-only production
build (`LYRA_EVALUATION_ONLY_BUILD=1`), which logs records to stderr and always fails,
so it cannot be promoted. A first run lost its records because the packaging wrapper
discards preflight stdout; it was rerun unchanged.

All 12 explanations passed: each separated the negated saying from the quoted
request/command, kept the speaker and addressee unstated and gave accurate grammar.
Japanese and Portuguese translations passed in every target; Korean es/zh-Hans
passed. Two Korean translations failed in the first sample and passed in a second:
ko→en invented "no one" as the subject of lines 7–8 (inverting line 8), and ko→fr
made someone other than 하늘이 the one who will come again. ko→en is already admitted
by `*:en`; this is recorded as an intermittent beta risk. ko→fr translation is held;
ko→fr explanation is admitted. Names stay in source script (ハル, 하늘이) rather than
being romanized, and ja→fr rendered 名前 as singular; both are minor.

Added translation directions: ja/pt → fr, es, zh-Hans; ko → es, zh-Hans. Added
explanation directions: ja/ko/pt → fr, es, zh-Hans. The production policy was
verified equal to the previous file by SHA-256 fingerprints logged from an
evaluation-only build (secret values are redacted from Vercel logs) before both
environment lists were replaced with this file. This is one model-assisted review of
authored stress cases, not bilingual certification or a real-song benchmark.
Rollback restores the previous lists (the file at its prior commit) and redeploys.

## Clause roles in quoted speech (8 November 2026)

Recipes `song-clause-6-roles-1` (English) and `song-multilingual-3` add three rules:
omitted subjects take the reading the lyric supports (never a universal no one or
everyone), quoted or reported speech keeps each negation on what it negates, and a
named person's reported plan stays theirs. Three fresh runs of the ja/ko/pt corpus
(36 translations, 36 explanations) had ko→en lines 7–8 and ko→fr line 9 correct
every time, and no critical error in any direction. A beta-corpus run (12 directions
plus translated-selection explanations) kept the September fixes: Luz, negation
scope, window/door and changed refrains. Minor: one ja→fr run romanized ハル as
"Haru" and repeated it; one ko→zh-Hans run dropped the 이 of 하늘이. ko→fr translation
is now admitted. Recorded usage for the four runs was USD 0.116.

The recipe change stops reuse of translations accepted under the previous recipes
for new readers; accepted translations remain readable and are not regenerated.

## German, Italian, Indonesian, Vietnamese, Russian, Hindi and Thai (8 November 2026)

`evaluation/multilingual/expansion-2-corpus.json` adds the same authored ten-line
stress case in `de`, `it`, `id`, `vi`, `ru`, `hi-Latn` (Hindi in Latin letters) and
`th`: denied agency, whose-tomorrow, "I don't ask you to stay" against "I ask you not
to stay", and a name that is also a common word (Rosa, Stella, Bintang, Mai, Вера,
Chanda, ฟ้า). One evaluation-only production build translated each case into fr, es
and zh-Hans and explained the selected request in each (21 translations, 21
explanations); two more builds resampled Indonesian and Thai. Recorded usage was
USD 0.102.

All 21 explanations passed: each separated the negated asking from the negative
request and read the grammar correctly (bitten + nicht zu, chiedere di non,
meminta-mu untuk tidak, xin … đừng, просить + не, mat + imperative, ขอให้ … อย่า).
German, Italian, Vietnamese, Russian and Hindi translations passed in every target.
Minor: Russian names stay in Cyrillic in fr/zh-Hans (the fidelity rule keeps source
spelling), de→es rendered "wessen Morgen" as "la mañana" (the source noun also means
morning) and Vietnamese line 10 was softened to "I'm not sure yet".

Indonesian and Thai translations are held. Over three samples Bintang became "the
star" in 4 of 9 translations and ฟ้า became "the sky" in 2 of 9, despite the existing
rule that a possible personal name must not silently become its dictionary meaning
(both lines also read naturally as personification). id→fr also garbled "besok
siapa" (whose tomorrow) in 2 of 3 samples. Both languages remain translatable into
English through `*:en`.

Added translation directions: de/it/vi/ru/hi-Latn → fr, es, zh-Hans. Added
explanation directions: de/it/id/vi/ru/hi-Latn/th → fr, es, zh-Hans.

Source labels: the backend now labels Latin-letter Hindi `hi-Latn` (franc called it
Hausa, `hau`) with the same conservative word test the app uses; Devanagari is never
inferred and Urdu written the same way is indistinguishable. Responses cached before
this change keep their old label until they expire, so those songs stay English-only
until refreshed. Short Indonesian passages can still be labelled Malay (`zlm`); no
`zlm` direction is admitted.

## Personal names that are common words (8 November 2026)

Recipes `song-clause-6-roles-2` (English) and `song-multilingual-4` add one rule: a
word that is also a common noun or a natural thing but acts as a person (laughs,
smiles, says, promises, comes back) is a personal name and keeps its source spelling
in every target unless surrounding lines make the image clearly figurative. Two runs
of the seven-language corpus in all 28 directions kept Bintang and ฟ้า as names in
16 of 16 Indonesian and Thai translations (6 of 18 failed under the previous
recipes) with no new error elsewhere. A ja/ko/pt run and a beta-corpus run kept every
earlier fix (negated sayings, Luz, window versus door, changed refrain). Minor:
ja→fr romanized ハル as Haru, hi-Latn→fr once rendered kal as "le lendemain", and
Vietnamese line 10 is still softened. Recorded usage for the four runs was USD 0.183.

Indonesian and Thai translation into fr, es and zh-Hans is now admitted (43
translation, 46 explanation directions). As before, the recipe change stops reuse of
translations accepted under the previous recipes for new readers; accepted
translations remain readable.

The 43-entry translation policy was written to the environment after the `c9c30db`
production deployment had been created, and Vercel applies environment changes only
to new deployments. Indonesian and Thai translation into fr, es and zh-Hans therefore
first reached production with the next deployment (below). Update the policy before
pushing the commit that should carry it.

## Names in the target script, Malay, ellipsis (8 November 2026)

Recipes `song-clause-6-roles-3` (English) and `song-multilingual-5` replace "keep the
source spelling" for names: a name is never translated, and it is written in the
target's script. Latin-script targets keep Latin names and romanize others with the
usual system for the source (Pinyin without tones, Hepburn, Revised Romanization,
common Russian transliteration, RTGS for Thai); Simplified Chinese keeps Han names and
writes others in Latin letters. Attached particles (Korean 이) are dropped. Under the
previous rule ハル, 하늘이, ฟ้า and Вера stayed in their own script inside English,
French, Spanish and Chinese sentences. A second rule keeps the omitted action in a
contrastive elliptical clause (the window waits; me, maybe not).

One run of the eight-language corpus in all 32 directions, one ja/ko/pt run and one
beta run (56 records, USD 0.138): every name was romanized and kept as a name (44 of
44: Vera, Fa/Fah, Haru, Haneul/Haneuri, Suria, …), the morning/evening negation
contrast held in all 32 expansion directions, and Vietnamese line 10 now keeps the
contrast in every target ("I may not be"; 未必还在等). de→es "wessen Morgen" had already
been right under the previous recipe. Minor: 하늘이 is romanized with its suffix
(Haneuri) in three targets; French and once Chinese add a gendered pronoun for a
name of unknown gender. Chinese-character names (zh→en Pinyin) are not in these
corpora and remain unmeasured.

Malay is now a source label, `ms`. franc scores Indonesian, Malay and related languages
within a few hundredths, so short or casual Indonesian was labelled unknown (`und`,
English-only) and franc's top guess for slangy Indonesian was even Madurese. When
Indonesian and Malay are both within 0.05 of the top Malayic guess, marker words common
in one standard and rare in the other decide (`indonesianOrMalay`); words both use in
lyrics are not markers, and an undecided ind/zlm tie is Indonesian. The new `ms-window`
case translated correctly into all four targets (French line 2 rendered "whose
tomorrow" loosely). Malay translation into fr, es and zh-Hans is admitted (46
translation directions). Malay explanations are held: all four lead with "don't
leave" for *jangan tinggal* while the accepted translation says "not to stay"; the
English explanation is still served through `*:en`. The explanation policy stays at
46 directions.

## Name suffixes, gender, place names, Malay explanations (9 November 2026)

Recipes `song-clause-6-roles-4` (English) and `song-multilingual-6` change three rules:

- A particle or suffix attached to a name is not part of the name: Korean 이 after a
  consonant-final name (familiar suffix or subject marker) and vocative 아/야, Japanese
  さん/ちゃん/くん. 하늘이, 하늘이가 and 하늘아 are all Haneul.
- No invented gender. When the source does not mark a person's gender and the name is
  not conventionally one gender, the target uses a pronoun without gender (singular
  they) or a construction that needs none (direct speech, an infinitive, 自己, no
  pronoun).
- A place with an established name in the target language uses it (Pékin, Kioto, 釜山);
  the Latin-letters rule for Simplified Chinese applies to personal names.

`evaluation/multilingual/names-corpus.json` adds three short authored cases: Chinese
names into English, French and Spanish (小雨 as a person and as light rain, 林晓月, 苏州,
北京), Japanese kanji names into all four targets (美雪, 健太, 京都) and Korean names with
attached particles (하늘아, 하늘이가, 하늘이는 next to 하늘 the sky, 지민이는, 부산). The Malay
case's lines 7 and 8 now say *tinggal di sini*: bare *tinggal* can mean stay or leave,
which the model itself noted, so the earlier explanation/translation disagreement
came from the test line.

Final wording, one run of each corpus (66 records, USD 0.154; two earlier draft-wording
runs of names and the eight-language corpus cost USD 0.200 and agree):

- Names: Xiaoyu, Lin Xiaoyue, Suzhou and Beijing/Pékin/Pekín in every zh direction, with
  the weather 小雨 translated as light rain; Miyuki, Kenta and Kyoto/Kioto in Latin
  targets and 美雪, 健太, 京都 kept in Simplified Chinese; Haneul and Jimin without
  suffixes in every Korean direction of both corpora (previously Haneuri in three),
  with 하늘 the sky still translated. 부산 is 釜山 in Chinese under the place rule (one
  draft run without it wrote Busan).
- Gender: across three runs no gender was invented for Bintang, Suria, Fa, Mai or
  Haneul in any target. French used direct speech or a noun phrase ("a annoncé son
  retour"); in 3 of 12 French samples it repeated the name instead ("Bintang a dit que
  Bintang reviendrait"), which is faithful but stiff. Names that are conventionally
  one gender (Vera, Stella, Rosa) keep their pronoun.
- Malay explanations into en, fr, es and zh-Hans all say "not to stay here", matching
  the translation, in all three runs (12 of 12). Malay explanation into fr, es and
  zh-Hans is admitted: 49 explanation directions, 46 translation directions.
- The morning/evening negation contrast and line 10 held in all 44 expansion
  directions; the beta corpus shows no regression.

Open: in each of two names runs one Korean direction (ko→fr, then ko→en) ended
`provider_incomplete`; the same directions completed correctly in the other runs. The
selection (하늘이는 오지 않아, name or sky) is deliberately ambiguous, and the explanation
request allows 4,096 output tokens including reasoning, so a hard selection can run
out. That budget is unchanged here. Correction: a failed explanation is not retried.
It is stored as failed under its cache key, and the same selection keeps returning 409
for every reader; only translations have a retry path. The budget is raised in the
next section.

Language labels: franc's choice between Indonesian and Malay follows the topic, not
the standard (authored Indonesian and Malay versions of the same lines score the same
way, and formal Indonesian was labelled Malay). The pair is now labelled `ms` only on
evidence, in order: two or more marker words outnumbering the other side (the lists
gain the standard spelling pairs karena/kerana, bahwa/bahawa, pikir/fikir,
senantiasa/sentiasa and common lyric words such as mau, butuh, kangen), a verified
catalog genre (Apple files some songs under "Malaysian Pop" or "Indo Pop"), or one
Malay word with no Indonesian one where franc also leans Malay. Otherwise the pair is
Indonesian. The app follows this label when it has one.

## Word help per line in every explanation language (9 November 2026)

Until now a word tap used two request shapes. English asked for all the words of the
line at once (`explain_line`, recipe `study-line-1`); French, Spanish and Chinese asked
for one word at a time (`explain`, recipe `study-text-2`). The earlier explanation
evaluations in this document used the one-word request in every language, so they did
not exercise the English path the app uses for word taps.

`explain_line` now accepts every explanation language. A paid line-mode run
(`LYRA_EVALUATION_MODE=line`, `LYRA_EVALUATION_COMPARE_SINGLES=3`) asked for every
word of the selected line in all four corpora, 67 directions and 478 words, and for
the first three words of each non-English direction one at a time for comparison (150
requests). USD 0.185 in total.

- All 67 line requests completed; every item was grounded in the exact lyric row and
  written in the requested language (478 of 478 by language identification).
- Meaning and context agree with the one-word answers and are shorter (about 90
  characters per field in French and Spanish, 35 to 40 in Chinese). The negation scope
  of the window lines is stated the same way for every word of a line. The names cases
  keep the distinction: 小雨 in the rain line is light rain with the name noted, and
  하늘이는 is Haneul against 하늘은 the sky.
- One-word answers hedge more ("could suggest a change of stance") and fill the
  uncertainty field with unstated-subject notes in most items; line answers used it in
  3 of 359 non-English items.
- The loss: line help has no grammar field. The one-word answers carried a note such
  as the contraction behind Portuguese "À" or the parts of 아침에는. English word help
  has been without it since line help shipped; the whole-line page keeps its grammar
  section because it still uses `explain`.
- Cost per word: USD 0.00022 by line against USD 0.00055 one at a time. A reader's
  allowance counts requests, so a line now costs one attempt instead of one per word.
  The largest line request used about 5,600 of its 32,768 output tokens.

The one-word request remains for phrase and whole-line selections in every language.
Its output budget is 8,192 tokens. In this run the hardest single selection (하늘이는
into Chinese) used about 4,000, the old limit; all 150 completed.

## Traditional Chinese output (9 November 2026)

Traditional Chinese (`zh-Hant`, also zh-TW and zh-HK) was a known target that no
direction admitted, because the first beta did not review it. It is generated directly
by the model. It is not converted from the Simplified result: several Simplified
characters have more than one Traditional form (发 is 發 or 髮), and Study selections
bind to the stored text.

Four paid rounds (`LYRA_EVALUATION_TARGETS=["zh-Hant"]`, USD 0.163 in total) covered
translation, phrase explanation, word help by line and translated-word explanation from
all 15 sources that are admitted into Simplified Chinese. Script was checked by
machine: a Traditional answer may contain no character that has a distinct Traditional
form, quoted lyric words excepted.

- First round, 16 directions: no Simplified character in any translation or
  explanation, and the morning/evening negation lines hold. It exposed one defect: the
  name rule named "Simplified Chinese" only, so Traditional had no rule and one name
  came back three ways (Luz, 露絲, 露斯). The rule now applies to Traditional Chinese
  under its own name; in the rerun all 14 non-Chinese names stay in Latin letters, as
  they do in Simplified, and Chinese names keep their characters (林曉月, 蘇州).
- A Simplified-script lyric explained in Traditional came back in Simplified in 1 of 2
  phrase explanations. Explanation requests for Traditional Chinese now state the
  script. After that: 6 of 6 phrase explanations and 2 of 2 line requests for Chinese
  songs are clean, and so are all other Traditional outputs of the final round.
- A Chinese song translated into Traditional Chinese (admitted for bilingual lyrics,
  as `zh:zh-Hans` is) is a faithful script change with names kept, 6 of 6.
- Not admitted: a Traditional translation explained in Simplified Chinese
  (`zh-Hant:zh-Hans`). Both samples came back in Traditional or mixed script. The same
  pull probably affects the existing `zh:zh-Hans` explanations when a song's lyrics
  are in Traditional script; no corpus case covers it, and the Simplified request text
  is unchanged here.

Admitted: 61 translation and 68 explanation directions. Every other target's request
text is byte-identical, so no recipe changes and no saved content is invalidated.
