# ADR-0002: Wallet ledger design

- Status: **Accepted** (2026-10-21). Implemented in Phase 4, test-first (PLAN.md §0.3).
- Date: 2026-10-20

## Context

Users prepay a wallet in INR and spend it per minute on consultations. Some credit is promotional
(free first session, recharge bonuses) with a short expiry and no cash value. Astrologers earn a
share; the platform keeps commission. Payments arrive through Razorpay webhooks, which can
repeat, arrive out of order or arrive after the user has given up. Hard gates from the plan:
100 parallel debits never overdraw; the same webhook five times credits once; killing the API
mid-session neither gives away nor double-charges a minute; daily reconciliation shows zero drift.

## Decision

### 1. Double-entry, append-only, integer paise

- Two tables: `ledger_transactions` (one business event) and `ledger_entries` (its postings).
- Every amount is a `bigint` of **paise**. No floats or `numeric` with fractions anywhere in money code.
- Each entry has `account_id`, `direction` (`debit`|`credit`) and a positive `amount_paise`.
  Per transaction, sum of debits = sum of credits. A deferred constraint trigger enforces it at
  commit, and property tests check it.
- Rows are never updated or deleted. The application DB role has `INSERT` and `SELECT` only on
  these tables. Mistakes are fixed with a reversing transaction that references the original.

### 2. Accounts

| Account | Type | Normal balance | Notes |
|---|---|---|---|
| `user:{id}:real` | liability | credit | Money the user paid us and has not spent |
| `user:{id}:promo` | liability | credit | Promotional credit, tracked in lots with expiry |
| `astrologer:{id}:payable` | liability | credit | Earned, not yet paid out |
| `platform:commission` | revenue | credit | Our take |
| `platform:promo_expense` | expense | debit | Cost of promo credit spent on consultations |
| `platform:promo_expired` | contra-expense | credit | Promo credit that expired unused |
| `gateway:razorpay:clearing` | asset | debit | Money Razorpay owes us until settlement |
| `bank:settlement` | asset | debit | Settled funds (for reconciliation) |
| `platform:refunds` | expense | debit | Goodwill refunds beyond the original charge |

Tax (GST on commission vs gross) is not modelled until a CA confirms treatment (PLAN.md §7).
The account list is the place it will go.

### 3. Balances

`account_balances(account_id, balance_paise, version)` is a **projection**, not the source of
truth. It is updated in the same database transaction as the entries it summarises. Spending
locks the user's balance rows with `SELECT … FOR UPDATE` (always in a fixed order: real then
promo, to avoid deadlocks), checks funds, writes entries, updates the projection and commits.
A `CHECK (balance_paise >= 0)` on user accounts makes overdraft impossible even if code is wrong.
A nightly job recomputes every balance from entries and alerts on any difference.

### 4. Idempotency

Every write carries an idempotency key, stored with a `UNIQUE` constraint on
`ledger_transactions.idempotency_key`. A retry with the same key returns the original transaction.
Same key with a different payload is an error and an alert. Keys are deterministic:

| Event | Key |
|---|---|
| Recharge credited | `razorpay:payment:{payment_id}:captured` |
| Per-minute charge | `session:{session_id}:minute:{n}` |
| Promo grant | `promo:{campaign}:{user_id}` |
| Refund | `refund:{rule}:{session_id}` |
| Promo expiry | `promo_lot:{lot_id}:expire` |

Webhook handling: verify the Razorpay signature, record the raw event by its event id
(`UNIQUE`), then post the ledger transaction with the deterministic key. Five replays give one
event row and one credit.

### 5. Per-minute metering (crash-safe by construction)

A session is billed **one minute in advance**: before minute *n* starts, post
`session:{id}:minute:{n}`. If funds are short, the session ends before the minute starts, so
balance can never go negative and we never give a minute away. The server runs the meter, not
the client. After a crash, the meter resumes from the session's `started_at` and the highest
minute already posted. The idempotency key makes double-posting impossible. Partial last
minutes: billed as a whole minute (simple, common, stated in the price card), unless the
founder decides otherwise.

The warning at "1 minute left" fires when remaining funds cover exactly one more minute.

### 6. Real vs promo credit

- Promo credit is stored as **lots** (`promo_lots`: amount, remaining, expires_at,
  campaign) so expiry is exact. The lot table is a projection too; ledger entries remain the record.
