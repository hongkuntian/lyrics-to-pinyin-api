# Initial multilingual beta review

The beta offers English, French, Spanish and Simplified Chinese as independent
translation and explanation choices. The admission lists are versioned in
`evaluation/multilingual/beta-policy.json`; deployment requires applying both lists
explicitly. The existing `*:en` admission remains. Other output targets have no
wildcard admission. Traditional Chinese output and non-English automatic correction
remain outside this release.

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
