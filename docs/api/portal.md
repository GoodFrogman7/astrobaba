# Voice calls, astrologer portal and payouts API (Phase 5)

Extends [billing.md](billing.md) (sessions, meter, socket) and [marketplace.md](marketplace.md).
Decisions: ADR-0008 (in-app VoIP with LiveKit). Money is integer paise; instants UTC ISO-8601;
schedules and statement periods are in **IST** (`Asia/Kolkata`). Errors: `{"detail": {"code",
"message", ...}}`. Shared TypeScript shapes: `packages/shared/src/chat.ts` and
`packages/shared/src/portal.ts`.

## 1. Voice calls

Flag `voice_calls` (off by default; on in the dev stack). An astrologer takes calls only when
`flags.call_enabled` is true (they set it in the portal, §2.4) **and** the flag is on.

A call is a consultation session with `kind: "call"`. Everything in billing.md applies
unchanged: create (Idempotency-Key, same checks, same price per minute as chat), queue,
accept/decline, prepaid per-minute meter, insufficient funds, free first session, refunds,
reviews. Differences:

| | Chat | Call |
|---|---|---|
| Create | `{kind: "chat"}` | `{kind: "call"}`; `409 call_unavailable` when the flag is off or the astrologer has `call_enabled` false |
| Control socket | the chat socket | the **same** socket (ticket, Origin check, `hello`/`state`/`low_balance`/`ended`, `ping`). Text `message` frames are refused on calls (`error call_has_no_text`). It is the heartbeat for the meter, so both apps keep it open during the call. |
| Audio | none | LiveKit room `session-{id}`; join with a token from `POST /v1/sessions/{id}/call-token` |
| Becomes `active` | both sockets connected | both sockets connected **and** both participants joined the LiveKit room (LiveKit webhook `participant_joined`) |
| Side gone | socket silent > `heartbeat_grace_s` | the same, **or** LiveKit `participant_left` / `participant_connection_aborted` and not back within `heartbeat_grace_s`; ends `user_dropped`/`astrologer_dropped` at the time it left. Before each minute the meter also asks LiveKit who is in the room; if LiveKit cannot answer, nothing is charged and after `heartbeat_grace_s` the call ends `service_unavailable` at the first failed check |
| On end | `ended` event, sockets close | the same, and the server deletes the LiveKit room, which disconnects both sides at once (no unbilled audio after funds run out) |

`POST /v1/sessions/{id}/call-token` (participant, `kind=call`, status `accepted` or `active`) →
`{url, token, room, identity, expires_in}`. `url` is the browser-facing LiveKit URL
(`LIVEKIT_PUBLIC_URL`). Token: identity is the role (`user` or `astrologer`, never a phone or
name), room `session-{id}`, grants join + publish **microphone only** + subscribe, no data
publishing, no room admin, TTL 10 minutes (only needed to join; a rejoin gets a new token).
`409 session_not_joinable` otherwise.

New control-socket event: `{type: "call", joined: {user: bool, astrologer: bool}}`, sent
right after `hello` on a call socket and whenever either side joins or leaves the audio room.

`POST /v1/calls/livekit/webhook`: LiveKit's signed webhook (JWT in `Authorization`, checked
with the API secret, body SHA-256 must match; bad or missing → `401 bad_signature`, nothing
changes). Unknown rooms and events are ignored with 200. Events are idempotent by LiveKit event
id (Redis, 24 h); a repeat → `200 {"status": "duplicate"}`. A join into a call that has already
ended deletes the room again.

No recording. Audio never passes through or is stored by our servers beyond LiveKit's SFU.

## 2. Astrologer portal (signed-in astrologer; `404 not_applied` otherwise)

### 2.1 Availability schedule

`GET /v1/astrologer/me/availability` → `{timezone: "Asia/Kolkata", slots: [Slot]}`.
`PUT /v1/astrologer/me/availability` `{slots: [Slot]}` → same (replaces all; max 21 slots).
`Slot`: `{weekday: 0-6 (0 = Monday), start: "HH:MM", end: "HH:MM"}`, IST, `start < end`, 15-minute
steps, no overlaps on a weekday (`422 invalid_slots`, with the index). An overnight shift is
two slots.

The schedule is informational: it does **not** set presence (the online toggle does). The
public profile shows it (`Profile.availability`: same `{timezone, slots}`; empty → not shown),
and the console reminds the astrologer when a slot starts while they are offline.

### 2.2 Consultation settings

