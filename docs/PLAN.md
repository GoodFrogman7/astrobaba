# AstroPlatform: Claude Code Build Plan (working title)

> Put this file at `/docs/PLAN.md`. Put the Astrotalk teardown at `/docs/reference/astrotalk-teardown.md`.
> Do NOT load the whole teardown into context. Read only the sections a phase points to.

---

## 0. Ground rules for Claude Code

1. **Build original, not a clone.** The teardown is for *structure and mechanics only*. Do not copy Astrotalk's text, images, brand, UI trade dress, astrologer data, or reviews. Use a new name, new design system, new copy.
2. **One phase at a time.** Finish a phase, run the tests, show me proof (output, screenshots, test report), then stop and wait.
3. **Money code is test-first.** Wallet, billing and refunds get tests before implementation.
4. **Never invent astrology data.** Planetary positions, tithi, nakshatra, dasha etc. come from the ephemeris engine, never from an LLM. LLMs only write prose around computed facts.
5. **Secrets only in `.env`**, never committed. Redact PII and secrets in logs.
6. After each phase, update `/docs/ARCHITECTURE.md` and add an ADR to `/docs/adr/` for any non-obvious decision.

---

## 1. Product strategy (read before coding)

**What this is:** a two-sided marketplace (users ↔ astrologers) fed by a free-tools SEO funnel. Free tools capture intent, paid per-minute consultation and paid reports monetize it. (Teardown §1, §6.6, §14.)

**Honest constraint:** Astrotalk's moat is supply (thousands of astrologers), brand and ad spend. A solo builder will not beat them head-on. So:

- **Wedge:** pick ONE niche to launch (suggested: Hindi + English, kundli-matching and career/marriage guidance, or a regional language Astrotalk serves weakly). Launch with 30–50 vetted astrologers, not 50,000.
- **Revenue order (fastest first):**
  1. Paid kundli / matching PDF reports (one-time, no supply needed, near-100% margin)
  2. Per-minute chat consultations (marketplace take rate)
  3. Calls, pujas/remedies via partners, AI-assistant tier
- **Cold-start plan:** SEO tools bring users; a clearly-labelled **AI assistant** (cheap, instant) handles first questions and routes to humans for depth. Never present AI as a human astrologer.

**Assumptions (change if wrong):** India-first, INR, English + Hindi at launch, solo/small team, hosted in AWS ap-south-1, 18+ only.

---

## 2. Stack and key decisions

| Area | Choice | Notes |
|---|---|---|
| Web | Next.js App Router + TypeScript + Tailwind | SSR/ISR for SEO; `next-intl` with `/hi` prefix (teardown §2.2, §3.6) |
| API | FastAPI (Python) | Core API + WebSocket chat |
| Astro engine | Separate FastAPI service `/services/astro` | Swiss Ephemeris wrapper (see licence note) |
| DB | Postgres 16 | Money in integer paise; double-entry ledger |
| Cache / realtime | Redis | Presence, chat pub/sub, rate limits, locks |
| Voice (phase 5) | LiveKit in-app VoIP | Avoids PSTN/DND/masking complexity at launch |
| Auth | Phone OTP (+ Google) | Device ID captured for abuse control |
| Payments | Razorpay (India) first; Stripe later for international | Webhook-driven, idempotent |
| PDFs | Playwright or WeasyPrint | Kundli reports |
| LLM | Provider abstraction (Gemini default, Claude swappable) | Prose only, grounded on computed data |
| Hosting | AWS ap-south-1 | Data residency, low latency |

**ADRs to write:** (1) ephemeris licensing, (2) ledger design, (3) chat transport, (4) in-app VoIP vs masked PSTN, (5) horoscope generation pipeline.

> **Licence warning (ADR-1):** Swiss Ephemeris is dual-licensed (AGPL or paid commercial licence). Closed-source SaaS needs the commercial licence. Check current terms and price at astro.com before building on it. Fallback: Skyfield/JPL data with your own sidereal (Lahiri) offset, accepting more work to validate.

---

## 3. Repo layout

