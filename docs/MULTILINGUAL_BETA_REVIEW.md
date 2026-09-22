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
