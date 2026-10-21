# Wallet, billing and chat sessions API (Phase 4)

Contract between the API, the web app (`apps/web`), the astrologer console (`apps/astrologer`)
and the admin app. Design rationale: ADR-0002 (ledger) and ADR-0007 (sessions and metering).
Money is integer **paise**. Instants are UTC ISO-8601. Errors: `{"detail": {"code", "message"}}`.
Money settings live in `data/marketplace/billing.json`; flags in `packages/shared/flags/flags.json`
(`recharge_bonus_tiers`, `first_free_session`). TypeScript shapes for sessions and the socket:
`packages/shared/src/chat.ts` (source of truth for field names together with this file).

Privacy: chat text, phones and birth details never appear in logs, analytics, audit detail or
error messages. The astrologer never sees the client's phone or name (`client_label` only).

## Idempotency

`POST` endpoints that create money or sessions require an `Idempotency-Key` header (8–128
chars, `[A-Za-z0-9_-]`). Same key + same body from the same user → the original response
(same status and body). Same key + different body → `409 idempotency_conflict`. Keys are kept
24 h (Redis cache of the response, backed by unique constraints in Postgres for money).

## Wallet (signed-in user)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/wallet` | `Wallet` |
| GET | `/v1/wallet/transactions` | `cursor`, `limit` (1–50, default 20) → `{items: [WalletTxn], next_cursor}` newest first |
| GET | `/v1/wallet/recharge-options` | `{currency, min_paise, max_paise, packs: [{amount_paise, bonus_paise}], bonus_enabled, provider: "razorpay"\|"fake", key_id}` |
| POST | `/v1/wallet/recharge-orders` | Idempotency-Key; `{amount_paise}` → 201 `RechargeOrder` |
| GET | `/v1/wallet/recharge-orders/{id}` | `RechargeOrder` (own orders only, else 404) |
| POST | `/v1/wallet/recharge-orders/{id}/checkout-result` | `{provider_payment_id, provider_signature}` → `RechargeOrder`. Verifies the Checkout signature and records it; **does not credit**. Credit comes only from the webhook. |
| POST | `/v1/dev/payments/{order_id}/simulate` | Fake provider only, never in production (404). `{outcome: "captured"\|"failed"}` → sends a correctly signed webhook through the real webhook code path. `409 order_already_paid` once paid. |

`Wallet`: `{real_paise, promo_paise, total_paise, promo_lots: [{id, remaining_paise, expires_at,
campaign}], free_session: {enabled, eligible, minutes, reason}}`.

`WalletTxn`: `{id, kind, amount_paise, real_paise, promo_paise, created_at, session_id,
astrologer: {slug, display_name} | null}`; `amount_paise` is signed from the user's view
(credit positive). `kind ∈ recharge | recharge_bonus | consultation | refund | free_session_grant
| promo_expiry | adjustment`. Per-minute charges of one session are grouped into one
`consultation` row (sum), so a 30-minute chat is one line.

`RechargeOrder`: `{id, status: created|paid|failed, amount_paise, bonus_paise, currency,
provider, provider_order_id, key_id, created_at, paid_at}`. Bonus is decided when the order is
created (flag + tiers at that moment) and credited as a promo lot when it is paid.

Bounds: `min_paise ≤ amount ≤ max_paise`, else `422 amount_out_of_range`.

## Razorpay webhook

`POST /v1/payments/razorpay/webhook` (no auth; signature instead).

1. Read the **raw body**. Verify `X-Razorpay-Signature` = hex HMAC-SHA256(webhook secret, raw
   body) with a constant-time compare. Bad or missing → `400`, nothing stored.