- Default spend order: **promo first, earliest-expiring lot first**, then real. That uses
  short-lived credit before it lapses and keeps the user's real money intact longer.
  Decided by the founder on 2026-10-21 (PLAN.md §9.3). The order is one config value
  (`spend_order` in `data/marketplace/billing.json`) and is stated on the wallet page.
- A promo lot can be **restricted to one session** (the first free session). It is spent first in
  that session and is invisible to every other session; what is left expires when it ends.
- Promo postings:
  - grant: debit `platform:promo_expense`, credit `user:promo`
  - spend (per minute): debit `user:promo`, credit `astrologer:payable` and `platform:commission`
  - expiry: debit `user:promo`, credit `platform:promo_expired`

  Astrologers are paid the same for promo minutes as for paid ones.
- Real credit has a long expiry set by the published credit-expiry policy (Phase 7). Expiring
  real money has legal weight; the policy page and a lawyer decide the period.

### 7. Commission

Split at the moment each minute is posted, using the astrologer's tier rate captured on the
session row at start (`commission_bps`), so later rate changes never reprice past minutes.
Rounding: commission = floor(amount × bps / 10000); the astrologer gets the remainder, so the
two always sum to the charge.

## Alternatives considered

- **Single `wallets.balance` column updated in place.** Simple, but no audit trail, races
  unless locked, and impossible to reconcile. Rejected.
- **Signed amounts instead of debit/credit.** Equivalent in maths. The plan's schema names
  `direction`, and explicit direction reads better in audits. Kept direction.
- **Event-sourcing framework or external ledger (e.g. TigerBeetle, a ledger SaaS).** Strong, but
  one more system to operate for a solo team at our volume. Postgres row locks handle the
  load (one active session per user). Revisit above ~1k ledger writes/second.
- **Reserve/hold funds for the whole session up front.** Fewer writes, but holds must be
  released correctly on every failure path. Per-minute prepaid posting is simpler to make
  correct.

## Consequences

- Phase 4 tests come first: property tests (entries balance, projection = sum of entries),
  100-way concurrent debit test, webhook replay test, kill-mid-session test, reconciliation drift test.
- Postgres is the only money store. Redis may cache balances for display only, never for decisions.

## Implementation notes (Phase 4, 2026-10-21)

Code: `services/api/src/astro_api/{wallet,refunds,free_session,payments,payments_webhooks,
reconciliation,wallet_api,admin_money,billing_config}.py`, tables in `models_ledger.py`,
migration `0004`. Tests were written first (`tests/test_ledger*.py`, `test_wallet*.py`,
`test_payments.py`, `test_refunds.py`, `test_free_session.py`, `test_reconciliation.py`,
`test_admin_money.py`).

- **Database guards.** A `BEFORE UPDATE OR DELETE` trigger makes `ledger_transactions` and
  `ledger_entries` append-only; a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on both
  tables rejects, at commit, a transaction with no entries or with debits ≠ credits. Entries
  have `amount_paise > 0`; entries on `user:*:promo` must name their promo lot; user balance
  projections have `CHECK (balance_paise >= 0)`. The DB role split (INSERT/SELECT only) is still
  to be done when production roles exist; the trigger already blocks mutation for every role.
- **Which balances are projected.** `account_balances` holds user and astrologer accounts only.
  Platform, gateway and bank accounts are summed from entries when read: projecting them would
  make `platform:commission` one row that every charge in the system locks until commit.
- **Locking.** Every operation that touches a user's money first upserts and locks the user's
  `real` then `promo` balance rows (`SELECT … FOR UPDATE`), then the user's lots, then updates
  other projections in sorted order. The idempotency key is checked again after the lock, so a
  concurrent retry returns the original instead of failing on funds. Idempotent insert:
  `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`, then compare `payload_hash`.
- **Account added:** `platform:gateway_fees` (expense) for Razorpay fees and their GST deducted
  at settlement. Settlement posting (`razorpay:settlement:{id}`): debit `bank:settlement` (net),
  debit `platform:gateway_fees`, credit `gateway:razorpay:clearing` (gross).
