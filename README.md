# AstroPlatform (working title)

Two-sided astrology marketplace (users ↔ vetted astrologers) fed by free, accurately computed
tools. Plan: [docs/PLAN.md](docs/PLAN.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Decisions: [docs/adr/](docs/adr/README.md).

Status: **Phase 3 (marketplace core)** complete. Phase 4 (wallet, billing, chat sessions) waits on the go-ahead.

## Quick start

Docker only:

```sh
make dev        # Postgres, Redis, API, astro engine, web; waits until healthy
open http://localhost:3000      # English
open http://localhost:3000/hi   # Hindi
make seed       # 30 demo astrologers (development only)
open http://localhost:3001      # admin (make admin-role PHONE=98xxxxxxxx first)
make down
```

Working on code (Node 22 + pnpm 10, Python 3.13 + uv):

```sh
make setup      # pnpm install + uv sync + `make data` (ephemeris files, city index); creates .env
make ci         # lint, types, unit + integration tests, build, SSR smoke (needs `make dev` running for Postgres/Redis)
make help       # every target
```

## Ground rules

- Original product: no copied text, images, brand or data from any competitor.
- Astro values come only from the engine or static tables; LLMs write prose around computed facts.
- Money is integer paise in an append-only double-entry ledger, with idempotency keys on every write.
- Secrets only in `.env` (gitignored). No chat content in analytics or logs.
