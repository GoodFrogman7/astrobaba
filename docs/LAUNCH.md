# Launch runbook (Phase 8)

How to go from a working build to a public launch, and what to run once it is live. Contracts:
[docs/api/growth.md](api/growth.md). The admin console's **Launch readiness** page (`/launch`)
runs the checks below and shows what is still failing.

## 1. Gates before the site is public

- **Admin `/launch`:** no `fail` rows. Each `warn` row is understood and accepted.
- **docs/COMPLIANCE.md:** every founder and lawyer item is done:
  - legal texts approved and `LEGAL_APPROVED_VERSION` set;
  - helplines confirmed by phone and `verified_by_founder: true`;
  - Jyotish tables signed off by an astrologer;
  - AGPL review;
  - RBI, GST and TDS advice.
- **Production settings:** the API refuses to start with unsafe settings
  (`check_production_settings`: SMS, payments, `MESSAGES_KEY`, S3 for KYC, email, legal
  version, https site, LiveKit when calls are on).
- **Web:** `NEXT_PUBLIC_SITE_ENV=production` and `NEXT_PUBLIC_SITE_URL` set to the https origin.
  Any other value makes the site `noindex`, which is right for staging.
- **Load test on staging:** 500 concurrent chat sessions with no errors, p95 message round trip
  under 500 ms, and ledger invariants holding (`scripts/loadtest/README.md`).
  - Measured on the 4-CPU dev sandbox (2026-10-21; the load generator, Postgres and Redis share
    the machine), 2-minute runs:

    | Sessions | API processes | Errors | Round trip p50 / p95 | Money checks |
    |---|---|---|---|---|
    | 100 | 1 | 0 | 22 / 242 ms | pass |
    | 250 | 4 | 0 | 34 / 479 ms | pass |
    | 500 | 4 | 10 of 22,000 messages | 651 / 5,650 ms (CPU saturated) | pass |

  - Run the API with several worker processes (one per core). Each process needs a Redis
    connection per open chat socket (`REDIS_MAX_CONNECTIONS`, default 2,000). Keep
    processes × (`DB_POOL_SIZE` + `DB_MAX_OVERFLOW`) under Postgres `max_connections`.
- **Not decided yet:** the hosting setup (AWS ap-south-1 is the plan's assumption) and who
  operates it. Nothing in this repo provisions infrastructure.

## 2. Seeding astrologers (supply before demand)

The target is 30–50 real, vetted astrologers before any marketing (`data/growth/targets.json`).
Demo profiles never count and never reach production.

1. Turn on `FLAG_ASTROLOGER_INVITE_ONLY=true` during seeding, so only invited people can apply.
2. **Admin `/supply`:**
   - Create one invite per recruited astrologer. The link is shown once; send it to them yourself.
   - Watch the pipeline: applied → documents → interview → probation → approved.
3. Vet every applicant through the existing steps:
   - identity and qualification documents (KYC);
   - the recorded interview;
   - probation sessions.
   Approve only after all four steps pass.
4. Check coverage on `/supply`:
   - Hindi and English minimums.
   - Vedic practitioners.
   - Scheduled hours across the core hours (09:00–23:00 IST, every day). Fill the uncovered
     hours before launch: a client who finds nobody online is the most expensive failure.
5. Turn invite-only off when you want open applications.

## 3. Scheduled jobs (production)

| When (IST) | Command | Why |
|---|---|---|
| Always on | `python -m astro_worker jobs run` | reports, AI answers, partner leads, privacy export/deletion jobs |
| 00:30 daily | `python -m astro_worker horoscopes generate --period daily` | next day's horoscopes go to the QA queue; an editor approves them in admin |
| Monday 00:30 | `... horoscopes generate --period weekly` | weekly horoscopes for review |
| 1st, 00:30 | `... horoscopes generate --period monthly` | monthly horoscopes for review |
| 02:00 daily | `python -m astro_api.cli reconcile` | ledger vs gateway; drift shows in admin |
| hourly | `python -m astro_api.cli expire-promo` | expire promo credit lots |
| 1st, 03:00 | `python -m astro_api.cli payouts generate` | astrologer payouts for the month that ended |
| 03:30 daily | `python -m astro_api.cli analytics-purge` | delete raw analytics events older than 400 days |
| 07:00 daily | `pnpm --filter @astro/web indexnow` | tell Bing/Yandex about pages that changed today |

The daily horoscope pages publish only what an editor approved. Check `/launch` →
`horoscopes_today` each morning.

## 4. Search engines

1. **Google Search Console:**
   - Add the domain property.
   - Set `GOOGLE_SITE_VERIFICATION` (or verify by DNS).
   - Submit `https://<site>/sitemap.xml`.
   - Watch coverage for 404s and "Duplicate without user-selected canonical".
2. **Bing Webmaster Tools:** set `BING_SITE_VERIFICATION` and submit the same sitemap.
3. **IndexNow:**
   - Generate a key (32 hex characters) and set `INDEXNOW_KEY`.
   - Confirm `https://<site>/<key>.txt` returns it.
   - Schedule the daily `indexnow` command above.
4. `pnpm --filter @astro/web seo-check` runs in CI. It checks titles, canonicals, JSON-LD,
   empty pages and sitemap URLs that 404.

## 5. Content calendar

- **Admin `/content`:** plan pieces by week, from idea to drafting, review, scheduled and
  published. Record the published URL.
- "Dates to plan around" lists Purnima, Amavasya and Ekadashi (tithi at sunrise, New Delhi) and
  the Sun's sidereal sign changes for the next 60 days, computed by the engine. They are hooks
  for content, not festival observance dates.
- **Articles:** add `apps/web/src/content/{en,hi}/learn/<slug>.json`. They publish only with
  `status: "published"` and a named `reviewed_by`. The claims check (no guarantees, no cure
  claims) and the SEO check run on them in CI. Astro values in an article must come from the
  engine or `/data`, never typed from memory.

## 6. Reading the funnel

- **Admin `/growth`**, weekly, with the last 4 full weeks and a 30-day window.
- Compare each rate with the plan's assumptions (`targets.json`):
  - tool → OTP: 8–12%;
  - OTP → free session: 40%;
  - free session → first recharge: 10–15%.
- The visitor funnel misses people who opted out (GPC/DNT, or the privacy switch). The account
  funnel counts every account.
- The plan's numbers are guesses. Replace them in `targets.json` once real data exists.
