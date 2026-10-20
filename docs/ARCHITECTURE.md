# Architecture

Living document. Updated at the end of every phase (PLAN.md §0.6). Current state: **Phase 0**.

## Repo

```
apps/
  web/            Next.js 16 App Router: public site + user app (SSR, en + /hi)
  astrologer/     Astrologer portal (Phase 5), placeholder
  admin/          Ops console (Phase 3), placeholder
services/
  api/            FastAPI core API: health, flags; auth/marketplace/wallet/sessions later
    migrations/   Alembic (baseline: citext, pg_trgm)
  astro/          FastAPI astro engine: skeleton; calculations in Phase 1
  worker/         Background jobs entry point (queue chosen with the first job)
packages/
  shared/         TS: brand, locales, disclaimer, IST date source, design tokens,
                  feature flags, analytics schema. JSON parts are read by Python too.
data/             Static tables and import scripts (Phase 1+)
docs/             PLAN, ARCHITECTURE, COMPLIANCE, adr/, reference/
evals/
  astro/          Golden fixtures (proposal; Phase 1 fills and enforces)
  safety/         Chat safety fixtures (Phase 7)
.github/workflows/ci.yml
docker-compose.yml, Makefile, pyproject.toml (uv workspace), pnpm-workspace.yaml
```

## Runtime (dev)

```
browser ──> web :3000 (Next.js SSR) ──> api :8000 (FastAPI) ──> Postgres 16 :5432
                                    └─> astro :8001 (FastAPI)   Redis 7 :6379
```

- `make dev` builds and starts all five containers and waits for health checks.
- API: `/healthz` (process up), `/readyz` (Postgres + Redis reachable, 503 otherwise),
  `/v1/flags`. Migrations run on container start in dev; a release step in production.
- Astro engine: `/healthz`, `/v1/meta`. No calculations until Phase 1.

## Cross-cutting rules in code

| Rule (PLAN.md) | Where it lives |
|---|---|
| One IST date source; never format in the browser's zone (§5 P2, §8) | `packages/shared/src/time.ts` |
| Disclaimer on every page (§5 P2, §6) | `packages/shared/src/disclaimer.ts`, rendered in the web layout footer |
| AI always labelled (§6) | `AI_LABEL` in `packages/shared/src/disclaimer.ts` |
| No chat content in analytics (§6) | `packages/shared/analytics/events.json`: closed property types, no free text; validators in TS and Python share `cases.json` |
| Secrets only in `.env`; redact PII in logs (§0.5) | `.gitignore`, `SecretStr` settings, `services/api/src/astro_api/logs.py`, CI hygiene job |
| Feature flags | `packages/shared/flags/flags.json` + `FLAG_<NAME>` env; `/v1/flags` |
| Own design system (§0.1) | `packages/shared/src/tokens.ts` + `tokens/tokens.css`, AA contrast tested |

## Checks

`make ci` = lint (ESLint, Prettier, Ruff) → types (tsc, mypy strict) → unit tests (Vitest,
pytest) → integration tests (Postgres + Redis, migrations up/down/up) → web production build →
SSR smoke test of `/` and `/hi`. GitHub Actions runs the same, plus a Docker build of every
image and a repo-hygiene job (no `.env` files or live keys committed).

## Decisions

See [adr/](adr/README.md).