2. Store the event by `X-Razorpay-Event-Id` (unique). A replay → `200 {"status":"duplicate"}`.
3. `payment.captured` / `order.paid`: find our order by `razorpay order_id`; the paid amount and
   currency must equal the order's, else store as `mismatch`, alert, do not credit. Credit with
   key `razorpay:payment:{payment_id}:captured` (debit `gateway:razorpay:clearing`, credit
   `user:real`), then the bonus lot with key `recharge_bonus:{order_id}`. Order → `paid`.
   A **second, different payment on an already-paid order** (the customer paid twice) is stored
   as `duplicate_payment`, logged at error level and never credited; support refunds it to the
   card, and reconciliation shows it as a captured payment without a credit until then.
4. `payment.failed`: order → `failed` (unless already paid). Unknown events → stored, 200.

Always 200 after a valid signature (Razorpay retries on non-2xx). The fake provider uses the
same endpoint with a dev-only secret derived from `SECRET_KEY`.

## Sessions (signed-in user, or the astrologer who owns the session)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/v1/sessions` | user | Idempotency-Key; `{astrologer_id, kind: "chat", free: bool}` → 201 `SessionView` |
| GET | `/v1/sessions` | both | `role=user\|astrologer`, `status` (repeatable), `cursor`, `limit` → `{items, next_cursor}` |
| GET | `/v1/sessions/{id}` | both | `SessionView` (participants only, else 404) |
| POST | `/v1/sessions/{id}/cancel` | user | before `active` → `cancelled/user_cancelled` |
| POST | `/v1/sessions/{id}/accept` | astrologer | `requested` → `accepted` |
| POST | `/v1/sessions/{id}/decline` | astrologer | `requested`/`queued` → `cancelled/astrologer_declined` |
| POST | `/v1/sessions/{id}/end` | both | `active` → `completed` (`user_ended`/`astrologer_ended`) |
| POST | `/v1/sessions/{id}/ws-ticket` | both | → `{ticket, expires_in: 30, path: "/v1/sessions/{id}/ws"}` |
| GET | `/v1/sessions/{id}/messages` | both | `after_seq`, `limit` (≤200) → `{items: [ChatMessage]}` |
| GET | `/v1/astrologer/me/sessions/incoming` | astrologer | open sessions for me: `{items: [SessionView]}` (requested first, then queue order) |

Create checks, in order: the astrologer is public and `consult.chat_enabled`
(`404`/`409 chat_unavailable`); the user is not that astrologer (`409 own_profile`); no other
open session for this user (`409 session_open`, with `session_id`); paid: the wallet covers
`sessions.min_start_minutes` at the price (`402 insufficient_funds`, with `minutes_affordable`,
`required_paise`); free: `free_session.check` is eligible (`403 free_session_unavailable`, with
`reason`), then the lot is granted and the claim recorded in the same transaction.

The session row captures `price_per_min_paise` and `commission_bps` (tier rate) at creation, so
later price or rate changes never reprice it.

### Lifecycle

```
POST /v1/sessions ─┬─ astrologer free (online, no requested/accepted/active session) → requested
                   └─ astrologer busy or has a pending request → queued (position, ETA)
queued    ── head of queue when the astrologer frees up ──> requested
requested ── accept ──> accepted ── both sockets connected ──> active (minute 1 charged now)
requested ── decline / request_timeout_s ──> cancelled (astrologer_declined / request_timeout)
accepted  ── join_timeout_s without both connected ──> failed (join_timeout)
active    ── end / funds out / free minutes used / a side gone > heartbeat_grace_s ──> completed
queued|requested|accepted ── user cancel ──> cancelled (user_cancelled)
```

ETA for a queued request: remaining prepaid time of the astrologer's active session (if known)
plus `average_session_minutes` × the requests ahead; `null` when nothing is known. Never invented.
Presence: while an astrologer has an `accepted`/`active` session, `presence:{id}` = `busy` and
`busy_until:{id}` = end of the minutes the client's wallet covers; cleared when it ends.

### Metering (server-side, crash-safe; ADR-0002 §5, ADR-0007)

- Minute *n* is charged **before** it starts, key `session:{id}:minute:{n}`, through
  `wallet.charge_minute`. Minute 1 at activation; minute *n+1* at `started_at + n × minute`.
