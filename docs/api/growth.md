# Launch and growth API (Phase 8)

PLAN.md Phase 8: seed real vetted astrologers, publish and submit the site, start the content
calendar, measure the funnel visit → tool use → OTP → free session → first recharge → repeat.
Errors `{"detail": {"code", "message", ...}}`; instants UTC ISO-8601; calendar dates are IST.
Targets and supply goals: `data/growth/targets.json` (assumptions to validate, not facts).
Shared TS shapes: `packages/shared/src/growth.ts`. Decision: ADR-0013. Every `/v1/admin/...`
route requires the admin role, like the existing admin routes, and writes an audit row on change.

## 1. Product analytics (first party)

No third-party analytics, no fingerprinting, no IP or user agent stored, no free text (the
closed schema in `packages/shared/analytics/events.json`, now version 2). Chat content, birth
details, names, phones and emails can never be sent.

### 1.1 Collection

- **Anonymous id:** cookie `aid` (random 16 bytes, base64url, HttpOnly, SameSite=Lax, Secure on
  https, 180 days), set by the web route `POST /api/e` the first time it accepts events. The
  browser never reads it.
- **Opt-out:**
  - Requests with `Sec-GPC: 1` or `DNT: 1` are dropped (204) and `aid` is cleared.
  - Cookie `aid_off=1` (one year) also disables collection. The privacy page has a switch:
    `POST /api/e/opt-out` sets it and clears `aid`, and `DELETE /api/e/opt-out` removes it.
- **Browser → web:** `POST /api/e` `{events: [{event, ts, locale, properties}]}`, at most 20
  events, sent with `navigator.sendBeacon` every 5 s and on `visibilitychange`.
  - The route drops requests from obvious bots (user-agent pattern) and never forwards the user agent.
  - It adds `anonymous_id` from the cookie, `schema_version` and `user_id: null`.
  - It forwards to the API with the user's bearer token, if signed in, and the client IP for rate limiting.
- **Web → API:** `POST /v1/analytics/events` `{events: [envelope...]}` (≤ 20) → 202 `{accepted,
  rejected}`.
  - Each event is checked with `validate_event`; invalid events are dropped and counted, never logged with values.
  - `user_id` comes only from the bearer token. The envelope's `user_id` is ignored.
  - `occurred_at` is the client `ts`, or the receive time if `ts` is more than 24 h off.
  - Rate limit: 300 events per minute per client IP (HMAC) → 429 `rate_limited`.
- **Identity link:** after a successful OTP verify, the web BFF route posts `otp_verified
  {is_new_user}` server-side with the new token and the `aid` cookie, so the anonymous id is
  linked to the user without the browser doing anything.
- **Events the web sends:**
  - `page_view {path, source?, utm_source?, utm_campaign?}` on every navigation. Path segments
    that are UUIDs become `_id`.
  - `source`, `utm_source` and `utm_campaign` are sent only on the first page view of a browser
    tab session.
    - `source` is one of `direct | search | social | referral | campaign`: `campaign` when
      utm_source is present, `search`/`social` from a fixed list of referrer hosts, `referral`
      for any other referrer host, `direct` when there is none.
    - The utm values are lower-cased, characters outside `[a-z0-9-]` become `-`, and they are
      cut to 80 characters.
  - `tool_started {tool}` on the first input in a tool form; `tool_completed {tool,
    unknown_birth_time?}` when a result shows (tools: the 9 tool slugs, `kundli`,
    `kundli-matching`).
  - `consult_cta_clicked {source, astrologer_slug?}` and `otp_requested {source}`.

### 1.2 Storage and retention

Table `analytics_events (id bigint identity, event, occurred_at, received_at, anonymous_id,
user_id uuid null, locale, properties jsonb)`. Indexes `(anonymous_id, occurred_at)`, `(event,
occurred_at)`, `(user_id)`.

- **Retention:** `python -m astro_api.cli analytics-purge` deletes rows older than
  `ANALYTICS_RETENTION_DAYS` (default 400). Run it daily.
- **Deletion** (Phase 7 executor): delete every row whose `user_id` is the user, and every row
  whose `anonymous_id` was ever linked to that user.
- **Export:** adds `analytics_events: [{event, occurred_at, properties}]` for rows with the user's `user_id`.

### 1.3 Funnel

`GET /v1/admin/growth/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD&window_days=30&locale=&source=`
(IST dates, `to - from` ≤ 92 days, `window_days` 1–90) → `GrowthFunnel`.

**Visitor funnel.** The cohort is anonymous ids whose first ever `page_view` falls in [from, to].
`locale` and `source` filter on that first page view. A step counts when it happens within
`window_days` of the first page view:

