# Source-grounded Study and translation uncertainty

The fixed hypothesis is that original-source authority, explicit handling of
unresolved wording, and exact evidence for each substantive Study field reduce
unsupported teaching without harming correct explanations. This is not a model
comparison. Control and candidate use production GPT-6 Luna, xhigh reasoning,
default tier, 4,096 output tokens, complete source songs and identical selections.
Candidate changes instructions and requires internal field evidence together.

`cases.json` fixes three diagnostic selections with two repeats per condition,
then eight fresh selections with one attempt per condition: 28 requests. Fresh
means a new selection/generation case in this experiment, not an independently
sampled recording. Six real-song selection cases use retained production inputs;
two additional real-song cases deliberately corrupt one supplied translation
line. Three fresh authored dialogues probe agency, dialect and unreadable source.
Those controlled corruptions must never be described as production defects.

Review the full source and each complete result. Record structural validity,
natural writing and semantic fidelity separately. Valid JSON or an exact evidence
quote is not a semantic pass. Audit component/phrase distinctions, speaker roles,
negation, changing refrains, contextual word sense, metaphor, source anomalies,
and whether uncertainty is qualified in the claim itself. Preserve dissent or
plausible alternative readings rather than resolving them by fluent wording.

Promote only if a source-grounded failure improves on diagnostic and fresh cases,
valid candidate outputs do not introduce confirmed semantic regressions, and
structural reliability remains adequate on this sample. A failed field-evidence
check is retained without repair or retry. Naturalness gains alone do not qualify.
Root review is unblinded AI assessment, not independent bilingual certification.
This small corpus cannot establish paid-launch readiness or general reliability.

The authorized external ceiling is US$5 for the entire task. Each prepared plan
reserves all calls before execution; uncertain prior attempts remain accounted
through `--previous-accounted-micros`. Rates use the production conservative
cache-write price, US$0.125/million input and US$0.50/million output, verified
against [official Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
The byte bound plus overhead stays below the 272K long-context threshold. Usage
estimates are not invoices. No retries, alternative provider, production cache
write, account allowance, or unrequested model sweep is part of the experiment.

```sh
node scripts/evaluate-content-quality.mjs prepare \
  --snapshot /private/evidence/production-snapshot.json \
  --directory /private/evidence/paired-run \
  --budget-micros 5000000 --previous-accounted-micros 0

node --env-file=/private/provider.env scripts/evaluate-content-quality.mjs run \
  --directory /private/evidence/paired-run \
  --approved-plan-sha256 <independently-reviewed-plan-hash> --live yes
```

Use `--corpus evaluation/content-quality/confirmation-cases.json` for the focused
post-review confirmation. Repeated identical text within a row requires the
explicit zero-based `textOccurrence`; ambiguous selections fail before planning.

Plans freeze complete bodies, source inputs, generator hashes and request order.
The exclusive start marker prevents resending an interrupted run. Results retain
provider IDs, raw output, usage, elapsed time and actual/conservative accounting.
Production credentials and complete commercial lyrics stay outside Git.

The nonspending snapshot can be refreshed explicitly using the existing private
owner database configuration. It uses a read-only transaction and exports at most
20 current translations and 40 completed explanations, without user identities:

```sh
node scripts/audit-content-quality.mjs \
  --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json \
  --output /private/evidence/production-snapshot.json
```

Refreshing a snapshot changes the experiment inputs. Reuse a retained snapshot to
reproduce an earlier review; create a new plan for a new live snapshot.

When the key is Vercel Sensitive, copy the reviewed plan to the temporary,
untracked `evaluation/content-quality/private-plan.json` and use the established
unpromoted build route:

```sh
vercel --prod --skip-domain --logs \
  --build-env LYRA_CONTENT_QUALITY_EVALUATE_ON_BUILD=1 \
  --build-env LYRA_CONTENT_QUALITY_PLAN_HASH=<reviewed-plan-hash>
```

The build hook runs once per build container under an exclusive `/tmp` lock.
Normal builds make no evaluation calls. The flag is deployment-local, never a
project setting. Capture `content_quality_chunk` log records, group by record,
verify every index/count, decode base64 and retain each JSON. Do not automatically
retry a failed/restarted build: its provider costs may be unknown. Do not promote
an evaluation deployment. Remove the temporary private plan after evidence review.
The deployment's streaming CLI output can end before the result chunks arrive.
After completion, retrieve the full retained log with `vercel inspect <url>
--logs`; missing chunks are an evidence-recovery problem, not permission to resend.

Validated grounding is adopted only for new English v2 Study jobs. Saved Study
cache recipes and public fields are preserved. Already-admitted old
requests continue through the old parser. Source quotes remain exact; the new
internal evidence is validated then projected away from the public DTO. Existing
good content is reused without an automatic regeneration or replacement.
