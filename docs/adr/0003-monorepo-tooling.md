# ADR-0003: Monorepo tooling and dev stack

- Status: Accepted
- Date: 2026-10-20

## Decision

- **One repo, two package managers, each in its own lane.** pnpm workspaces for TypeScript
  (`apps/*`, `packages/*`); a uv workspace for Python (`services/*`). No Turborepo or Nx yet;
  `pnpm -r` and a Makefile are enough at this size.
- **Shared contracts are JSON files** in `packages/shared` (feature flags, analytics event
  schema, validation cases), read by both TS and Python. Shared test cases run on both sides,
  so the validators cannot drift.
- **Single front-end stack:** Next.js App Router for every web surface, as the plan asks (PLAN.md §8:
  no second stack to migrate to later). Tailwind CSS v4 with design tokens as CSS variables.
  `next-intl` with English unprefixed and Hindi under `/hi`. Locale comes from the URL only, so each
  URL is one canonical page.
- **Version policy:** dependencies resolve to releases at least two weeks old at lock time
  (`exclude-newer` in uv; versions chosen by date for npm), and lockfiles are committed. Upgrades
  are deliberate PRs.
- **Dev stack:** `make dev` runs Postgres 16, Redis 7, API, astro engine and web in Docker
  Compose and waits until all health checks pass. CI runs the same checks as `make ci`.
- **Time:** servers store and return UTC instants plus an IANA zone. `packages/shared` owns the
  one IST "today" function and a formatter that requires an explicit zone.
- **Logging:** JSON to stdout with a redaction layer for phones, emails, tokens and URL
  credentials, plus key-based redaction for structured fields. Request logs record the path,
  never the query string.

## Consequences

- Contributors need Node 22 + pnpm and Python 3.13 + uv (or just Docker for `make dev`).
- Next.js 16 names its middleware file `proxy.ts`; next-intl's routing lives there.