| Step key | Counts an anonymous id / user that... |
|---|---|
| `visit` | is in the cohort |
| `tool_use` | has a `tool_completed` |
| `otp` | has an `otp_verified` (the linked user) |
| `free_session` | has a `free_session_claims` row whose session has `started_at` |
| `first_recharge` | has a recharge order with `paid_at` |
| `repeat` | has a second recharge order with `paid_at` |

- Each step reports:
  - `count`, strict: the previous step was reached too;
  - `reached`: this step was reached, whatever happened before;
  - `rate`: `count / previous count`, null when the previous count is 0;
  - `target`: `{low, high}` from targets.json or null.
- **Account funnel.** Users created in [from, to] (every account, including ones whose browser
  sent no analytics), with steps `otp` (= cohort) → `free_session` → `first_recharge` →
  `repeat`, measured the same way from account creation. This is exact and unaffected by opt-outs.
- **Weeks:** `weeks: [{week_start, counts: {step: n}}]`, using strict counts per ISO-week
  cohort (Monday, IST), for both funnels.
- **Breakdowns** (visitor funnel): `by_source`, `by_tool` and `by_landing` (first page path).
  Each is the top 10 rows `{key, visit, otp, first_recharge}`. Rows with fewer than 5 visits are
  merged into `other`.
- Response `{from, to, window_days, generated_at, visitor: {steps, weeks, by_source, by_tool,
  by_landing}, account: {steps, weeks}, notes: [string]}`. `notes` is fixed text, for example
  "Visitors who opted out or block cookies are not in the visitor funnel".

## 2. Astrologer supply

### 2.1 Invites

Table `astrologer_invites (id, code_hash, note, created_by, created_at, expires_at, used_at,
used_by_astrologer_id, revoked_at)`. The code is 12 characters from `[A-HJ-NP-Z2-9]`, stored only
as HMAC-SHA256 with `SECRET_KEY`. `note` is admin-only, at most 200 characters, and is never
shown publicly.

- `POST /v1/admin/astrologer-invites {note?, expires_days 1-60 (default 14)}` → 201 `{id, code,
  url, expires_at}`.
  - `url` is `{ASTROLOGER_PORTAL_URL}/apply?invite={code}`.
  - The code is returned only in this response.
- `GET /v1/admin/astrologer-invites?status=open|used|expired|revoked` → `{items: [{id, note,
  status, created_at, expires_at, used_at, astrologer_id}]}`, with no codes.
- `POST /v1/admin/astrologer-invites/{id}/revoke` → the row. 409 `invite_used` if already used.
- `POST /v1/astrologer/application` takes an optional `invite_code`:
  - A valid open code is marked used in the same transaction.
  - An unknown, expired, used or revoked code → 422 `invite_invalid`.
  - With flag `astrologer_invite_only` on (default off), applying without a code → 403
    `invite_required`.
  - `astrologers.invite_id` records the invite used.

### 2.2 Supply readiness

`GET /v1/admin/growth/supply` → `SupplyReadiness`:

```
{target: {min, max},                       // targets.json supply.astrologers
 live: n,                                  // approved and public (is_public), not demo
 pipeline: {applied, kyc_submitted, interview, probation, approved, suspended, rejected},
 steps_passed: {identity, qualification, interview, probation},
 languages: [{id, live, target_min}],      // targets.json supply.languages
 skills: [{id, live, target_min}],         // targets.json supply.skills
 schedule: {hours: [[n x 24] x 7],         // live astrologers scheduled per IST weekday/hour
            uncovered_hours: n},            // of the hours in targets.json supply.core_hours
 invites: {open, used, expired, revoked}}
```

The weekday order is Monday to Sunday, from `astrologer_availability` (informational schedules).
Demo astrologers (`is_demo`) are never counted.

## 3. Publishing and search

- `robots.txt`: when `NEXT_PUBLIC_SITE_ENV` is not `production`, it disallows `/` and every
  response carries `X-Robots-Tag: noindex`. In production it is unchanged.
- `GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` become `<meta>` verification tags when set.
- IndexNow:
  - When `INDEXNOW_KEY` (8-128 characters, `[A-Za-z0-9-]`) is set, `/{INDEXNOW_KEY}.txt` serves the key.
  - `pnpm --filter @astro/web indexnow [--since YYYY-MM-DD] [--dry-run]` reads the live
    `/sitemap.xml`. It submits URLs whose `lastmod` is on or after `since` (default: today,
    IST), plus the daily horoscope and panchang hub URLs, to `https://api.indexnow.org/indexnow`
    in batches of up to 10,000.
  - Run it daily after the horoscopes are published. Google is submitted through Search Console
    by hand (see docs/LAUNCH.md).
