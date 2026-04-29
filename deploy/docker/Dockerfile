# syntax=docker/dockerfile:1.7
#
# WhoEarns — all-in-one image.
#
# Contents:
#   - Node 22 runtime with the compiled app (api + worker entrypoints).
#   - PostgreSQL 16 (server + client), initialised on first boot.
#   - entrypoint.sh: inits the data dir if needed, starts postgres, runs
#     migrations, launches api + worker, and forwards SIGTERM.
#
# Runs as root so it can chown the mounted PVC to the `postgres` user on
# first boot; the long-running processes (postgres, node) drop to the
# `postgres` account via su-exec.
#
# Emitted JS layout:
#   tsconfig.build.json pins rootDir to ./src, so tsc emits:
#     - dist/entrypoints/{api,worker}.js
#     - dist/scripts/migrate.js
#     - dist/storage/migrations/runner.js (+ SQL files copied alongside)

ARG NODE_VERSION=22-alpine

# -----------------------------------------------------------------------------
# Stage 1: base — node + pnpm (via corepack).
#
# corepack is bundled with node and reads the `packageManager` field from
# package.json to pin the exact pnpm version. That means both local dev
# and CI install from the same pnpm build, so there's no "works on my
# machine" drift between developer shells and the Docker layer.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
WORKDIR /app
# `corepack enable` wires up the `pnpm` shim; `corepack prepare` forces an
# upfront download of the pinned version so the first real `pnpm install`
# below isn't billed for the download latency. The version must match the
# `packageManager` field in package.json.
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

# Silence husky's `prepare` script in every stage — husky expects a .git
# directory (there isn't one inside the build container) and bails loudly
# if it can't find one. `HUSKY=0` is the officially-supported opt-out.
# Devs picking up local hooks via `pnpm install` on their workstation
# still get husky installed because the env var isn't set there.
ENV HUSKY=0

# -----------------------------------------------------------------------------
# Stage 2: deps — install ALL backend dependencies (including dev) for the
# TypeScript build. Pruned back to production-only in stage 3b.
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# `--frozen-lockfile` is pnpm's equivalent of `npm ci` — fails if the
# lockfile is out of sync rather than mutating it in place. pnpm
# lockfiles record optional deps for every platform by default, so
# macOS→Linux drift (which was a recurring pain point with npm ci)
# doesn't happen here.
#
# `--ignore-scripts` blocks lifecycle scripts (postinstall, prepare)
# from running. We don't need husky to register git hooks inside the
# container (no .git dir), and sidestepping optional native compile
# steps (esbuild, cpu-features, etc.) keeps the deps layer small and
# fast. Runtime doesn't call any of those scripts either.
RUN pnpm install --frozen-lockfile --prod=false --ignore-scripts

# -----------------------------------------------------------------------------
# Stage 3a: ui-build — compile the SvelteKit SPA bundle.
#
# The UI lives in a separate pnpm package under `ui/` with its own
# `pnpm-lock.yaml`. Building it here produces a static bundle at
# `/app/ui/build/` that the runtime stage copies into the final image.
# No extra Node process at runtime — Fastify serves these assets
# directly via @fastify/static.
# -----------------------------------------------------------------------------
FROM base AS ui-build
COPY ui/package.json ui/pnpm-lock.yaml ./ui/
# `--dir ui` scopes the command to the ui package without a workspace
# config. `--frozen-lockfile` enforces reproducible installs.
# `--ignore-scripts` skips svelte-kit's `prepare` (regenerates
# .svelte-kit/) and any transitive native builds — vite handles
# everything during `build`.
RUN pnpm --dir ui install --frozen-lockfile --prod=false --ignore-scripts
COPY ui ./ui

# Build-time env baked into the SvelteKit bundle. Vite's
# `import.meta.env.PUBLIC_*` reads happen at build time, so any
# value the runtime UI needs (canonical site URL — drives all
# absolute URLs in canonical/og/JSON-LD) must be set BEFORE
# `pnpm run build`. Empty default keeps `$lib/site.ts`'s fallback
# in play for forks that haven't customised the deploy script.
ARG PUBLIC_SITE_URL=""
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL

RUN pnpm --dir ui run build

# -----------------------------------------------------------------------------
# Stage 3b: build — compile TypeScript and prune dev deps in place.
# -----------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# `docs/openapi.yaml` is the source-of-truth OpenAPI spec; the
# `copy-assets` build step (package.json) copies it to
# `dist/api/assets/openapi.yaml` so the runtime `seo.route.ts` can
# read it and patch `servers[0].url` per deployment. Without this
# COPY the copy-assets step fails with "can't stat docs/openapi.yaml".
COPY docs/openapi.yaml ./docs/openapi.yaml
# `pnpm prune --prod` drops devDependencies from node_modules after the
# build; equivalent to `npm prune --omit=dev`. Cleaning the pnpm store
# cache is a no-op with --frozen-lockfile (nothing was downloaded into
# the store at this layer), but we still clear it for belt-and-braces.
#
# `--ignore-scripts` on prune prevents pnpm from re-running the root
# `prepare` script after the prune deletes husky from devDeps — without
# this the prune step ends with `sh: husky: not found`.
RUN pnpm run build \
  && pnpm prune --prod --ignore-scripts \
  && rm -rf /root/.local/share/pnpm

# -----------------------------------------------------------------------------
# Stage 4: runtime — Node + embedded PostgreSQL 16.
# -----------------------------------------------------------------------------
FROM base AS runtime

# Postgres 16 + client tools. The postgres user (uid 70) / group (gid 70)
# are created by the postgresql16 apk package.
RUN apk add --no-cache \
      postgresql16 \
      postgresql16-client \
      bash \
      tzdata

# Pre-create the data dir parent and the unix-socket dir with postgres
# ownership so the first-boot entrypoint (running as uid 70) can mkdir
# the pgdata subdirectory and the postmaster can create its lock file.
# `/run/postgresql` is on tmpfs and does not persist across restarts.
RUN mkdir -p /var/lib/postgresql/data /run/postgresql && \
    chown -R postgres:postgres /var/lib/postgresql /run/postgresql

# Pruned (production-only) node_modules, compiled output, and package.json.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# SQL migrations: the runner uses import.meta.url, so place them next to
# dist/storage/migrations/runner.js.
COPY --from=build /app/src/storage/migrations/*.sql ./dist/storage/migrations/
# SvelteKit SPA bundle. `resolveUiBuildDir` in src/api/server.ts looks for
# it at `<repo>/ui/build/`, which after this COPY lands at `/app/ui/build/`.
COPY --from=ui-build /app/ui/build ./ui/build

# Entrypoint shell script that supervises postgres + api + worker.
COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    HTTP_HOST=0.0.0.0 \
    PGDATA=/var/lib/postgresql/data/pgdata

# Run as postgres (uid 70) so no capability escalation is needed at runtime.
USER 70

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HTTP_PORT:-8080}/healthz" || exit 1

# PGDATA must be a mounted volume in production so state survives restarts.
VOLUME ["/var/lib/postgresql/data"]

LABEL org.opencontainers.image.title="WhoEarns" \
      org.opencontainers.image.description="All-in-one Solana validator income transparency service: API + worker + embedded PostgreSQL." \
      org.opencontainers.image.url="https://whoearns.live" \
      org.opencontainers.image.source="https://github.com/0base-vc/whoearns-live" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
