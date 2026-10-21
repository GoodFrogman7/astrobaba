# Architecture

Living document. Updated at the end of every phase (PLAN.md §0.6). Current state: **Phase 7**.

## Repo

```
apps/
  web/            Next.js 16 App Router: public site + user app (SSR, en + /hi): home, kundli,
                  kundli matching, 10 free tools, panchang (48 cities), horoscopes (36 pages),
                  directory, wallet + recharge, chat (private pages noindex)
  astrologer/     Astrologer portal (Next.js, port 3002): online toggle, incoming chat and
                  call requests, chat and voice call rooms, weekly schedule, consult
                  settings, earnings, payout statements (CSV), reviews and replies, history
  admin/          Ops console (Next.js, port 3001): astrologer KYC review and decisions,
                  review moderation, horoscope QA queue, money (refunds, free-session
                  overrides, reconciliation, wallet lookup, monthly payouts), sessions;
                  admin role required
services/
  api/            FastAPI core API: phone OTP sign-in, saved kundlis, horoscope publishing,
                  marketplace (applications, KYC documents, directory, profiles, reviews,
                  presence), wallet + ledger + Razorpay, chat sessions (REST + WebSocket,
                  per-minute meter), refunds, reconciliation, admin endpoints
    migrations/   Alembic: 0001 baseline, 0002 users/sessions/kundlis/horoscopes/audit_log,
                  0003 roles/astrologers/verifications/kyc_documents/consult_sessions/reviews,
                  0004 ledger/balances/promo lots/orders/payment events/free-session claims/
                  reconciliation, 0005 session lifecycle + encrypted chat_messages,
                  0006 astrologer_availability + payouts, 0007 end reason service_unavailable
  astro/          FastAPI astro engine (AGPL-3.0-only, ADR-0001): kundli, panchang, dasha,
                  doshas, matching, transits, city search
  worker/         CLI jobs: horoscope generation (facts → LLM → validator → review queue) and
                  review; queue library chosen when jobs need scheduling
packages/
  shared/         TS: brand, locales, disclaimer, IST date source, design tokens, feature
                  flags, analytics schema, chat and portal shapes. JSON parts are read by Python.
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

## Wallet, billing and chat (Phase 4)

Contract: [docs/api/billing.md](api/billing.md). Decisions: [ADR-0002](adr/0002-ledger-design.md)
(ledger) and [ADR-0007](adr/0007-sessions-and-metering.md) (sessions, meter, chat transport).
Money settings: `data/marketplace/billing.json`.

```
recharge:  web /wallet ── order (Idempotency-Key) ──> API ──> Razorpay Orders
           Razorpay ── signed webhook ──> API: event stored once ──> ledger credit (+ bonus lot)
chat:      web profile ── POST /v1/sessions ──> queued | requested ──(console accept)──> accepted
           both sockets (ticket, Origin check) ──> active: minute n prepaid by the meter
           ws message ──> encrypted row (AES-GCM) ──> Redis pub/sub ──> other side
end:       end | funds out | free minutes used | side gone > grace ──> completed
           ──> close session promo lot, refund rules, presence, queue promotion
nightly:   cli reconcile (ledger balanced, projections = entries, payments = credits,
           settlements) ── drift ──> error log + admin page;  cli expire-promo hourly
```

- Double-entry ledger, integer paise, append-only (database triggers), every write keyed
  (`session:{id}:minute:{n}`, `razorpay:payment:{id}:captured`, `refund:{rule}:{session}`).
  Balance rows lock in a fixed order; `CHECK (balance >= 0)` makes overdraft impossible.
- Promo credit first, earliest expiry first (founder decision, ADR-0002); the free first
  session is a promo lot restricted to that one session.
- The meter runs in every API process (`FOR UPDATE SKIP LOCKED`); minutes are prepaid, so a
  crash never gives a minute away and the key makes a double charge impossible. An outage
  longer than the heartbeat grace ends the session at last-seen with nothing charged for it.
- Development uses the fake gateway (`PAYMENTS_PROVIDER=fake`, simulate button) and a chat
  key derived from `SECRET_KEY`; production refuses both (`check_production_settings`).

## Voice calls, portal and payouts (Phase 5)

Contract: [docs/api/portal.md](api/portal.md). Decision: [ADR-0008](adr/0008-voice-calls.md).

```
call:      profile Call ── POST /v1/sessions {kind: call} ── accept ── both control sockets
           + POST …/call-token ──> LiveKit room session-{id} (identity = role, mic only)
           LiveKit ── signed webhooks (joined/left) ──> API; both joined ──> active
           meter, each minute: LiveKit list_participants confirms both ──> charge
                                missing side ──> left (grace) │ LiveKit down ──> no charge,
                                ends service_unavailable after grace
           any end ──> API deletes the room (both sides cut off at once)
