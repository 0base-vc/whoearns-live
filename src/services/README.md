# `src/services/`

Two file shapes live here, and the split is intentional:

- **Pure-utility modules** — bare exported functions, no dependencies,
  deterministic. No `.service.ts` suffix, no class. Examples:
  `node-tier.ts`, `client-kind.ts`, `tenure.ts`,
  `operator-activity-index.ts`.
- **Dependency-carrying services** — anything that takes a logger,
  repository, RPC/HTTP client, or other injected collaborator. Class
  with constructor dependency injection, `.service.ts` suffix.
  Examples: `github-gist-verification.service.ts`,
  `simd-curation.service.ts`, `wallet-activity-indexer.service.ts`.

Rule of thumb: if it would take a constructor arg, it's a class with
the `.service.ts` suffix. If it's a pure function, leave it bare —
don't wrap it in a needless class just to "match" the suffixed files.
