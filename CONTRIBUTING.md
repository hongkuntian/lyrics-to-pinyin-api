# Contributing

## Development Setup
1. `git pull --rebase`
2. `npm ci`
3. `npm test`

## Quick Agent PR Flow
1. Pick one scoped task.
2. Add or update tests first (or with implementation).
3. Run `npm test`.
4. Open PR with testing evidence.

## Test Strategy
- `test:unit`: pure modules and processors.
- `test:integration`: handler behavior via dependency injection and mocks.
- `test:contract`: schema and app-compatibility checks.
- `test:live`: optional upstream API smoke tests.

## Pull Request Checklist
- [ ] Added/updated tests for behavior changes.
- [ ] Ran `npm test` successfully.
- [ ] Updated contract files when response shape changed.
- [ ] Included test evidence in PR description.

## Review Expectations
- Prefer small PRs with one focused change.
- Keep default tests deterministic.
- Avoid introducing network calls into hermetic test suites.