- The meter is a loop in every API process (`billing_meter`). Each tick selects due `active`
  sessions `FOR UPDATE SKIP LOCKED`, so several processes never charge the same minute, and
  the ledger key makes a double charge impossible anyway.
- Before charging, both sides must have been seen within `heartbeat_grace_s` (Redis
  `hb:{session}:{role}`, refreshed by socket traffic). If not, the session ends with
  `user_dropped`/`astrologer_dropped` at the last-seen time and nothing more is charged. This
  is how an API outage is handled: no minutes are charged for time the service was down beyond
  the grace period, and minutes already charged are never charged again.
- Insufficient funds for the next minute → end `insufficient_funds` at the minute boundary.
  When the wallet covers exactly one more minute after a charge → `low_balance` event.
- Free sessions end with `free_minutes_used` after `free_minutes`; the rest of the free lot
  expires at end (`wallet.close_session_lots`).
- Partial last minute is billed as a whole minute (stated on the price card).
- After a session ends, `refunds.on_session_end` runs (idempotent, audited).

## Chat WebSocket

`GET /v1/sessions/{id}/ws?ticket=…` on the API origin (`NEXT_PUBLIC_API_WS_URL`). The ticket is
single-use, 30 s, bound to (user, session, role), stored in Redis. The `Origin` header must be one
of `CORS_ORIGINS`. Bad ticket → close `4001`; not a participant → `4003`; a newer connection
for the same role → the older one closes `4009`; session over → `4000` after an `ended` event.

Frames are JSON. Server → client: `hello`, `state`, `message`, `typing`, `low_balance`, `ended`,
`error`, `pong` (shapes in `chat.ts`). Client → server: `message {client_id, text}` (1–2000
chars after trim; only while `active`, else `error session_not_active`), `typing`, `ping`
(every 20 s). Up to 5 messages per 5 s per sender, else `error rate_limited`.

Messages: assigned a per-session `seq`, stored encrypted (AES-256-GCM, random 96-bit nonce,
AAD = `{session_id}:{seq}`, key id stored per row for rotation), then fanned out through Redis
pub/sub channel `chat:{session_id}` so any API process can serve either side. A resent
`client_id` from the same sender returns the stored message (no duplicate). On reconnect a
client loads `GET …/messages?after_seq=` and resumes. System messages (`sender: "system"`)
mark start, low balance and end; their text is a code, never personal data: `session_started`,
`low_balance`, `session_ended:<end_reason>`.

## Admin (role `admin`)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/money/users/{user_id}/wallet` | `Wallet` + recent `WalletTxn` |
| GET | `/v1/admin/money/refunds` | `cursor` → refunds with rule, session, amount, actor, time |
| POST | `/v1/admin/money/refunds` | Idempotency-Key; `{session_id, amount_paise, note}` → manual goodwill refund (`refund:manual:{session_id}:{key}`), audited |
| GET | `/v1/admin/money/free-sessions` | claims with abuse score and reason, `flagged=true` filter |
| POST | `/v1/admin/money/free-sessions/override` | `{user_id, action: "allow"\|"block"\|"reset", note}`, audited |
| GET | `/v1/admin/money/reconciliation` | runs: `{date, status: ok\|drift\|error, drift_paise, checks: [...]}` |
| POST | `/v1/admin/money/reconciliation/run` | `{date}` → run now |
| GET | `/v1/admin/sessions` | recent sessions (no message content) |

## Reconciliation

`python -m astro_api.cli reconcile [--date YYYY-MM-DD]` (daily from cron/worker; default
yesterday IST). Checks: (1) every ledger transaction balances; (2) every balance projection and
promo lot equals the sum of its entries; (3) each captured gateway payment of the day has
exactly one recharge credit of the same amount and vice versa; (4) settlements: clearing →
bank postings match the gateway's settlement report. Any difference → run status `drift`, an
`error`-level log line `reconciliation_drift` (no personal data) for alerting, and the admin
page shows it. Test data must reconcile with zero drift.
