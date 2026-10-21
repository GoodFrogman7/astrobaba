# Admin console

Internal Next.js app, English only, never indexed. Sign-in is phone OTP through the core API;
only users with the `admin` role see anything.

- `/astrologers`: application and KYC queue by status, astrologer detail with documents,
  verification checklist (identity → qualification → interview → probation), approve with
  tier + price, suspend / reinstate / reject, flags, audit trail
- `/reviews`: review moderation (flagged first)
- `/horoscopes`: horoscope prose review queue (approve, edit, reject), ADR-0005
- `/`: counts of pending work
- `/sessions`: recent consultation sessions (metadata only; message content is never shown)
- `/money/refunds`: refund list (rule, session, amount, actor, time) and a two-step manual
  goodwill refund. The Idempotency-Key is created with the form, reused when the outcome is
  unknown (timeout, 5xx) and replaced after any definite answer
- `/money/free-sessions`: first-free-session claims with abuse score and reasons, flagged
  filter, allow / block / reset overrides with a note (audited)
- `/money/payouts?period=YYYY-MM&status=`: monthly payout statements
  ([portal.md §3](../../docs/api/portal.md)) with status filter and totals; "Generate for
  period" (ended IST months only, confirm). `/money/payouts/<id>`: totals, session lines, bank-detail placeholders and the
  next step only: Approve (draft), Mark paid with bank reference + paid-on date (approved; spells
  out the `payout:{id}` ledger posting), Void with a note (draft/approved). API errors such as
  `409 exceeds_payable` are shown in plain words. Bank transfers themselves are manual.
- `/money/reconciliation`: daily runs (ok / drift / error, drift amount, checks), "Run now"
- `/money/wallets?user_id=`: balances, promo lots and recent transactions for a user

- `/moderation?kind=report|safety|refused&status=open|closed`
  ([trust.md §4](../../docs/api/trust.md)): client reports, safety flags and refused astrologer
  messages with astrologer, reason codes, counts, session id and time; never chat text by
  default. A safety item has "Reveal flagged message" behind an explicit confirm ("This is
  logged with your name"; `GET /v1/admin/moderation/{id}/message`, kept only in the open page
  until hidden). Open items take dismiss / warn / suspend with a required note and a confirm
  step that spells out the effect (`suspend` is the normal astrologer suspension; `warn` records
  a strike the astrologer sees on their Conduct page).
- `/privacy/deletions` ([trust.md §2](../../docs/api/trust.md)): account deletion requests
  (requested at, user id linked to the wallet view, open sessions, wallet balance) and Execute
  with a confirm that spells out what is deleted and kept. `409 balance_outstanding` and
  `409 session_open` are shown in plain words with what to do (settle the balance manually
  first; wait for the session to end).

Money stays integer paise in code; `formatRupees` is used only for display.

Run: `API_URL=http://localhost:8000 pnpm --filter @astro/admin dev` (port 3001).
Grant a role: `uv run python -m astro_api.cli grant-role <phone> admin`.