- **Refund postings.** A refund of `A` paise on a session reverses that session's charges in
  proportion, with cumulative rounding so repeated partial refunds never exceed a bucket:
  promo share = floor((refunded + A) × promo_charged / charged) − promo_refunded; real gets
  the rest. The promo share comes back as a **new general promo lot** (`campaign: refund`,
  `promo_expiry_days`), real back to real. The debit side splits the same way between
  `astrologer:{id}:payable` and `platform:commission` (commission share by the same formula,
  astrologer the rest). Refunds never exceed what is left to refund on the session; manual
  goodwill above that is refused, so `platform:refunds` is not used yet (founder decision).
  Free sessions are never refunded (the user paid nothing).
- **Rules.** `astrologer_drop` refunds the minutes that started after the astrologer was last
  seen (the minute in progress counts as served). `low_rating` refunds
  min(cap, charged × refund_bps / 10000, left to refund), at most once per user per rolling
  30 days (counted under the user's wallet lock). Keys `refund:{rule}:{session_id}`, manual
  `refund:manual:{session_id}:{Idempotency-Key}`. Every refund has a `refunds` row and an audit
  entry with ids and amounts (the admin's note is kept on the row, never in audit or logs).
- **Free session lot.** Restricted to its session, spent first there, invisible elsewhere,
  closed by `close_session_lots` at session end, with a 1-day safety expiry. After an admin
  `reset` the grant key gets a suffix (`promo:free_session:{user}:reset{n}`) so the user can be
  granted again; otherwise it is once per user ever.
- **Promo expiry** is exact at spend time (expired lots are never spent) and posted by
  `python -m astro_api.cli expire-promo` (run it from cron, e.g. hourly). Real-credit expiry
  (`real_credit_expiry_days`) is not implemented until the Phase 7 policy review.
- **Reconciliation** matches gateway payments to recharge credits by payment id
  (`ledger_transactions.external_ref`) and by the gateway's payment time (`occurred_at`), so a
  webhook arriving after midnight still reconciles to the payment's day.

## Implementation notes (Phase 5 payouts, 2026-10-21)

Code: `services/api/src/astro_api/{earnings,payouts,payouts_api,portal_api}.py`,
`wallet.post_payout`, the `payouts` reconciliation check; table `payouts` in `models_portal.py`,
migration `0006`. Tests were written first (`tests/test_earnings.py`, `test_payouts.py`, the
payouts check in `test_reconciliation.py`).

- **Account added:** `bank:payouts` (asset, normal side debit): the account astrologer transfers
  leave from. Not projected (summed from entries when read).
- **Payout posting** (`kind = payout`, key `payout:{payout_id}`, `external_ref` = payout id,
  `astrologer_id` set): debit `astrologer:{id}:payable`, credit `bank:payouts`, both the
  payout's net. `wallet.post_payout` locks the astrologer's payable projection row
  (`SELECT … FOR UPDATE`), checks the key again under the lock, and refuses an amount above the
  projected payable balance (`PayoutExceedsPayable`, API `409 exceeds_payable`). The payout row
  is locked too, so concurrent or repeated mark-paid calls post once; the same reference and
  date again returns the paid payout. Migration 0006 adds `payout` to the transaction kinds
  (`models_ledger.TXN_KINDS`).
- **Earnings are read from the ledger only** (`earnings.py`): per transaction of kind
  `consultation`/`refund` that touches the astrologer's payable, by `occurred_at` on IST
  boundaries: gross = payable credit + commission credit of consultation transactions,
  commission = that commission credit, refunds = payable debit of refund transactions,
  net = gross − commission − refunds, minutes = consultation transactions, sessions = distinct
  sessions charged. A refund counts in the month it is posted (it can hit last month's session).
- **Carry-forward.** A payout's `carried_in_paise` = everything earned net of refunds before
  its period − the net of the astrologer's earlier payouts that are not void. A void payout
  (net below `payouts.min_payout_paise`, or voided by an admin) therefore flows into the next
  generation without any extra bookkeeping, earnings from before the first statement are
  included, and a debt (refunds after a payout) is recovered from the next one. The table
  enforces `net = gross − commission − refunds + carried_in` with a CHECK. To keep this exact,
  only ended months are generated, generation runs under an advisory lock, and an astrologer
  who already has a payout for a later period is skipped. Re-running regenerates drafts only.
- **Reconciliation** check 5 (`payouts`): every paid payout has exactly one `payout:{id}`
  transaction debiting its astrologer's payable and crediting `bank:payouts` by its net, and
  every payout posting belongs to a paid payout.
- **Tax.** TDS and GST are not modelled; statements and the payout view carry a `tax_note`
  saying so until a CA confirms treatment (PLAN.md §7).
