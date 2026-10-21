# AstroPlatform (working title)

Two-sided astrology marketplace (users ↔ vetted astrologers) fed by free, accurately computed
tools. Plan: [docs/PLAN.md](docs/PLAN.md). Architecture and current phase:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Decisions: [docs/adr/](docs/adr/README.md).

## Quick start

Docker only:

```sh
make dev        # whole stack (Postgres, Redis, API, engine, LiveKit, web, admin, astrologer)
open http://localhost:3000      # English
open http://localhost:3000/hi   # Hindi
make seed       # 30 demo astrologers (development only)
open http://localhost:3001      # admin (make admin-role PHONE=98xxxxxxxx first)
open http://localhost:3002      # astrologer portal
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
