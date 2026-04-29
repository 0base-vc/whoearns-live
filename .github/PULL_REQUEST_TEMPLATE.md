# Pull request

## Summary

<!-- One or two sentences describing the change. -->

Closes #

## Type of change

- [ ] `feat` — new user-visible capability
- [ ] `fix` — bug fix
- [ ] `refactor` — behaviour-preserving cleanup
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `chore` / `build` / `ci` — tooling, deps, pipelines

## Testing

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm test`
- [ ] `pnpm run test:coverage` (coverage remains ≥ 80%)
- [ ] Manual testing (describe below)

<!-- What did you run and verify by hand? -->

## Backward compatibility

- [ ] No change to the public HTTP API.
- [ ] No change to the database schema.
- [ ] No change to the worker / API split or their env contract.

If any of the above is checked off, describe the impact and migration
path.

## Checklist

- [ ] Commit subjects follow Conventional Commits.
- [ ] Branch name follows `<type>/<short-kebab>`.
- [ ] New behaviour has tests.
- [ ] Relevant docs (`README.md`, `docs/*.md`, `CHANGELOG.md`) updated.
- [ ] No secrets or environment-specific values committed.