```
/apps/web                 Next.js (public site, user app)
/apps/astrologer          Next.js (astrologer portal)
/apps/admin               Next.js (ops: KYC, refunds, content QA)
/services/api             FastAPI: auth, marketplace, wallet, sessions, orders
/services/astro           FastAPI: kundli, panchang, dasha, doshas, matching, transits
/services/worker          Jobs: daily horoscopes, PDF reports, reconciliation, payouts
/packages/shared          Types, disclaimer constants, design tokens
/data                     Static tables (compatibility pairs, tarot, muhurat); geo import scripts
/docs                     PLAN.md, ARCHITECTURE.md, COMPLIANCE.md, adr/, reference/
/evals                    Golden astro fixtures, chat safety tests
```

---

## 4. Core data model (sketch)

- `users` (phone, name, locale, currency, device_ids[], is_adult_confirmed)
- `saved_kundlis` (user_id, name, gender, birth_datetime_utc, place_id, tz, unknown_time)
- `cities` (id, name, state, country, lat, lon, tz, popularity, alt_names): GeoNames-style, powers every place field (teardown §2.4)
- `astrologers` (user_id, display_name, slug, bio, skills[], languages[], tier{rising,top_choice,celebrity}, price_per_min_paise, status{pending,approved,suspended}, experience_years, kyc_status)
- `astrologer_availability` (astrologer_id, weekday, start, end) + live presence in Redis
- `sessions` (user_id, astrologer_id, type{chat,call}, started_at, ended_at, billed_seconds, price_per_min_paise, is_free_trial, end_reason)
- `messages` (session_id, sender, body_encrypted, created_at)
- `ledger_entries` (id, account, direction, amount_paise, kind{real,promo}, expires_at, ref_type, ref_id, idempotency_key): **append-only, double-entry**
- `wallets` (derived balances; never the source of truth)
- `orders` (type{report,recharge,remedy}, status, razorpay ids), `reviews` (session_id UNIQUE, rating, text, astrologer_reply)
- `horoscope_entries` (period, scope, sign, ist_date, sections jsonb, scores jsonb, lucky jsonb, reviewed_by, status)
- `payouts` (astrologer_id, period, gross, commission, net, status)
- `consents`, `audit_log`, `reports` (user reports on astrologers/messages)

---

## 5. Phases

### Phase 0: Foundations (1–2 days)
Monorepo, `docker-compose` (Postgres, Redis), CI (lint, types, tests), env handling, design tokens (light/dark, own palette), i18n scaffold (`en`, `hi`), analytics event schema (events only, no chat content), feature flags.
**Done when:** `make dev` boots everything; CI is green; one SSR page renders in both locales.

### Phase 1: Astro engine (≈1 week). Teardown §2.4, §8, §9, §10
Build `/services/astro`:
- City import (GeoNames cities, CC-BY, add attribution) + autocomplete endpoint returning lat/lon/tz with the pick.
- Endpoints: `/kundli`, `/panchang` (lat, lon, tz, date), `/dasha` (Vimshottari), `/doshas` (Mangal, Kaal Sarp, Sade Sati), `/match` (Ashtakoota /36 with the 8 kootas), `/transits`.
- Configurable ayanamsha (default Lahiri). House system documented in an ADR.
- SVG chart components for North and South Indian styles.
- Always return times in UTC plus IANA tz; format at the edge, **never in the browser's timezone** (teardown §10.1 bug).

**Acceptance (hard gate):**
- Golden fixtures: ≥10 public-domain birth charts and ≥30 dates of published almanac data (tithi, nakshatra, sunrise/sunset, Rahu Kaal).
- Planet longitudes within 1 arc-minute of reference; tithi/nakshatra transition times within ±2 minutes; sunrise/sunset within ±1 minute.
- Unknown birth time handled (no ascendant/houses; clear flag).
- Property tests: Ashtakoota total = sum of 8 kootas ≤ 36; Rahu Kaal slot matches weekday table.