portal:    schedule (IST slots, shown on the profile) · consult toggles · earnings from the
           ledger · reviews + reply · payout statements (CSV, formula-safe)
payouts:   cli payouts generate (1st of month, previous IST month) ──> draft per astrologer
           admin approve ──> mark paid (UTR) ──> ledger payout:{id} (payable → bank:payouts)
           net < ₹500 carried forward; reconciliation checks every paid payout is posted once
```

- Calls use the same session state machine, prepaid meter, refunds and reviews as chat; only
  activation and presence differ. Nothing is recorded.
- The browser apps ask for the microphone before joining, and leave the room on `ended`.
  Permissions-Policy allows `microphone=(self)` on web and the astrologer portal only.
- Development runs LiveKit in docker-compose (`livekit`, dev keys, rooms created only by the
  API); production needs its own LiveKit (cloud or self-hosted), keys and a `wss://` URL.

## Reports, AI assistant and remedies (Phase 6)

Contract: [docs/api/revenue.md](api/revenue.md). Decisions: [ADR-0009](adr/0009-reports-and-jobs.md)
(reports, job queue), [ADR-0010](adr/0010-ai-assistant.md) (AI assistant). Prices:
`data/marketplace/products.json`; catalogue: `data/marketplace/remedies.json`.

```
buy:      /reports ── order (wallet: charge_purchase | card: Razorpay webhook) ── engine snapshot
          (taken at order time) ── report row + job report_render, one transaction
render:   worker claims job (SKIP LOCKED) ── Chromium prints web /print/reports/{id}?sig= (A4,
          en/hi, engine data only) ── PDF to documents storage ── ready ── report_email job
          final failure ── refund once (wallet buckets; card → wallet credit)
download: /account/reports ── signed 10-minute link ── API streams the PDF (no-store)
ai:       /ai (flag ai_assistant) ── safety check (self-harm/medical/legal/financial → blocked,
          free) ── charge ── job ai_answer: facts from the engine ── LLM ── validator ──
          answered | blocked + refund; encrypted at rest; labelled AI
remedies: /remedies ── consented lead (note encrypted, phone masked) ── job ── partner email
```

- Jobs: `astro_api.jobs` + `python -m astro_worker jobs run` (compose service `worker`); payloads
  hold ids only; handlers are idempotent; `on_failed` runs once after the last attempt.
- Reconciliation matches every gateway payment to its clearing posting (recharges and card-paid
  reports).
- HTTP client request lines are never logged and the engine runs without an access log (birth
  details travel in engine query strings).

### Web app

Contract: [docs/api/revenue.md](api/revenue.md). Code: `apps/web/src/{app/[locale]/{reports,
account/reports,ai,remedies},app/api/{reports,ai,remedies},components/revenue,lib/revenue}`.

```
/reports (static, ISR 10 min, indexable, sitemap): prices from GET /v1/reports/products at
         build/revalidate (none shown if unreachable), section list, sample via
         /api/reports/sample (server fetches the API link, streams the PDF), Product+Offer
         JSON-LD only with an API price. "Buy" opens a client dialog: saved kundli(s) (1 or 2
         per sku, data/marketplace/products.json `kundlis`), language, optional email,
         wallet (402 → /wallet?amount=shortfall) or Razorpay (Checkout or dev simulate, then
         poll GET /api/reports/orders/{id}); one Idempotency-Key per intent.
/account/reports (private): polls GET /api/reports while queued/rendering (3→15 s, 15 min);
         download = /api/reports/{id}/file: fresh signed link from the API each click, path
         pinned to API_URL/v1/reports/{id}/file, streamed with `private, no-store`.
/ai      (private, dynamic): 404 unless flag ai_assistant; AI_LABEL on the page and on every
         answer, text badge (no avatar), hand-off to /astrologers, price per question from
         products.json `ai_question` (no endpoint exposes it), polls while queued.
/remedies (static, ISR, noindex, not in the sitemap): only what GET /v1/remedies returns;
         partner request dialog, consent unticked and required (route handler rejects
         anything but `consent: true`).
```