`GET /v1/astrologer/me/consult` → `{chat_enabled, call_enabled, voice_calls_available}`.
`PATCH /v1/astrologer/me/consult` `{chat_enabled?, call_enabled?}` → same; audited.
`call_enabled: true` while the flag is off → `409 call_unavailable`. Price and tier stay
admin-only.

### 2.3 Earnings

`GET /v1/astrologer/me/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD` (IST dates, inclusive, ≤ 366
days; default: current IST month) →
`{from, to, totals: Totals, by_day: [{date, ...Totals}], sessions: {items: [EarningRow],
next_cursor}}` with `cursor`, `limit` for sessions.
`Totals`: `{gross_paise, commission_paise, refunds_paise, net_paise, sessions, minutes}`.
`gross` = consultation charges (real + promo; astrologers are paid the same for promo minutes),
`commission` = platform share, `refunds` = the astrologer's share of refunds posted in the
period, `net = gross − commission − refunds`. All figures come from ledger entries on
`astrologer:{id}:payable` and the matching commission postings, never from session rows.
`EarningRow`: `{session_id, kind, started_at, ended_at, billed_minutes, gross_paise,
commission_paise, refunds_paise, net_paise, client_label}`.

`GET /v1/astrologer/me/balance` → `{payable_paise, last_payout: {period, net_paise, paid_at} |
null}`.

### 2.4 Reviews

`GET /v1/astrologer/me/reviews?cursor&limit&filter=all|unreplied` → `{items: [Review +
{session_id, status}], next_cursor}` (published and held, never removed ones; no client
identity). Reply: existing `POST /v1/reviews/{id}/reply` (once; moderated like reviews).

### 2.5 Payout statements

`GET /v1/astrologer/me/payouts` → `{items: [Payout]}` newest first.
`GET /v1/astrologer/me/payouts/{id}` → `Payout + {lines: [EarningRow], adjustments: [...]}`.
`GET /v1/astrologer/me/payouts/{id}/statement.csv` → CSV (one row per session + totals).

## 3. Payouts (monthly; transfers are manual in v1)

`Payout`: `{id, period: "YYYY-MM", status: draft|approved|paid|void, gross_paise,
commission_paise, refunds_paise, net_paise, carried_forward_paise, sessions, minutes,
generated_at, approved_at, paid_at, reference (bank UTR, paid only)}`.

Fields added by the implementation: `carried_in_paise` (earned before the period and not yet
paid out: every earlier void payout plus earnings before the first statement, minus refunds
after a payout, so it can be negative), `void_reason` (`below_minimum` | `admin`), `paid_on`,
`tax_note`. `net = gross − commission − refunds + carried_in`. Detail `adjustments`:
`{kind: carried_forward_in | carried_forward_out, amount_paise, period}`. Generate returns
`{period, generated, updated, skipped, carried_forward}`; only ended IST months
(`422 period_open`). Wrong-status approve / mark-paid / void → `409 invalid_transition`. A UTR is
`[A-Za-z0-9-]{6,40}` (`422 invalid_reference`); `paid_on` cannot be in the future. Held reviews
in the portal list show rating and status with `text: null`. CSV cells that start with
`= + - @`, tab or CR are prefixed with `'`.

Generation: `python -m astro_api.cli payouts generate --period YYYY-MM` (worker cron on the 1st,
for the previous IST month) and `POST /v1/admin/payouts/generate {period}`. One payout per
astrologer per period (UNIQUE); re-running regenerates only `draft` rows. Totals come from the
ledger for the IST month. Net below `min_payout_paise` (billing.json) is carried forward to the
next period (`status: void`, `carried_forward_paise`), never lost.

Admin (`admin` role, audited): `GET /v1/admin/payouts?period&status`,
`POST /v1/admin/payouts/{id}/approve`, `POST /v1/admin/payouts/{id}/mark-paid {reference,
paid_on}` → posts the ledger transaction `payout:{payout_id}` (debit
`astrologer:{id}:payable`, credit `bank:payouts`), `POST /v1/admin/payouts/{id}/void {note}`
(draft or approved only). `GET /v1/admin/payouts/{id}` = the astrologer view plus bank-detail
placeholders. Paying more than the payable balance is refused (`409 exceeds_payable`).
Tax deduction at source (TDS) and GST are **not** modelled until a CA confirms treatment
(PLAN.md §7); statements say so.

Reconciliation adds a check: every `paid` payout has exactly one `payout:` ledger transaction
for its net amount.
