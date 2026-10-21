# ADR-0007: Consultation sessions, metering and chat transport

- Status: Proposed (2026-10-21). Implemented in Phase 4.
- Contract: docs/api/billing.md ("Sessions", "Metering", "Chat WebSocket"); shapes in
  packages/shared/src/chat.ts. Money side: ADR-0002.

## Context

A user requests a chat with an astrologer, may wait in a queue, and pays per minute from a
prepaid wallet while both people chat over a WebSocket. Hard gate: killing the API mid-session
must neither give away a minute nor charge one twice. The API runs as several processes, and
any of them can restart at any time. Chat text is personal data: it is encrypted at rest and is
never logged.

## Decision

### 1. State machine (session_service.py)

`queued → requested → accepted → active → completed`, and `cancelled` / `failed` as the other
end states. Every transition locks the session row (`SELECT … FOR UPDATE`) and re-checks the
status under the lock, so racing actors (two processes, a socket and the meter) are safe: the
loser sees the new status and does nothing. Create locks the astrologer row, so only one request
per astrologer can become `requested`. A new request is queued while the astrologer has a
requested, accepted or active session, or while others are already queued (first come, first
served). Promotion takes the same astrologer lock. A partial unique index allows at most one
open session per user; it backs up the API check.

Price and `commission_bps` (from `billing_config.commission_bps(tier)`) are copied onto the row
at creation. Create is idempotent twice over: the Redis response cache, plus
`UNIQUE(user_id, idempotency_key)` with a stored body hash, so a replay still works after Redis
loses the key.

Ending has two steps. `finish()` runs inside the transaction that ends the session: it sets the
status, reason and end time, closes the session's promo lot and writes a system message.
`after_end()` runs after that commit. It clears presence, promotes the queue, sends `ended` to
both sockets and applies the refund rules (in their own transaction), then sets `settled_at`.
Every one of these steps is idempotent. The meter re-runs `after_end()` for any ended session
that is still unsettled after 30 s, which covers a crash between the two steps.

### 2. Prepaid per-minute metering (billing_meter.py)

- Minute 1 is charged when the session activates (both sockets connected after accept). If the
  wallet can no longer cover it, the session ends `cancelled/insufficient_funds`. Minute n+1 is
  due at `started_at + n × minute`. Its key is `session:{id}:minute:{n}`, and it is posted by
  `wallet.charge_minute` in the same transaction that sets `billed_minutes = n`.
- `billed_minutes` (the highest minute posted) and `started_at` are all the meter needs.
  Nothing held in memory affects correctness, so a restarted process carries on where the dead
  one stopped. If a process dies in the middle of a charge, its transaction rolls back and the
  next meter posts the same key once.
- Every process runs the loop. Each tick works through its candidate sessions one at a time
  with `FOR UPDATE SKIP LOCKED`, so two meters never work on the same session at once. The
  ledger key makes a double charge impossible even if they did.
- An empty wallet ends the session at the minute boundary (`insufficient_funds`), and the
  balance never goes negative. Free sessions end at `free_minutes` (`free_minutes_used`), even
  when the user has money, and the rest of their lot expires. `low_balance` (event plus system
  message) fires once, after the charge that leaves exactly one minute covered. A partial last
  minute is billed in full.
- The loop is skipped when `meter_tick_seconds <= 0`, and in `APP_ENV=test` unless
  `app.state.meter_enabled` is set. Tests call `tick(app_or_deps, now=…)` with an injected clock.

### 3. Heartbeats, grace and outages

`hb:{session}:{role}` holds the epoch time each side was last seen. Any socket frame refreshes
it (clients ping every 20 s), and it never moves backwards. Before charging, both sides must
have been seen within `heartbeat_grace_s`. If one side was not, the session ends
`user_dropped`/`astrologer_dropped` at that side's last-seen time, and no minute that starts
later is charged.

API outage: when every process is down, nobody refreshes heartbeats. If the clients reconnect
before the first tick of the new process, the bare timestamp would look fresh again. To catch
that, the heartbeat write is a Lua script: when it finds the previous value older than the grace
period, it records that value in `hbgap:{session}:{role}` (the first gap wins). The meter treats
a gap that falls after `started_at` as a drop at that time. So an outage shorter than grace
continues the session, and the minutes that started during it are charged once on restart. An
outage longer than grace ends the session at the last-seen time and charges nothing for the
outage. The meter copies the last-seen times into `user_last_seen_at`/`astrologer_last_seen_at`
on the row, which feeds the refund rules and serves as a fallback if Redis loses the keys.