- **Articles (`/learn`):**
  - Files `apps/web/src/content/{en,hi}/learn/{slug}.json` `{slug, status: draft|published, title,
    description, h1, intro, sections, related_tools: [tool slug], author, reviewed_by,
    published_at, updated_at}`. `sections` uses the same block format as the existing content files.
  - Only `published` files with a non-empty `reviewed_by` are routed, listed and put in the sitemap.
  - Each page has Article JSON-LD and the entertainment disclaimer, and passes claims-check and seo-check.
  - `/learn` lists published articles; with none published it returns 404 and is not in the sitemap.
  - No article content ships in this phase; the founder writes and reviews it.

## 4. Content calendar

### 4.1 Items

Table `content_items (id, title, kind, locale, status, due_date, url, notes, created_by,
created_at, updated_at)`:

- `kind`: `article | horoscope | tool_page | social | video | other`;
- `locale`: `en | hi | both`;
- `status`: `idea | drafting | review | scheduled | published`;
- `title`: 1-160 characters; `notes`: ≤ 1000 characters;
- `url`: a site path or an https URL, required when `status` is `published`.

Endpoints:
- `GET /v1/admin/content-items?from&to&status&kind` → `{items}`, ordered by due_date then created_at.
- `POST /v1/admin/content-items` → 201 item.
- `PATCH /v1/admin/content-items/{id}` → item.
- `DELETE /v1/admin/content-items/{id}` → 204.

### 4.2 Dates to plan around

`GET /v1/admin/growth/almanac-dates?days=60` (`days` 7-120). The data is computed by the engine
for New Delhi (`/v1/panchang`, one call per day) and cached in Redis per IST date for 7 days.

- Each item is `{date, kind, tithi?, sign?}`:
  - `purnima`, `amavasya`, `ekadashi`: the tithi at sunrise (numbers 15, 30, 11/26);
  - `sun_sign_change`: `sun_at_sunrise.sign_index` differs from the previous day's (`sign` =
    the new sign id).
- Labels in the admin UI say "tithi at sunrise, New Delhi" and "Sun enters <sign> (sidereal)";
  they are not festival observance dates.
- The engine being unreachable → 503 `engine_unavailable`.

## 5. Launch readiness

`GET /v1/admin/launch-readiness` → `{generated_at, checks: [{id, status: pass|warn|fail,
detail}]}`. Each check is computed live, and none of them stores state.

| id | pass when |
|---|---|
| `legal_approved` | `LEGAL_APPROVED_VERSION` equals policies.json `version` |
| `helplines_verified` | every helpline in helplines.json has `verified_by_founder: true` |
| `jyotish_tables_reviewed` | engine `/v1/meta` reports all tables reviewed (warn if the engine is unreachable) |
| `supply_live` | live astrologers ≥ supply min (warn if > 0) |
| `supply_languages` | every target language meets its minimum |
| `horoscopes_today` | today's daily horoscopes are published for all 12 signs |
| `payments_live` | payments provider is `razorpay` |
| `sms_live` | SMS provider is not `console` |
| `email_live` | email provider is not `console` |
| `document_storage` | KYC storage is S3 |
| `reconciliation_recent` | a reconciliation run in the last 36 h with zero drift |
| `jobs_healthy` | no job `failed` in the last 24 h (warn otherwise) |
| `analytics_flowing` | at least one analytics event in the last 24 h (warn otherwise) |
| `voice_ready` | flag `voice_calls` off, or LiveKit configured |
| `ai_ready` | flag `ai_assistant` off, or an LLM key configured |

## 6. Load test (PLAN §7)

`scripts/loadtest/` (Python, uv workspace dev tool). It is refused when `APP_ENV` is production.

- `uv run python -m loadtest seed --sessions N` creates N synthetic clients (wallet credit
  through the ledger with idempotency keys and the `loadtest` reason) and N synthetic approved
  astrologers. Each record is tagged `is_demo` and can be removed with `... loadtest clean`.
- `uv run python -m loadtest run --sessions N --minutes M`:
  - opens N concurrent chat sessions through the public API and WebSocket;
  - exchanges messages at a fixed rate, then ends them;
  - reports connect and message round-trip p50/p95/p99, errors and billed seconds;
  - checks that every ledger transaction sums to zero and that each session's charge matches
    its billed minutes.
- Target before launch: 500 sessions on staging with no errors and p95 round trip under 500 ms.
