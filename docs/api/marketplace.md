# Marketplace API (Phase 3)

Contract between the API (`services/api`), the public web app and the admin app. All errors use
`{"detail": {"code", "message", ...}}`. Money is integer paise. Instants are UTC ISO-8601.
Taxonomy (skills, languages, genders, tiers with price bounds) lives in
`data/marketplace/taxonomy.json` and is served by `GET /v1/taxonomy`.

## Visibility rule (hard requirement)

An astrologer is **public** only when `status ∈ {probation, approved}` and
`flags.show_in_directory` is true. In staging/production, rows with `is_seed = true` are never
public either. Every public endpoint, the sitemap and review endpoints go through one query helper
that applies this rule; anything else returns 404.

## Lifecycle

```
applied ──(identity + qualification documents uploaded)──> kyc_submitted
kyc_submitted ──(admin passes identity, qualification)──> interview
interview ──(admin passes interview; approve with tier + price)──> probation (public)
probation ──(admin passes probation)──> approved (public)
any ──> rejected (terminal)        probation/approved ──> suspended ──(reinstate)──> previous
```

Verification steps (in order): `identity`, `qualification`, `interview`, `probation`; each
`pending | passed | failed` with reviewer, note and time. Every admin action writes `audit_log`.

## Roles and auth

Session tokens come from phone OTP (`/v1/auth/*`). `users.roles` holds `admin`. Admin endpoints
require a session whose user has the `admin` role (granted with
`python -m astro_api.cli grant-role <phone> admin`). The old `ADMIN_TOKEN` is removed.
`GET /v1/me` → `{id, phone (masked), locale, roles: [...], astrologer: {id, status, slug} | null, ...}`.

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/taxonomy` | the taxonomy file |
| GET | `/v1/astrologers` | filters: `skill` (repeatable, any), `language` (repeatable, any), `gender`, `tier`, `min_price`, `max_price` (paise/min), `online=true`; `sort=recommended\|price_asc\|price_desc\|experience\|rating`; `cursor`, `limit` (1-50, default 20) → `{items: [Card], next_cursor, total}` |
| GET | `/v1/astrologers/slugs` | `[{slug, updated_at}]` for the sitemap |
| GET | `/v1/astrologers/{slug}` | `Profile` or 404 |
| GET | `/v1/astrologers/{slug}/reviews` | `cursor`, `limit` → `{items: [Review], next_cursor, rating: {average, count}}` (published only) |

`Card`: `{id, slug, display_name, photo_url: null, skills, languages, gender, tier,
price_per_min_paise, experience_years, rating: {average: float|null, count}, presence:
"online"|"busy"|"offline", wait_minutes: int|null, is_demo: bool}`.

`Profile`: Card + `{bio, bio_hi: str|null, verified: {identity, qualification, interview: true},
on_platform_since: "YYYY-MM", consult: {chat_enabled, call_enabled}, availability: {timezone:
"Asia/Kolkata", slots: [{weekday, start, end}]}}` (weekly schedule, Phase 5, portal.md §2.1;
no schedule → `slots: []`, which the UI does not show).

`Review`: `{id, rating, text, created_at, author_label ("Verified client"), reply: {text, at}|null}`.

Sort `recommended`: online first, then busy, then offline; within each, Bayesian rating
(prior mean 4.0 weight 5) descending, then experience descending, then id. Every sort ends with
`id` as tie-break so pages never overlap or skip. Rating average is null with fewer than 1 review.

Presence: Redis `presence:{astrologer_id}` = `online` (TTL 120 s, refreshed by the portal's
heartbeat) or `busy` (set by sessions, Phase 4). `wait_minutes` is null unless busy with a known
end (`busy_until:{id}`); never invented.

## Applicant (signed-in user)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/astrologer/application` | `{display_name, bio, bio_hi?, skills[], languages[], gender, experience_years, requested_price_per_min_paise, accepts_terms: true}` → 201 `Me`; 409 `already_applied` |
| GET | `/v1/astrologer/me` | `Me`: application/profile + `status`, `verifications: [{step, status, note, at}]`, `documents: [{id, kind, filename, size, uploaded_at, review_status}]` |
| PATCH | `/v1/astrologer/me` | same fields; only while `applied` or `kyc_submitted` (409 `locked`) |
| POST | `/v1/astrologer/me/documents` | multipart `file`, `kind=identity\|qualification\|other`; ≤ 5 MB; PDF/JPEG/PNG checked by magic bytes; ≤ 10 docs; moves to `kyc_submitted` once identity + qualification exist |
| DELETE | `/v1/astrologer/me/documents/{id}` | only before review |
| POST | `/v1/astrologer/me/presence` | `{status: online\|offline}`; public astrologers only |
| POST | `/v1/reviews/{id}/reply` | `{text}`; the reviewed astrologer, once |

## Clients (signed-in user)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/consult-sessions/{id}/review` | `{rating: 1-5, text ≤ 1000}`; only the session's user, only `completed`, one per session (409 `already_reviewed`, 409 `session_not_completed`, 404 otherwise). Text with banned terms → `flagged` (held for moderation), else `published` |
| POST | `/v1/reviews/{id}/report` | `{reason}` → `flagged`; stays visible until a moderator acts |

`consult_sessions`: `id, user_id, astrologer_id, kind chat|call, status, started_at, ended_at,
created_at`; Phase 4 statuses and billing fields: [billing.md](billing.md).

## Admin (`admin` role)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/astrologers` | `status`, `q` (name/slug), `cursor` → list |
| GET | `/v1/admin/astrologers/{id}` | everything incl. masked phone, documents, verifications, flags, audit trail |
| GET | `/v1/admin/documents/{id}/content` | streams the file; `Cache-Control: no-store`; audited |
| POST | `/v1/admin/astrologers/{id}/verifications/{step}` | `{status: passed\|failed, note}`; steps in order |
| POST | `/v1/admin/astrologers/{id}/approve` | `{tier, price_per_min_paise}` (within tier bounds) → `probation`; needs identity, qualification, interview passed |
| POST | `/v1/admin/astrologers/{id}/suspend` | `{reason}`; `/reinstate`; `/reject {reason}` |
| PATCH | `/v1/admin/astrologers/{id}` | `{tier?, price_per_min_paise?, flags?: {chat_enabled, call_enabled, show_in_directory}}` |
| GET | `/v1/admin/reviews` | `status=flagged\|hidden\|published` |
| POST | `/v1/admin/reviews/{id}/hide` | `{reason}`; `/unhide` |
| … | `/v1/admin/horoscopes…` | unchanged paths, now role-based auth |

## Dev seed (never production)

`python -m astro_api.seed demo-astrologers [--count 30]` (or `make seed`) refuses unless
`APP_ENV ∈ {development, test}`. Seeded rows have `is_seed = true`, names "Demo Astrologer NN",
bios starting "[Demo profile]", reviews starting "[Demo review]", and `is_demo: true` in API
responses; the UI shows a "Demo profile" badge. Re-running replaces previous seed rows.

## KYC documents

Stored through a storage interface: `local` (dev/test, `DOCUMENTS_DIR`, gitignored) or `s3`
(production, SSE-KMS; refused to start in staging/production with `local`). Never public; only
the admin content endpoint reads them.