### Phase 2: Free-tools SEO funnel (≈2 weeks). Teardown §3, §7–§10, §14
- **Config-driven calculator template** + 4 reusable forms (birth details, two names, numerology, DOB+number) (teardown §9.2). Launch 10 tools: birth chart, sun/moon/ascendant, nakshatra, dasha, Mangal dosha, Sade Sati, Kaal Sarp, mulank/destiny/name numerology.
- **Kundli** form → result page; **Matchmaking** form → result page (the result pages were never seen in the teardown, so design them yourself: summary, per-koota table, doshas, remedies, CTA).
- **Panchang:** today/tomorrow/city, rahu kaal, choghadiya, hora. **Put city and date in the URL** (improvement over Astrotalk).
- **Horoscopes:** 12 signs × daily/weekly/monthly + 4 life areas. Pipeline: compute Moon sign/nakshatra/transits → feed facts to the LLM → generate prose → human QA queue → publish. Scores use a fixed 5-step scale derived from rules, not random.
- Templates: SSR/ISR, `revalidate` at 00:00 IST, JSON-LD (Organization, FAQPage, BreadcrumbList), sitemaps, canonical tags, 4–6 FAQs per page, Hindi mirrors.
- Funnel: every tool ends with expert cards + CTA; optional OTP to "save my kundli".
- Disclaimer on every page: "For guidance and entertainment. Not medical, legal or financial advice."

