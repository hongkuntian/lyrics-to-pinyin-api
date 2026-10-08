# Content quality checkpoint, 7 October 2026

New English v2 Study requests use original-source authority, explicit unresolved
wording instructions and validated internal field evidence. Saved explanations,
cache recipes and public DTOs remain compatible. Translation models and prompts
are unchanged. Targeted evidence supports this bounded change; it does not
establish paid-launch readiness or linguistic certainty.

## Production and reused evidence

The live production deployment inspected at the start was
`dpl_8vyzgDyLyhQGGfc7qU1mUauLUJaH`, Git SHA
`7e1c83f948f292198603f1d34c7ecb95ac78f688`. Translation already reads an ordered
whole-song document, source-owned turns, contextual lexical alternatives and
changed refrains. Translation and Study use GPT-6 Luna, xhigh reasoning and the
default tier. Study also receives the complete source and optional accepted
translation; the missing safeguard was explicit source priority over a fallible
translation and restraint about unresolved wording.

Prior Lyrica `evaluation/translation` capability, meaning, Luna and beta-readiness
research and retained real-song outputs were reused. Their fluency/structure
results do not certify meaning; broad model comparisons were not repeated.
Current research Python regressions passed 107 tests without provider generation.

A read-only production snapshot contains 20 current translations (954 source
occurrences) and 40 ready Study explanations. All 20 translations have complete
ordered occurrence coverage; the sample has no rejected source notes. Neither
fact establishes fidelity. Nine complete source songs and translations, totaling
382 occurrences, received unblinded AI review:

| Complete song | Preserved strengths | Unresolved source/meaning questions |
| --- | --- | --- |
| 星语心愿 (Movie Version), 25 | Separation, helplessness, changed traces; useful existing spatial note | Compressed sky-related clause remains a question/request ambiguity |
| 说散就散, 34 | Limited affection, love/hate negation, regret and changed final refrain | Some omitted subjects and clause attachments remain open |
| 領悟, 63 | Crying and revenge denials; self versus addressee refrains; conditional suffering | Unusual supplied fragment must not be replaced from memory |
| 甲乙丙丁, 42 | Entrusting/returning the heart; generic labels distinguished from contextual strangers | English plural subject in the dinner passage is an added interpretation |
| 真的愛妳, 42 | Maternal context; unclear Cantonese fragment retained with a source note | Spring-wind/rain idiom and compressed glory-sharing objects need bilingual review |
| 至少还有你, 43 | Aging, palm image, ability/negation and changed final particles | Compressed declarations and hard-won/at-last interpretation remain uncertain |
| 因為愛情, 28 | Coherent love/aging imagery and refrains | Omitted subject narrowed to an English plural; no source-owned duet turns |
| Rice Field, 32 | Discouragement-to-home movement, childhood images and consistent refrains | River/action attachment and poetic ellipses remain interpretive |
| 夜曲, 73 | Loss/nocturne imagery and changed refrains without performer biography | Older source includes credits and unusual wording; source refresh needs separate evidence |

The 40 standalone Study outputs were read, but this is not a full source-fidelity
review of all 40. The refreshed provenance export includes stored generation
requests, explanation language, layer and exact selection identity for subsequent
offline replay. Existing adequate content is retained; none was regenerated or
replaced in the production database by this task.

## Demonstrated failures and implemented changes

* A normalized public lyric row removed a performer prefix while the canonical
  uncertainty note quoted the full raw row. The note was consequently dropped.
  Public projection now maps an exact canonical quote to that same occurrence's
  exact visible lyric body, preserving the canonical note and its wording.
* Newly generated translation notes with invented/mismatched source evidence
  were silently discarded by the tolerant saved-content parser. Generation now
  rejects such a response with `invalid_source_evidence`, retaining provider
  usage for settlement. Saved parsing remains compatible; no automatic retry.
* Correction assessment edits lines but carries existing notes forward, and its
  anonymous comparison does not assess those notes. A proposed change touching
  a noted occurrence now defers with `source_note_requires_review`; the current
  revision remains. An integration regression exercises assessment, comparison,
  settlement and replay: two submissions total, no replacement or repeated call.
