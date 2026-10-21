# ADR-0009: Paid reports and background jobs

- Status: Proposed
- Date: 2026-10-21
- Contract: [docs/api/revenue.md §1–§2](../api/revenue.md)

## Context

Phase 6 sells a kundli report and a matching report as PDFs (15–20 A4 pages), paid from the
wallet or by card through Razorpay, emailed and downloadable, with a free sample. Rendering a
PDF takes seconds and can fail, so it cannot run inside a request. The plan's guardrails apply:
every astro value comes from the engine (§0.4), money moves only with a ledger entry and an
idempotency key (§6), no birth details or emails in logs (§0.5), money code is test-first.

## Decision

### 1. A Postgres job queue, not a broker

`jobs (kind, key UNIQUE, payload, status, attempts, run_after, locked_until, last_error_code)`.
The API enqueues in the caller's transaction (`astro_api.jobs.enqueue`), so "paid" and "render
queued" commit together or not at all. Workers claim with `FOR UPDATE SKIP LOCKED` and a
5-minute lease, retry with backoff (30 s, 2 min, 8 min, 32 min) up to 5 attempts, then call the
handler's `on_failed` once. Payloads hold ids only. Handlers are idempotent because a crashed
worker's job is claimed again. Rejected: Celery/RQ/Arq on Redis (one more moving part, and the
enqueue could not share the payment's database transaction).

### 2. Snapshot at order time, frozen on the report

When an order is created the API calls the engine over HTTP (`/v1/kundli`, `/v1/dasha` and
`/v1/doshas` with `as_of` = the order date, `/v1/panchang` for the birth date and place,
`/v1/numerology` with the kundli's name when it is Latin letters, `/v1/match` for two charts,
`/v1/meta`) and stores the raw JSON responses. When the order is paid the snapshot moves to the
report row and is never changed; a re-render prints the same data. Consequences:

- Payment (wallet charge or webhook) never depends on the engine being up. If the engine is
  down the order is refused with `503` before any money moves.
- A report is reproducible and auditable: the engine version is stored with it.
- Engine errors (e.g. `tables_not_reviewed` when production requires reviewed tables) block new
  orders rather than producing a report with missing sections.
- The saved kundli's resolved UTC offset is sent with every birth, so the chart is exactly the
  one the user saved (also settles DST-ambiguous local times).

### 3. Money

- Wallet: `wallet.charge_purchase(product="report")`, key `report:{order_id}:paid`, same
  transaction as the report row and its render job. `402` writes nothing.
- Card: a Razorpay order through the existing gateway code. The existing webhook handler looks
  up recharge orders first and otherwise report orders, by provider order id. A captured
  payment posts `razorpay:payment:{payment_id}:captured` (debit `gateway:razorpay:clearing`,
  credit `platform:report_revenue`, kind `purchase`); amount mismatches and second payments on
  a paid order are never credited, exactly as for recharges. The Checkout result is verified
  and recorded but never credits. The fake gateway's simulate endpoint covers report orders.
- Final failure refunds once, key `refund:report:{report_id}`: wallet orders through
  `wallet.refund_purchase` (same buckets back); card orders as wallet credit (debit
  `platform:report_revenue`, credit `user:{id}:real`, kind `purchase_refund`), implemented in
  `astro_api.reports` with the ledger's internal helpers rather than a new public wallet API.
  Refunding to the card instead is a founder decision (see below). An admin retry after a
  refund re-renders for free and can never refund twice.

### 4. HTML → PDF through the web print page and headless Chromium

The worker prints `{WEB_INTERNAL_URL}/print/reports/{id}?sig=…` (5-minute HMAC; the page fetches
`RenderData` from the API with the same signature) with
`chromium --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer --print-to-pdf`,
120 s timeout, in an `asyncio` subprocess with a throwaway profile. The PDF is checked (`%PDF-`,
`%%EOF`, 256 B–25 MB, at least one `/Type /Page`), stored with the documents storage under a
random key, and the report marked ready with its page count.

- One rendering of the charts: the report reuses the site's React chart components and its
  Devanagari typography, so the PDF and the site never disagree.
- `--no-sandbox`: the container is the sandbox and the only page loaded is our own internal
  print page. The worker image installs Debian's `chromium` and Noto fonts (Devanagari).
- The runner is injectable (tests use a fake; one live test prints a local page with the real
  Chromium when one is installed).
- Rejected: **WeasyPrint/ReportLab** (a second implementation of every chart and table in
  Python, weak SVG and complex-script shaping for Devanagari, and drift from the site);
  **a hosted PDF API** (birth details to another processor); **Playwright** (a large driver for
  what one command-line flag does).

### 5. No LLM prose

Every number and placement in a report comes from the snapshot or `data/astro` tables. Section
explanations are fixed product copy (en + hi) reviewed by an editor. An LLM writing the report
would violate PLAN.md §0.4 and could not be checked page by page; "AI notes" may come later
behind the `ai_assistant` flag, labelled as AI.

### 6. Files, links and email

- Downloads: `GET /v1/reports/{id}/file` with a 10-minute signed link or the owner's session,
  `Content-Disposition: attachment`, `Cache-Control: private, no-store`. Bad signature 403,
  expired 410. Signatures use a key derived from `SECRET_KEY`, bound to purpose (`render` or
  `file`), report id and expiry.
- The optional email address is encrypted with the chat key (AES-256-GCM, AAD bound to the
  order), used once for a "your report is ready" message that links to the signed-in reports
  page (no file, name or birth details in the mail), then erased, also when the report fails.
- Storage: the API and the worker share `DOCUMENTS_DIR` locally; S3 (SSE-KMS) in production
  once the bucket exists (same backend as KYC documents).

### 7. Sample report

A normal report with no owner (`user_id` NULL, `sample_key` = sku + language + a hash of the
sample input), built from `products.json` `sample_birth` (city from `data/seo/cities.json`) and
rendered by the same job. `GET /v1/reports/sample` returns `202` with the status while it
renders and the signed link once ready. A matching sample needs a second fictional birth
(`sample_partner_birth` in `products.json`); until it exists the endpoint returns `404
sample_unavailable` for matching.

## Consequences

- Tests were written first for every money path (`services/api/tests/test_reports_money.py`,
  the refund paths in `services/worker/tests/test_report_render.py`).
- Reconciliation check 3 currently pairs gateway payments with `recharge` credits only; card
  payments for reports (kind `purchase`, `external_ref` = payment id, credit to
  `platform:report_revenue`) must be added there or they show as `missing_credit`.
- An unpaid card order keeps its snapshot (birth details) until a cleanup job removes orders
  left `created` for N days; to be added with the Phase 7 retention policy.
- `as_of` is the order's date: a card payment that arrives on a later day keeps the dasha "as
  of" the order date (shown in the report as the engine returned it).

## Open founder decisions

- Card-paid report that fails for good: refund to the wallet (implemented) or to the card.
- Second fictional birth for the matching sample.
- Prices (`founder_decision: true` in `products.json`) and email link target page.
