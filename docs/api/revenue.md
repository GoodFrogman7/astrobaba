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

`GET /v1/reports/products` → `{items: [{sku, price_paise, languages, pages_estimate}]}` (public).

`POST /v1/reports/orders` (signed in, `Idempotency-Key`) `{sku, language, kundli_ids: [uuid]
(1 for kundli, 2 different ones for matching, from the user's saved kundlis), pay_with:
"wallet" | "razorpay", email?: string}` → 201 `ReportOrder`. For matching, `kundli_ids[0]` is
the engine's `groom` role and `kundli_ids[1]` the `bride` (as in `/v1/match`). Errors:
`422 wrong_kundli_count` (with `kundlis`), `404 kundli_not_found` (not yours or missing),
`503 engine_unavailable` (nothing written), `409 idempotency_conflict`.

- The **snapshot** (§2.3) is built from the engine when the order is created, so payment never
  waits on the engine; it moves to the report when the order is paid and is cleared on the order.
- `wallet`: charged at once with `wallet.charge_purchase(product="report")` (general promo by
  earliest expiry, then real; never a session's free lot), ledger key `report:{order_id}:paid`
  (debit user promo/real, credit `platform:report_revenue`); the report row and its render job
  are created in the same database transaction. Refunds use `wallet.refund_purchase` (same
  buckets back, key `refund:report:{report_id}`). `402 insufficient_funds` with
  `required_paise`, `available_paise`; nothing is written.
- `razorpay`: a Razorpay order (same gateway code as recharges). Only the webhook pays it: it
  posts `razorpay:payment:{payment_id}:captured` (debit gateway clearing, credit
  `platform:report_revenue`; ledger kind `purchase`, the user's wallet is not touched), creates
  the report and enqueues its render in the same transaction. Amount/currency mismatch →
  `mismatch`, not paid; a second payment on a paid order → `duplicate_payment`, never credited
  (billing.md). The fake gateway's simulate endpoint (`POST /v1/dev/payments/{order_id}/simulate`)
  takes a report order id too. A refund of a card-paid report is wallet credit: debit
  `platform:report_revenue`, credit `user:{id}:real` (key `refund:report:{report_id}`, kind
  `purchase_refund`).
- Once paid, a `report_render` job is enqueued (key `report:{id}:render`). The snapshot never
  changes; a re-render uses the same data.
- `email` (optional) is stored encrypted (AES-256-GCM, chat key, AAD `report_order:{id}:email`),
  used once to send a "your report is ready" message with a link to the signed-in reports page
  (no file, name or birth details in the mail), then erased (also erased if the report fails).

`GET /v1/reports/orders/{id}` (own orders only, else 404) → `ReportOrder`.

`POST /v1/reports/orders/{id}/checkout-result` `{provider_payment_id, provider_signature}` →
`ReportOrder`. Verifies the Razorpay Checkout signature (HMAC-SHA256(key secret,
`order_id|payment_id`)) and records it. **Never pays or credits**: that comes only from the
webhook, as for recharges. `400 invalid_signature`; `409 not_a_card_order` for wallet orders;
`404` for someone else's order.

`ReportOrder`: `{id, sku, language, status: created|paid|failed, price_paise, currency: "INR",
pay_with, provider: "razorpay"|"fake"|null (null for wallet orders), provider_order_id,
key_id (Razorpay orders only, else null), report_id: uuid|null, created_at, paid_at}`.

### 2.2 Reports

`GET /v1/reports` → `{items: [Report]}` (own, newest first). `GET /v1/reports/{id}` → `Report`
(own, else 404).
`Report`: `{id, sku, language, status: queued|rendering|ready|failed, title, created_at,
ready_at, pages: int|null, download_url: string|null}`. `download_url` is set only when ready:
an absolute path (relative to the API origin) starting `/v1/reports/{id}/file?sig=`, signed for
10 minutes (`report_download_ttl_s`).
`GET /v1/reports/{id}/file?sig=` → the PDF (`application/pdf`, `Content-Disposition:
attachment`, `Cache-Control: private, no-store`). Valid signature or the owner's session
(`Authorization: Bearer`). Bad signature `403 invalid_signature`, expired `410 link_expired`,
no signature and no session `401`, not ready or unknown `404`.
A report that fails 5 times → `failed`, admin is alerted (error log `report_failed`, ids only)
and the user is refunded automatically, once (ledger `refund:report:{id}`: same buckets for
wallet orders, real wallet credit for card-paid orders). Samples are not refunded.

### 2.3 Rendering

- `GET /v1/reports/render/{id}?sig=` (HMAC of purpose + id + expiry with a key derived from
  SECRET_KEY, 5 minutes) → `RenderData` = `{report: {id, sku, language, created_at,
  engine_version}, snapshot: {kundlis: [{label, birth: {date, time|null, place: {name, lat,
  lon, tz}}, kundli, dasha, doshas, numerology|null, panchang}], match|null, meta}}`, where
  kundli/dasha/doshas/numerology/panchang/match/meta are the engine's raw responses for
  `/v1/kundli`, `/v1/dasha` and `/v1/doshas` (`as_of` = the order's date, UTC),
  `/v1/numerology` (`name` = the label; `null` when the label is not Latin letters),
  `/v1/panchang` (birth date at the birth place), `/v1/match` (`kundlis[0]` groom,
  `kundlis[1]` bride) and `/v1/meta`. Names are the kundli `label`s (no separate `names`).
  `place.name` is always set (the saved place label, else the coordinates). Only for the
  renderer; no session needed. Bad signature `403`, expired `410`, unknown id `404`.
- The web app serves `GET /print/reports/{id}?sig=` (private, `noindex`, not in the sitemap,
  no app chrome, A4 print CSS, system fonts incl. Devanagari): it fetches RenderData
  server-side and renders the report with the existing chart components.
- The worker prints that URL with headless Chromium (`--headless=new --print-to-pdf
  --no-pdf-header-footer`, 120 s timeout), validates the PDF (`%PDF-` and `%%EOF`, 256 B–25 MB,
  at least one page), stores it with the documents storage (random key; the API and the worker
  share `DOCUMENTS_DIR`), records pages and size, marks the report `ready`, and enqueues
  `report_email` (key `report:{id}:email`) if an address was given (dev: console email
  provider). Error codes on the job: `render_timeout`, `render_failed`, `pdf_invalid`,
  `pdf_no_pages`, `pdf_too_large`.

### 2.3a Admin

`GET /v1/admin/reports?status=&cursor=` → `{items, next_cursor}`, newest first, 50 per page.
Each row: `{id, owner_id (null for samples), sku, language, status, attempts, last_error_code,
refunded: bool, created_at, ready_at}`, plus `order_id, sample, pay_with, render_n, pages,
failed_at`. Attempts and error code are those of the current render job. Never names, titles,
snapshots or birth details.

`POST /v1/admin/reports/{id}/retry` `{charge_again: false}` re-queues a `failed` render (new
job key `report:{id}:render:{n}`, `n` = 1, 2, …) → the row above plus `job_key`. A report that
is not `failed` → `409 not_failed`. A refunded report is re-rendered for free and stays
refunded (`charge_again: false` is the only option in v1; `true` → 422); failing again never
refunds twice. Audited (`report_retry`, ids and `render_n` only).

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

Decision: ADR-0010. Labelled "AI" everywhere (`AI_LABEL` from packages/shared). Never presented
as a person; no avatar that looks human; every answer offers "Talk to a human astrologer".
Every endpoint here answers 404 while the flag is off.

- `GET /v1/ai/pricing` (public) → `{price_paise, max_chars, enabled: true}` from
  `products.json` (`ai_question`).
- `POST /v1/ai/conversations` (signed in) `{kundli_id}` (one of the user's saved kundlis, else
  404 `kundli_not_found`) → 201 `{id, kundli_id, created_at}`.
- `GET /v1/ai/conversations` (signed in) → `{items: [{id, kundli_id, kundli_label, created_at,
  questions}]}`: own conversations, newest first; `kundli_label` is the saved kundli's name,
  `questions` the number of questions in it.
- `POST /v1/ai/conversations/{id}/questions` (`Idempotency-Key`) `{text: 1–500 chars after
  trimming}` → 202 `AiQuestion`. Before anything else the question goes through the safety
  classifier (English, Hindi, Hinglish):
  - **blocked** (self-harm, emergency, medical, legal, financial): stored with status `blocked`,
    `blocked_reason` `self_harm|medical|legal|financial|other` (emergencies are `other`), a fixed
    `notice` pointing to people who can help (self-harm: a mental-health professional or local
    emergency services, "not a helpline"; Phase 7 adds verified helplines), **never charged**
    (`price_paise: 0`, `refunded: false`), never queued, and returned even with an empty wallet.
  - otherwise status `queued`: charged at once (`wallet.charge_purchase(product="ai_question")`,
    key `ai:{question_id}:charge`) in the same transaction as the question and its `ai_answer` job
    (key `ai:{question_id}:answer`, payload `{question_id, user_id}`). `402 insufficient_funds`
    with `required_paise`, `available_paise` when unfunded (nothing is written). Refunded
    automatically and exactly once (`wallet.refund_purchase`, key `refund:ai:{question_id}`, to
    the same buckets) when the answer is blocked or fails.
  - The same key with the same body replays the same question; with another body, 409.
- `GET /v1/ai/conversations/{id}` (own only, else 404) → `{id, kundli_id, created_at, label,
  labels: {en, hi}, kundli: {id, name, label, unknown_time}, questions: [AiQuestion]}` (oldest
  first).
- `AiQuestion`: `{id, text, status: queued|answered|blocked|failed, answer: string|null,
  blocked_reason: string|null, created_at, answered_at, price_paise, refunded: bool, language:
  en|hi, label, handoff, notice: string|null}`. `answer` is plain text; `label` (the AI label)
  and `handoff` (the human-astrologer line) are stored with it in the question's language for the
  UI to show; `notice` is fixed copy for blocked and failed questions.
- The worker (`ai_answer` job) re-runs the classifier (blocked → `blocked` + refund, the LLM is
  never called), gets facts for the saved kundli from the engine (chart, current Vimshottari
  periods, today's transits; no birth date, time or place reaches the LLM; with an unknown birth
  time the ascendant, houses and dasha are omitted), asks the LLM (provider abstraction; paid
  no-training tier; fake in dev) for an answer in the question's language (Hindi for Devanagari
  or Hinglish questions), then validates it: the horoscope banned claims plus no human or
  astrologer impersonation, guarantees, fear, remedies/gemstones/products, advice, links or phone
  numbers; grounding: every planet, sign and house named must match the facts, dasha lords must
  be the current or next ones, years must be in the facts. Invalid → one retry with the errors,
  then `blocked` (`other`) + refund. Engine or LLM errors are retried by the job runner; after
  the last attempt the question is `failed` + refund.
- Questions and answers are stored encrypted (same key set as chat), never logged, never put in
  job payloads and never used for training.

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
