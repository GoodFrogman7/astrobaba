# Architecture

Living document. Updated at the end of every phase (PLAN.md §0.6). Current state: **Phase 3**.

## Repo

```
apps/
  web/            Next.js 16 App Router: public site + user app (SSR, en + /hi): home, kundli,
                  kundli matching, 10 free tools, panchang (48 cities), horoscopes (36 pages)
  astrologer/     Astrologer portal (Phase 5), placeholder
  admin/          Ops console (Next.js, port 3001): astrologer KYC review and decisions,
                  review moderation, horoscope QA queue; admin role required
services/
  api/            FastAPI core API: phone OTP sign-in, saved kundlis, horoscope publishing,
                  marketplace (applications, KYC documents, directory, profiles, reviews,
                  presence), admin endpoints; wallet and sessions in Phase 4
    migrations/   Alembic: 0001 baseline, 0002 users/sessions/kundlis/horoscopes/audit_log,
                  0003 roles/astrologers/verifications/kyc_documents/consult_sessions/reviews
  astro/          FastAPI astro engine (AGPL-3.0-only, ADR-0001): kundli, panchang, dasha,
                  doshas, matching, transits, city search
  worker/         CLI jobs: horoscope generation (facts → LLM → validator → review queue) and
                  review; queue library chosen when jobs need scheduling
packages/
  shared/         TS: brand, locales, disclaimer, IST date source, design tokens,
                  feature flags, analytics schema. JSON parts are read by Python too.
data/
  astro/          Jyotish tables (names en/hi, lords, panchang lists, dasha, dosha rules,
                  Ashtakoota); each cites its source, some await astrologer review
  fetch_ephemeris.py, import_cities.py   `make data`: Swiss Ephemeris files, GeoNames index
docs/             PLAN, ARCHITECTURE, COMPLIANCE, adr/, reference/
evals/
  astro/          Golden fixtures (inputs), reference/ (JPL Horizons + USNO raw data with
                  provenance), test_golden.py (hard gate in CI)
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
- Astro engine (stateless, no database):

  | Endpoint | What |
  |---|---|
  | `POST /v1/kundli` | Sidereal grahas, lagna, whole-sign houses; unknown-time handling |
  | `POST /v1/dasha` | Vimshottari mahadashas + antardashas, current period |
  | `POST /v1/doshas` | Mangal, Kaal Sarp, Sade Sati (blocked in production until tables are reviewed) |
  | `POST /v1/match` | Ashtakoota /36, per-koota detail, nadi/bhakoot dosha, both Mangal doshas (same gate) |
  | `GET /v1/panchang?lat&lon&tz&date` | Sunrise/sunset, tithi, nakshatra, yoga, karana spans, Rahu Kaal |
  | `GET /v1/transits?at` | Positions at an instant, optional houses from natal Moon |
  | `GET /v1/cities?q` | Place search (Latin + Devanagari), returns lat/lon/IANA tz; GeoNames attribution |
  | `GET /v1/meta`, `/v1/source` | Engine, conventions, table review status, AGPL source link |

  Birth details travel in POST bodies, never in URLs. Every response carries a `settings` block
  (engine, version, ayanamsha, node, house system) and instants as UTC plus the IANA zone.
  Conventions: [ADR-0004](adr/0004-astro-conventions.md).

### Astro engine internals

```
main.py (routes) ─> kundli / panchang / dasha / doshas / matching / transits
                         │                       │
                         ▼                       ▼
              ephemeris.EphemerisBackend    tables (data/astro/*.json)
                 └─ SwissEphemeris (pyswisseph, per-thread state, Moshier fallback refused)
```

Transition times (tithi, nakshatra, yoga, karana ends) are solved by Newton iteration on the
angle and its rate from the ephemeris, to well under a second.

## Web (Phase 2)

| Path | Rendering | Data |
|---|---|---|
| `/`, `/tools`, `/tools/<slug>`, `/kundli`, `/kundli-matching` | Static shell; results via Server Actions calling the engine server-to-server | Birth details only in POST bodies, never URLs or logs |
| `/panchang`, `/panchang/<city>`, `/panchang/<city>/tomorrow` | Dynamic, cached per IST date (rolls over at 00:00 IST) | `/v1/panchang` |
| `/panchang/<city>/<YYYY-MM-DD>` | Dynamic, canonical to itself, not in sitemap | `/v1/panchang` |
| `/horoscope`, `/horoscope/<daily\|weekly\|monthly>/<sign>` | Dynamic, cached per IST date | `/v1/horoscope/facts` + published prose from the API (ADR-0005) |
| `/api/cities`, `/api/auth/*`, `/api/kundlis` | Route handlers proxying engine/API; session in an httpOnly cookie | |

Every indexable page uses `PageShell` (breadcrumbs, FAQs, BreadcrumbList/FAQPage JSON-LD,
consultation CTA) with copy from `src/content/{en,hi}/<page>.json`. The layout adds
Organization JSON-LD and the disclaimer. `sitemap.xml` comes from `src/lib/routes`.

Acceptance checks (CI `e2e` job): `scripts/seo-check.mjs` crawls every sitemap URL (status,
canonical, hreflang, JSON-LD, ≥ 800 characters of body text, one IST date across title,
description and body, Hindi in Devanagari); `scripts/lighthouse.mjs` requires ≥ 90 in every
category on mobile for representative pages.

## Marketplace (Phase 3)

Contract: [docs/api/marketplace.md](api/marketplace.md). Decisions: [ADR-0006](adr/0006-marketplace-trust.md).

```
applicant ── /astrologers/apply (web) ──> API: application, KYC upload (random keys, local|s3)
admin ── apps/admin ──> API admin: verify identity → qualification → interview → approve
                                    (tier + price) → probation (public) → approved
user ── /astrologers (filters, sort, presence) ── /astrologers/<slug> (Person JSON-LD, reviews)
```

Taxonomy (skills, languages, tiers with price bounds) is `data/marketplace/taxonomy.json`,
shared by API, web and admin. Presence lives in Redis (`presence:{id}`, TTL heartbeat).
`make seed` loads 30 labelled demo astrologers (development only).

## Cross-cutting rules in code

| Rule (PLAN.md) | Where it lives |
|---|---|
| One IST date source; never format in the browser's zone (§5 P2, §8) | `packages/shared/src/time.ts` |
| Disclaimer on every page (§5 P2, §6) | `packages/shared/src/disclaimer.ts`, rendered in the web layout footer |
| AI always labelled (§6) | `AI_LABEL` in `packages/shared/src/disclaimer.ts` |
| No chat content in analytics (§6) | `packages/shared/analytics/events.json`: closed property types, no free text; validators in TS and Python share `cases.json` |
| Secrets only in `.env`; redact PII in logs (§0.5) | `.gitignore`, `SecretStr` settings, `services/api/src/astro_api/logs.py`, CI hygiene job |
| Feature flags | `packages/shared/flags/flags.json` + `FLAG_<NAME>` env; `/v1/flags` |
| Astro values only from the engine or static tables (§0.4, §6) | `services/astro`; `data/astro/*.json` with sources; golden fixtures from JPL/USNO |
| AGPL boundary (ADR-0001) | Only `services/astro` imports `swisseph` (test enforced); `/v1/source` |
| No unreviewed LLM text on horoscope pages (§6) | `horoscope_entries.status`; public API returns `published` only; pages fall back to template sentences from facts |
| Phone numbers and OTPs never stored or logged in clear | OTP stored as HMAC in Redis; phones masked in logs; session token stored as SHA-256 |
| Unapproved astrologers invisible everywhere (§5 P3) | one visibility helper in `astro_api.marketplace`; tests per status incl. sitemap |
| Seed data never in production (§5 P3) | seed refuses outside development/test; `is_seed` rows hidden in production |
| No fake online counts or scarcity (§6) | presence and wait time only from Redis state; empty directory says so |
| Unreviewed Jyotish tables never public | `/v1/match`, `/v1/doshas` return 503 `tables_not_reviewed` in staging/production |
| Own design system (§0.1) | `packages/shared/src/tokens.ts` + `tokens/tokens.css`, AA contrast tested |

## Checks

`make ci` = lint (ESLint, Prettier, Ruff) → types (tsc, mypy strict) → `make data` → unit and
property tests (Vitest, pytest + Hypothesis) → golden astro fixtures → integration tests (Postgres + Redis, migrations up/down/up) → web production build →
SSR smoke test of `/` and `/hi`. GitHub Actions runs the same, plus a Docker build of every
image and a repo-hygiene job (no `.env` files or live keys committed).

## Decisions

See [adr/](adr/README.md).
