# Agent Workflow

## Goal
Keep this backend safe for agent-first iteration with deterministic tests and stable API contracts.

## Required Commands
- Sync + install: `git pull --rebase && npm ci`
- Full hermetic gate: `npm test`
- Unit only: `npm run test:unit`
- Integration only: `npm run test:integration`
- Contract only: `npm run test:contract`
- Live smoke (non-blocking): `npm run test:live`

## Change Policy
1. Add or update tests before behavior changes.
2. Keep `npm test` hermetic (no external network assumptions).
3. Use dependency injection in handlers for testability.
4. Do not hardcode supported scripts/platforms in API responses.
5. Contract changes must be explicit and reviewed.

## Definition Of Done
- All relevant tests updated.
- `npm test` passes locally.
- API response shape remains contract-compatible or contract files are intentionally updated.
- Commit or PR includes short testing evidence with commands run.

## Checkpoint Delivery
- At satisfactory, verified checkpoints, merge into `main` and push `main` without asking for additional approval. The user authorizes direct mainline delivery during this project's current development phase; a pull request is optional.

## Execution Loop
1. Make one focused change.
2. Add or update tests first (or in the same change).
3. Run `npm test`.
4. Ship only with passing hermetic gates.

## Scope Notes
- `test:live` can fail due to upstream API drift and is not a merge blocker.
- Preserve current behavior if implementation is imperfect; record known deviations in tests.