Accepted limitation: if Redis loses its data during an API outage and the clients reconnect
before the first tick, that gap cannot be seen. Minutes owed under the rules are still charged
at most once.

### 4. Presence

While a session is accepted or active, `presence:{astrologer}` = `busy` and `busy_until` = the
end of the minutes the client's wallet covers. Both are refreshed after every charge. On end,
`busy` is deleted only if it is still `busy` (Lua compare-and-delete), and only when the
astrologer has no other accepted or active session. The console's next presence heartbeat sets
`online` again, because `set_presence` never overrides `busy`, so no new presence path is
needed. Queue ETA uses only known facts: the time left in `busy_until` plus
`average_session_minutes` for each request ahead. It is null when `busy_until` is unknown.

### 5. Chat transport (chat_ws.py, chat_bus.py)

- FastAPI WebSockets, with fan-out through Redis pub/sub on `chat:{session}`. Each socket
  subscribes to its own session's channel, so the two sides may be on different processes.
  `conn:{session}:{role}` names the socket that owns a role. A newer socket publishes
  `replace`, and the older one closes with 4009. Activation needs both `conn` keys.
- Messages get a `seq` from an atomic
  `UPDATE … SET last_seq = last_seq + 1 WHERE status='active' RETURNING`. They are deduplicated
  by `UNIQUE(session_id, sender, client_id)`, so a resend returns the stored copy to the sender
  only. Limits: 1–2000 characters, 5 messages per 5 s per sender (Redis window).
- **WS tickets** (ws_tickets.py): browsers cannot send headers on a WebSocket, and a bearer
  token in a URL ends up in logs. A ticket is random, single-use (`GETDEL`), lives 30 s,
  is bound to (user, session, role), and only its SHA-256 is stored. `Origin` must be in
  `CORS_ORIGINS`; a bad or missing Origin is refused at the handshake (HTTP 403). A bad ticket
  is accepted and then closed with 4001, so the client knows to fetch a new one.

### 6. Encryption at rest and key rotation (chat_crypto.py)

AES-256-GCM, a random 96-bit nonce per message, and AAD `{session_id}:{seq}`, so a ciphertext
cannot be moved to another row. `key_id` is stored per row. `MESSAGES_KEY` is either one base64
key (its id is `MESSAGES_KEY_ID`) or `id:b64,id:b64,…`, where the first key encrypts and the
others only decrypt. To rotate, prepend a new key. A later re-encryption job can then retire
the old one. In development and test, an empty key is derived from `SECRET_KEY` with
HKDF-SHA256 (id `dev`), and a warning is logged. Production refuses to start without
`MESSAGES_KEY`. System messages carry codes such as `session_started`, `low_balance` and
`session_ended:<reason>`, never personal data.

## Alternatives considered

- **A single leader process runs the meter (Redis lock).** Simpler to reason about, but it is a
  failover problem in its own right. Row locks plus idempotent keys make every process safe.
- **Bill from socket connection time after the fact.** That bills afterwards, can go negative,
  and loses track when a process crashes. Rejected in favour of prepaid minutes (ADR-0002 §5).
- **Server-Sent Events plus POST for chat.** Workable, but typing indicators and acknowledgements
  are simpler over one socket, and the voice phase will need a socket anyway.
- **Bearer token in the WS query string.** It leaks into proxy and access logs. Tickets instead.
- **`ALTER TYPE … ADD VALUE` for the new statuses.** It cannot be used in the same transaction
  as the partial index. The migration recreates the enum instead, which keeps it transactional
  and makes the downgrade the mirror image.

## Consequences

- Hard-gate tests: `tests/test_session_crash.py` covers a kill mid-session including a
  rolled-back charge, a long outage with and without reconnect, and two meters at once. They
  run against the in-memory fake and against the real ledger (`SESSION_TESTS_MONEY=real`).
- When a side drops, minutes inside the grace window are charged. The `astrologer_drop` refund
  rule returns the astrologer side's share of them.
- Redis is needed for chat, presence and heartbeats, but not for money correctness.
