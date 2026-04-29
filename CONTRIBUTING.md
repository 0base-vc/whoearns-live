# Contributing to WhoEarns

Thanks for your interest. This document covers how to set up a dev
environment, the expectations for patches, and the house style for
commits, branches, and reviews.

## Ground rules

- Be respectful. This project follows the
  [Contributor Covenant](./CODE_OF_CONDUCT.md).
- Open an issue before writing a large PR. For small fixes (typos,
  obvious bugs, docs) just send the PR.
- Security issues go to the process in [`SECURITY.md`](./SECURITY.md),
  not to the public issue tracker.

## Development setup

### Prerequisites

- Node.js 22 or newer (`node --version`)
- pnpm 10+ (ships with Node 22 via corepack)
- Docker (required by the integration test suite, which uses
  Testcontainers to boot a real PostgreSQL instance)
- A Solana RPC endpoint for local development. The public RPC works for
  a small explicit watch list; use a paid RPC for `*` mode.

### One-time setup

```bash
git clone https://github.com/0base-vc/whoearns-live.git
cd whoearns-live
pnpm install --frozen-lockfile
cp .env.example .env
# edit .env: set VALIDATORS_WATCH_LIST to a few vote pubkeys
```

`pnpm install --frozen-lockfile` also installs husky's pre-commit hook. That hook runs
`lint-staged`, which in turn runs prettier and eslint on staged files.
If you ever see "hooks not installed", run `pnpm run prepare` manually.

### Run the service

```bash
# terminal 1 — API
pnpm run dev:api
# terminal 2 — worker
pnpm run dev:worker
```

Both commands use `tsx watch`, so edits reload automatically.

If you don't have a local Postgres, either use the all-in-one Docker Compose
stack from `deploy/docker/docker-compose.yml`, or point `POSTGRES_URL` at a
remote instance when running bare Node.

## Project layout

```
src/
  api/            Fastify app, routes, schemas, serializers
  clients/        External clients (Solana RPC, Jito tip account helpers)
  core/           Config, logging, errors, small pure helpers
  entrypoints/    api.ts, worker.ts — thin process bootstraps
  jobs/           Worker ingestion jobs (epoch / slots / fees / reconciliation)
  services/       Cross-cutting application logic
  storage/        Postgres pool, repositories, SQL migrations
  types/          Shared domain types
test/
  unit/           Fast, no-I/O, runs on every commit
  integration/    Real Postgres via Testcontainers
  smoke/          End-to-end sanity checks
deploy/
  docker/         Dockerfile and compose for local dev
  helm/           Production Helm chart
docs/             Narrative docs (api, architecture, operations)
scripts/          CLI utilities (migrations, etc.)
```

## Tests

Every PR is expected to include tests:

- New code paths → unit tests.
- New SQL or repository methods → integration tests.
- New public API endpoints or behavioural regressions → smoke tests.

Run the full suite locally before opening a PR:

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:coverage
```

Coverage must stay at **80% or higher** on branches, functions, lines,
and statements. CI enforces this.

## Code style

- TypeScript, ESM, strict. No `any` without a comment explaining why.
- Prettier is the formatter. `pnpm run format` writes, `pnpm run
format:check` just checks. CI runs `format:check`.
- ESLint is the linter with `--max-warnings 0`. Warnings are errors.
- Naming:
  - Files: `kebab-case.ts` (repos use `.repo.ts`, jobs use `.job.ts`).
  - Types and classes: `PascalCase`.
  - Variables, functions: `camelCase`.
  - Env variables: `SCREAMING_SNAKE_CASE`.
- Error handling: throw `AppError` subclasses from `src/core/errors.ts`
  so the API's error handler can map them to the JSON error envelope.
- Lamport amounts: `bigint` in memory, decimal string at API
  boundaries, `NUMERIC(30,0)` in Postgres. Never `number`.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/).
A commit subject looks like:

```
<type>(<scope>): <short description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`,
`build`, `ci`, `perf`, `revert`.

Scopes map to top-level source folders (`api`, `worker`, `jobs`,
`storage`, `clients`, `core`, `helm`, `docker`, `docs`, `deps`).

Examples:

```
feat(api): add batch endpoint for current-epoch stats
fix(jobs): retry getBlock on -32005 after backoff
docs(architecture): explain reorg safety buffer
chore(deps): bump fastify to 5.2
```

Use the body to explain **why**, not **what** — the diff tells us what.

## Branches

- Start from `main`.
- Branch naming: `<type>/<short-kebab-description>` — for example
  `feat/batch-endpoint`, `fix/stuck-fee-cursor`,
  `docs/operations-runbook`.
- Rebase (don't merge) `main` into your branch before requesting
  review, to keep history linear.

## Pull requests

Open a PR against `main`. The PR template (see
`.github/PULL_REQUEST_TEMPLATE.md`) asks you to:

- Summarise the change in one or two sentences.
- List testing performed (unit, integration, smoke, manual).
- Call out any migration, config, or API change.
- Link the issue the PR closes.

PRs that modify public API shapes, the database schema, or the
worker/API split should describe backward-compatibility implications
explicitly.

CI must be green before a PR is merged. We squash-merge by default so
the main-branch history reads as a list of Conventional Commit
subjects.

## Issues

Use the templates under `.github/ISSUE_TEMPLATE/`:

- `bug_report.md` — reproduce steps, expected vs. actual, environment,
  logs.
- `feature_request.md` — problem statement, proposed shape, alternatives
  considered.

Please search existing issues first. Duplicates will be closed with a
link to the original.

## Releases

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/).
When we cut a release we move entries from `[Unreleased]` into a
versioned section and tag the commit.

## Code of Conduct

This project adopts the spirit of the Contributor Covenant (see
<https://www.contributor-covenant.org/>). The short, enforceable
version we actually follow is in
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Reports go to the
contact listed there.
