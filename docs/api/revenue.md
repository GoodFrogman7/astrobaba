# Reports, AI assistant and remedies API (Phase 6)

Extends [billing.md](billing.md) (wallet, Razorpay, ledger) and [portal.md](portal.md).
Decision: ADR-0009. Money is integer paise; instants UTC ISO-8601; errors
`{"detail": {"code", "message", ...}}`. Settings: `data/marketplace/products.json`. Shared TS
shapes: `packages/shared/src/products.ts`.

## 1. Background jobs

Table `jobs (id, kind, payload jsonb, status queued|running|done|failed, attempts, run_after,
locked_until, last_error_code, created_at, finished_at)`. Kinds: `report_render`, `report_email`,
`ai_answer`, `remedy_lead_notify`. `astro_api.jobs.enqueue(db, kind, payload, key)` inserts in the caller's
transaction (UNIQUE `key`, so enqueueing is idempotent). The worker (`python -m astro_worker
jobs run`, a compose service) claims with `FOR UPDATE SKIP LOCKED`, sets `locked_until`, retries
with backoff up to 5 attempts, and never logs payload content. Payloads hold ids only.

## 2. Paid reports

Products (`products.json`): `kundli_report` (one birth chart) and `matching_report` (two). Price
per product in paise, languages `en`/`hi`.

### 2.1 Buying

`GET /v1/reports/products` → `{items: [{sku, price_paise, languages, pages_estimate}]}`.

`POST /v1/reports/orders` (signed in, `Idempotency-Key`) `{sku, language, kundli_ids: [uuid]
(1 for kundli, 2 for matching, from the user's saved kundlis), pay_with: "wallet" | "razorpay",
email?: string}` → 201 `ReportOrder`.

