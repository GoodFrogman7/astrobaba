# AstroPlatform (working title)

Two-sided astrology marketplace (users ↔ vetted astrologers) fed by free, accurately computed
tools. Plan: [docs/PLAN.md](docs/PLAN.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Decisions: [docs/adr/](docs/adr/README.md).

Status: **Phase 0 (foundations)** complete. Phase 1 (astro engine) waits on ADR-0001.

## Quick start

Docker only:

```sh
make dev        # Postgres, Redis, API, astro engine, web; waits until healthy
open http://localhost:3000      # English
open http://localhost:3000/hi   # Hindi
make down
```

Working on code (Node 22 + pnpm 10, Python 3.13 + uv):

```sh
make setup      # pnpm install + uv sync, creates .env from .env.example
make ci         # lint, types, unit + integration tests, build, SSR smoke (needs `make dev` running for Postgres/Redis)
make help       # every target
```

## Ground rules

- Original product: no copied text, images, brand or data from any competitor.
- Astro values come only from the engine or static tables; LLMs write prose around computed facts.
- Money is integer paise in an append-only double-entry ledger, with idempotency keys on every write.
- Secrets only in `.env` (gitignored). No chat content in analytics or logs.