* Study's current wording could still propose an unconfirmed spelling repair and
  teach its grammar. Exact selected offsets also failed to disambiguate a repeated
  character in one baseline response. New English v2 jobs receive explicit source
  authority/no-repair instructions and require exact original/translation row
  evidence for substantive fields. Invalid evidence fails before content storage.
  Evidence is projected away from the unchanged public DTO.

Exact evidence validates identity and field coverage, **not semantic entailment**.
The experiment changes instructions and evidence schema together; it does not
isolate which caused the observed gains. Old admitted requests keep their frozen
body/parser. Legacy Study and untested explanation languages keep their prior
generation behavior. Model, prices and saved cache recipes are unchanged.

## Fresh same-model evaluation

See [protocol](PROTOCOL.md), [case definitions](cases.json),
[confirmation cases](confirmation-cases.json), [review](review.json) and
[immutable evidence hashes](receipts.json). Complete source songs, selections,
request bodies, provider responses and usage are retained privately outside Git.

| Measure | Initial paired experiment | Focused confirmation |
| --- | --- | --- |
| Requests | 28: 14 control, 14 candidate | 16: 8 control, 8 revised candidate |
| Structural validity | 28/28; all candidate evidence checks pass | 16/16; all candidate evidence checks pass |
| Requested English | One candidate uses Chinese prose | All eight revised candidates use English |
| Real unclear-word diagnostic | Both candidate repeats retain uncertainty and omit guessed replacement grammar | Gain retained in both repeats |
| Fresh ambiguous passage | Baseline teaches a hypothetical replacement's unsupported syntax; candidate leaves wording unresolved | New unrelated fragment remains unresolved in both conditions; no additional gain claimed |
| Repeated character's return sense | Fixture mistakenly selected the first character; pair excluded from this conclusion | Correct final-character selection: baseline teaches “still”; candidate teaches “return” and distinguishes both uses |
| Other meanings | Most baseline checks already work: labels, negation, maternal context, changed refrain, qualified affection, agency, dialect and translator choices | Correct negation, dialect and translator-choice behavior retained |
| Median provider time, control / candidate | 8.05s / 14.75s | 8.30s / 20.93s |
| Usage estimate, control / candidate | $0.013184 / $0.020978 | $0.007309 / $0.012537 |

The first repeated-word fixture error was corrected using an explicit occurrence
index. The harness now rejects ambiguous repeated selections without that index.
The initial language failure is retained in the review, not counted as a success.
After explicit output-language instructions, all eight adopted request bodies
exactly match the evaluated confirmation candidates. These small descriptive
samples do not establish a general error rate. The candidate's extra latency and
output cost are material tradeoffs; no broad superiority is claimed.

Total completed generation: 44 requests, usage estimate **$0.054008**. Conservative
holds for earlier unsuccessful credential attempts add **$0.147399**, for total
accounted **$0.201407 of the authorized $5**. No further paid requests are required.
These amounts derive from conservative documented rates and retained usage, not
an invoice. Unknown charges remain held rather than assumed free.

## Verification and remaining work

Hermetic coverage includes exact evidence/occurrence rejection, generated-note
failure accounting, preservation of public uncertainty, old admitted Study
compatibility, correction deferral/replay, plan integrity, budget bounds, exclusive
start markers and a nonspending read-only export. Final combined-candidate results
and production identity are retained in the delivery receipt outside Git.

No app code or native assets change in this checkpoint, so native Cloud, simulator
UI and Sqim are not applicable. The concurrent Pro journey task owns its native
replay, UI acceptance and delivery. This task does not claim those results.

Unresolved: independent bilingual review; recording evidence for anomalous source
words and speaker turns; correction review that can jointly assess/edit uncertainty
notes; explanation languages outside English v2; broader repeated-token and agency
coverage; long-song truncation/reliability; and general output-language compliance.
The existing source ambiguities above are preserved until better evidence exists.