- Every write route handler requires an `Idempotency-Key` (400 otherwise) and forwards only
  contract fields through the existing BFF forwarder; `/api/ai/*` answer 404 while the flag is
  off. PDFs never come from another origin: download links are reduced to a `/v1/reports/…`
  path on `API_URL` before fetching.
- `/remedies` stays noindex until the catalogue passes editorial review and the Phase 7 legal
  review of remedy advertising (`REMEDIES_INDEXABLE` in `lib/revenue/config.ts` also adds it to
  the sitemap). Links to `/ai` (footer, /reports) are evaluated when those static pages render,
  the page itself per request, so flip the flag together with a rebuild/revalidation.
- Wallet history labels `purchase` rows "Report"/"AI question" when the row carries
  `product`, else "Purchase".

## Trust, safety and compliance (Phase 7)

Contract: [docs/api/trust.md](api/trust.md). Decisions: [ADR-0011](adr/0011-privacy-export-deletion.md)
(consents, export, deletion), [ADR-0012](adr/0012-chat-safety-and-moderation.md) (chat safety,
moderation). Data: `data/legal/policies.json`, `data/safety/{helplines,conduct}.json`.

```
consent:  sign-in ── consent step (18+, terms, privacy; astrologers + conduct terms) ── append-only
          consents (version, hashed ip/device) ── require_consent on every money/consult write
data:     /account ── export job (JSON, signed link, 7 days) │ deletion request ── admin executes:
          anonymise in one transaction (phone tombstone, personal data deleted, ledger kept)
          ── account_cleanup job removes files
safety:   every chat message ── astro_api.safety ── client self-harm: deliver, flag session,
          crisis panel both sides, no upsell │ astrologer contact/claims: refused, queued
moderate: reports + safety + refused ── admin queue (reveal one message, audited) ── dismiss |
          warn (strike shown to the astrologer) | suspend
launch:   production refuses to start until LEGAL_APPROVED_VERSION == policies.json version;
          CI fails on banned marketing claims (scripts/claims-check.mjs) and on safety evals
```

## Cross-cutting rules in code

| Rule (PLAN.md) | Where it lives |
|---|---|
| One IST date source; never format in the browser's zone (§5 P2, §8) | `packages/shared/src/time.ts` |
| Disclaimer on every page (§5 P2, §6) | `packages/shared/src/disclaimer.ts`, rendered in the web layout footer |
| AI always labelled (§6) | `AI_LABEL` in `packages/shared/src/disclaimer.ts` |
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
| No money movement without a ledger entry and an idempotency key (§6) | `astro_api.wallet` is the only writer; unique keys; append-only triggers; reconciliation |
| No chat content in logs or analytics (§6) | `packages/shared/analytics/events.json`: closed property types, no free text; validators in TS and Python share `cases.json`. Messages stored encrypted; system messages carry codes; admin session list has no content |
| Crisis language never blocked; no selling to a flagged session (§5 P7) | `astro_api.safety`, `safety_events`, `evals/safety` |
| No legal launch without reviewed texts (§5 P7) | `check_production_settings`: `LEGAL_APPROVED_VERSION` |
| No banned marketing claims in copy (§5 P7) | `scripts/claims-check.mjs` in CI |
| No billing for audio that is not flowing (§5 P5) | meter confirms LiveKit presence before each call minute; LiveKit down → no charge, `service_unavailable` |
| Never a negative balance (§5 P4) | prepaid minutes + row locks + `CHECK (balance >= 0)`; 100-way concurrency test |
| Own design system (§0.1) | `packages/shared/src/tokens.ts` + `tokens/tokens.css`, AA contrast tested |

## Checks

`make ci` = lint (ESLint, Prettier, Ruff) → types (tsc, mypy strict) → `make data` → unit and
property tests (Vitest, pytest + Hypothesis) → golden astro fixtures → integration tests
(Postgres + Redis, migrations up/down/up) → web production build → SSR smoke test of `/` and
`/hi`. GitHub Actions runs the same, plus a Docker build of every image and a repo-hygiene job
(no `.env` files or live keys committed).

## Decisions

See [adr/](adr/README.md).