**Acceptance:** Lighthouse ≥ 90 mobile; **one IST date source** across title/meta/body; build fails if any page body < 800 characters (avoids Astrotalk's empty nakshatra pages); no 404s in the generated sitemap; Hindi pages render fully.

### Phase 3: Marketplace core (≈1–2 weeks). Teardown §6.1–6.4
- Astrologer application → KYC document upload → admin review → approved (teardown §6.4 verification steps: identity, qualification proof, panel interview, probation).
- Profile page `/astrologers/{slug}` (SSR, Person JSON-LD, sticky consult card, reviews).
- Directory with **server-side filters**: sort, skills, language, gender, tier, price; category chips; load-more; online/busy/offline presence; wait-time estimate.
- Reviews only after a completed session (one per session); astrologer replies; moderation tools.
- Admin panel: approve/suspend, review moderation, feature flags per astrologer.
- Seed 30 clearly-labelled fake astrologers for local/dev only. **Never ship seed data to production.**

**Acceptance:** filter + sort combinations covered by tests; profile and directory pass Lighthouse ≥ 90; unapproved astrologers are invisible everywhere.

### Phase 4: Wallet, billing and chat sessions (≈2 weeks). Teardown §6.5, §6.6, §13
**Wallet**
- Double-entry ledger, integer paise, append-only, idempotency keys on every write.
- Two balance kinds: **real** (long expiry) and **promo** (short expiry, no cash value). Spend promo first only if policy says so; document it.
- Razorpay Orders for recharge; signature-verified, idempotent webhooks; recharge bonus tiers configurable (feature flag).

**Sessions**
- User requests → astrologer accepts/declines → wait queue with ETA.
- WebSocket chat via FastAPI + Redis pub/sub; messages encrypted at rest.
- **Server-side per-minute metering** with row-level locking; warn at 1 minute left; auto-end at zero; never allow a negative balance.
- **First free session:** once per user, capped at N minutes (config), keyed on phone + device ID + basic IP heuristics, with an abuse score and admin override.
- Refund rules engine: failed connect, astrologer drop, low rating within window. Rules in config, every refund audited.
- Reconciliation job: ledger vs Razorpay settlements, daily; alert on mismatch.

**Acceptance (hard gate):**
- Concurrency tests: 100 parallel debits never overdraw or double-spend.
- Webhook replay test: same event 5× → one credit.
- Kill the API mid-session → billing resumes correctly, no free or double minutes.
- Reconciliation report shows zero drift on test data.

### Phase 5: Voice calls + astrologer portal (≈2 weeks)
- LiveKit in-app voice calls billed through the same metering engine. PSTN/masked-number calling is a later project.
- Astrologer portal: availability schedule, accept/decline, session history, earnings dashboard, payout statements, review replies (teardown §6.4, §16.8).
- Payouts: monthly statement generation (commission configurable per tier); actual bank transfers manual in v1.

### Phase 6: Extra revenue (≈1–2 weeks)
- **Paid kundli/matching PDF report** (50+ pages in the teardown; start with 15–20 quality pages): one-time purchase via Razorpay Orders, generated by the worker, emailed + downloadable. Sample report free.
- **AI assistant tier:** clearly labelled "AI" everywhere; grounded on the user's computed kundli data; cheap per-minute or per-question; hands off to human astrologers; same safety rules as humans.
- Remedies/pujas: catalogue + lead capture routed to a partner (no inventory, no gemstone claims). Skip the store (teardown §12) until the core earns.

### Phase 7: Trust, safety and compliance (gate for public launch)
- 18+ gate; consent flow; privacy notice listing processors; grievance contact; refund and credit-expiry policy pages; DPDP-aligned deletion/export endpoints.
- **Safety in chat:** detect self-harm language (humans and AI) → pause upsell, show crisis resources (verify current helplines, e.g. Tele-MANAS 14416) and a "not a helpline" notice (teardown §13).
- Policy: no fear-based selling; no claims of curing disease or guaranteed outcomes; no medical, legal or financial advice; astrologers can be reported and suspended; banned-topic list enforced by moderation tooling.
- Advertising claims must be substantiated. Get a lawyer to review the copy against consumer-protection law, the Drugs and Magic Remedies (Objectionable Advertisements) Act, and ASCI guidance **before launch**.
- Wallet: confirm with a CA/lawyer that a closed-loop wallet for your own services doesn't trigger RBI prepaid-instrument authorization, and confirm GST treatment of commission vs. gross consultation fees.

### Phase 8: Launch and growth
- Seed 30–50 real vetted astrologers (supply before demand).
- Publish the 10 tools + horoscopes + panchang; submit sitemaps; start the content calendar.
- Funnel dashboard: visit → tool use → OTP → free session → first recharge → repeat.
- Targets to validate (assumptions, not facts): tool→OTP 8–12%, OTP→free session 40%, free session→paid recharge 10–15%.

---

## 6. Guardrails (non-negotiable)

- No astro value shown that wasn't computed by the engine or a static data table.
- No LLM output published to the horoscope pages without the QA queue.
- No money movement without a ledger entry and an idempotency key.
- No chat content in analytics, logs or training data. Use paid no-training LLM tiers only.
- No dark patterns: no fake "N people online", no fake scarcity timers, no fake "AI = human". The teardown's ticker and countdowns are patterns to **avoid**, not copy.
- Every AI answer is labelled, and every consultation page carries the entertainment disclaimer.

---

## 7. Test and QA strategy

- `/evals/astro`: golden-chart fixtures run in CI; regressions block merges.
- Money: property-based tests on the ledger (sum of entries = 0 per transaction), concurrency and replay tests.
- Safety: fixture set of self-harm, medical, legal and scam prompts; assert the right banner/handoff.
- SEO: crawler test checks titles, canonicals, JSON-LD validity, no empty pages, no sitemap 404s.
- Load: simulate 500 concurrent chat sessions on staging before launch.

---

## 8. Teardown bugs to avoid (from §7.4, §10.1, §14)

Stale cached dates in titles; browser-timezone formatting of sunrise/sunset; "tomorrow" page showing today's data; empty detail pages; sitemap URLs that 404; duplicated or weak meta descriptions; typos in slugs; canonical pointing to home; duplicate blog tags; two competing front-end stacks (don't migrate later; start single-stack).

---

## 9. Open decisions for the founder

1. Niche/language wedge for launch.
2. Ephemeris licence: buy Swiss Ephemeris commercial licence, or build on Skyfield/JPL?
3. Commission rates by tier, and whether promo credits are spent first.
4. AI-assistant tier: yes at launch, or after human supply is live?
5. Company/entity setup, GST registration and payment-gateway KYC (start now; they take time).

---

## 10. Kickoff prompt (paste into Claude Code)

```
Read /docs/PLAN.md fully. Do not read /docs/reference/astrotalk-teardown.md in full;
open only the sections each phase points to.

Start with Phase 0 and Phase 1 only. Before writing code, give me:
(1) the monorepo tree you will create, (2) the ADR drafts for ephemeris licensing
and ledger design, (3) the exact golden-test fixtures you propose for the astro engine.

Then build Phase 0, run CI, and show me the output. Stop after Phase 0 and wait for
my go-ahead before starting Phase 1. Follow the guardrails in section 6 at all times.
```