- `wallet`: charged at once with `wallet.charge_purchase(product="report")` (general promo by
  earliest expiry, then real; never a session's free lot), ledger key `report:{order_id}:paid`
  (debit user promo/real, credit `platform:report_revenue`). Refunds use
  `wallet.refund_purchase` (same buckets back, key `refund:report:{report_id}`).
  `402 insufficient_funds` with `required_paise`, `available_paise`.
- `razorpay`: a Razorpay order (same gateway code as recharges). The webhook marks it paid and
  posts `razorpay:payment:{payment_id}:captured` (debit gateway clearing, credit
  `platform:report_revenue`); a second payment on a paid order is never credited
  (billing.md). The fake gateway's simulate endpoint works for report orders too.
- Once paid: the report row is created with a **snapshot** of everything it shows (engine
  outputs for the saved kundli(s): kundli, dasha, doshas, numerology, panchang at birth;
  matching for two) and the engine version, then a `report_render` job is enqueued
  (key `report:{id}:render`). The snapshot never changes; regeneration re-renders the same data.
- `email` (optional) is stored encrypted, used once to send the link, then erased.

`ReportOrder`: `{id, sku, language, status: created|paid|failed, price_paise, pay_with,
provider_order_id, key_id, report_id: uuid|null, created_at, paid_at}`.

### 2.2 Reports

`GET /v1/reports` → `{items: [Report]}` (own). `GET /v1/reports/{id}` → `Report`.
`Report`: `{id, sku, language, status: queued|rendering|ready|failed, title, created_at,
ready_at, pages: int|null, download_url: string|null (only when ready; 10-minute signed URL to
GET /v1/reports/{id}/file?sig=…)}`.
`GET /v1/reports/{id}/file?sig=` → the PDF (`application/pdf`, `Content-Disposition:
attachment`, `Cache-Control: private, no-store`). Valid signature or the owner's session.
A report that fails 5 times → `failed`, admin is alerted (error log `report_failed`, ids only)
and the user is refunded automatically (ledger `refund:report:{id}`, back to the same buckets).

### 2.3 Rendering

- `GET /v1/reports/render/{id}?sig=` (HMAC of id + expiry with SECRET_KEY, 5 minutes) →
  `RenderData` = `{report: {id, sku, language, created_at, engine_version}, snapshot,
  names?: [...]}`. Only for the renderer; no session needed; no personal data beyond the
  report's own birth details.
- The web app serves `GET /print/reports/{id}?sig=` (private, `noindex`, not in the sitemap,
  no app chrome, A4 print CSS, system fonts incl. Devanagari): it fetches RenderData
  server-side and renders the report with the existing chart components.
- The worker prints that URL with headless Chromium (`--print-to-pdf`, no header/footer),
  stores the PDF with the documents storage (random key), records pages and size, marks the
  report `ready`, and enqueues email if an address was given (dev: console email provider).

### 2.4 Content (15–20 A4 pages)

Every number and placement comes from the snapshot (engine) or `data/astro` tables. No
predictions or interpretations are invented. Each section has a short fixed "How to read
this" explanation (product copy, en + hi, editorial review before launch). Sections:
cover · birth details and panchang at birth · North and South Indian charts · planets table
(sign, degree, nakshatra, pada, lord, house, retrograde) · houses with occupants and lords ·
nakshatras of Moon, Sun and ascendant (names, lords, padas from tables) · Vimshottari dasha
(all mahadashas with dates; antardashas of the current and next mahadasha) · doshas (Mangal,
Kaal Sarp, Sade Sati with the table review status) · numerology · for matching: both charts,
Ashtakoota table (8 kootas with points), total and Mangal compatibility · method and sources
(ayanamsha, node, houses, engine version) · disclaimer (entertainment, not advice).
Tables marked `needs_astrologer_review` are labelled as such in the report, exactly as on the
site. With the `ai_assistant` flag on, an optional "AI notes" box per section may appear
later; not in Phase 6.

### 2.5 Sample report

`GET /v1/reports/sample?sku=&language=` → `{download_url}` for a public sample generated from
a fixed sample birth input (labelled "Sample: <name> is fictional"), rendered by the same
pipeline and cached. The web page `/reports` (indexable) describes both reports with prices,
page list and the sample download.

## 3. AI assistant (flag `ai_assistant`, off; founder decision PLAN.md §9.4)

Labelled "AI" everywhere (`AI_LABEL` from packages/shared). Never presented as a person; no
avatar that looks human; every answer offers "Talk to a human astrologer".

- `POST /v1/ai/conversations` (signed in) `{kundli_id}` → `{id, kundli_id, created_at}`.
- `POST /v1/ai/conversations/{id}/questions` (`Idempotency-Key`) `{text: 1–500 chars}` →
  202 `AiQuestion` (status `queued`). Price per question from `products.json` (`ai_question`),
  charged when queued (`wallet.charge_purchase(product="ai_question")`, key
  `ai:{question_id}:charge`), refunded automatically (`wallet.refund_purchase`, key
  `refund:ai:{question_id}`) when the answer fails or is blocked. 402 when unfunded.
- `GET /v1/ai/conversations/{id}` → `{id, kundli: {...label}, questions: [AiQuestion]}`.
- `AiQuestion`: `{id, text, status: queued|answered|blocked|failed, answer: string|null,
  blocked_reason: string|null, created_at, answered_at, price_paise, refunded: bool}`.
- The worker (`ai_answer` job) builds facts from the kundli snapshot (engine), asks the LLM
  (provider abstraction; paid no-training tier; fake in dev) for an answer grounded on those
  facts, then validates it with the same rules as horoscopes (banned claims: health cures,
  guaranteed outcomes, fear, legal/financial/medical advice, remedies/gemstones sales;
  grounding: any planet-sign-house claim must match the facts). Invalid → one retry, then
  `blocked` + refund. Questions about self-harm, medical, legal or financial matters are not
  sent to the LLM: `blocked` with the right message and a human-astrologer hand-off
  (Phase 7 adds crisis resources).
- Questions and answers are stored encrypted (same key as chat), never logged or used for
  training.

## 4. Remedies and pujas (catalogue + partner leads)

- `data/marketplace/remedies.json`: catalogue entries `{id, kind: puja|consultation_followup,
  name {en,hi}, description {en,hi}, partner_id, price_note {en,hi}}`; partners `{id, name,
  contact (email/webhook), active}`. No gemstones, no inventory, no outcome claims
  (`review: needs_editorial_review` until checked).
- `GET /v1/remedies` → active catalogue. `POST /v1/remedies/leads` (signed in,
  `Idempotency-Key`) `{remedy_id, preferred_date?, language, note? (≤500 chars), consent:
  true}` → 201 `{id, status: new}`. Stored with the user's phone (masked in every view except
  the partner hand-off), note encrypted. A `remedy_lead_notify` job sends it to the partner
  (email in dev console). The user sees "A partner will contact you; we don't sell remedies
  ourselves and no outcome is promised".
- Admin: `GET /v1/admin/remedies/leads` (status filter), `POST /v1/admin/remedies/leads/{id}
  {status: contacted|closed|spam, note}`. Audited.
