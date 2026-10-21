# Chat load test

Contract: `docs/api/growth.md` §6 (PLAN §7: 500 concurrent chat sessions before launch).
Workspace member `astro-loadtest`; run everything from the repo root.

```
uv run python -m loadtest seed  --sessions N [--credit-minutes 60]
uv run python -m loadtest run   --sessions N --minutes M [--api URL] [--origin URL]
                                [--interval 5] [--ramp S] [--end-margin 10] [--timeout 30]
uv run python -m loadtest clean
```

The tool reads the same settings as the API (`DATABASE_URL`, `REDIS_URL`, `APP_ENV`,
`BILLING_MINUTE_SECONDS`, from the environment or `.env`). Point them at the database the API
under test uses.

Local state goes to `LOADTEST_DIR` (default `<system temp>/astro-loadtest`, mode 0700; refused
inside the repository): `state.json` (the synthetic users' bearer tokens, mode 0600) and one
`report-<UTC time>-<N>.json` per run. Never commit either file.

## What each command does

**seed**: refused unless `APP_ENV` is `development` or `test`. Writes straight to the database:

- N clients and N astrologers (`status=approved`, `is_seed=true`, shown as `is_demo`, tier
  `rising` at its minimum price, chat enabled). Phones start `+91000019` (never a real mobile,
  and not the `+9100000` prefix of `astro_api.seed`, which deletes its own rows on re-seed); slugs
  start `loadtest-`.
- The consents the API requires at the current `policies.json` version (`consent.record`):
  `age_18`, `terms`, `privacy`, and also `astrologer_terms` for astrologers.
- Wallet credit through the ledger only: `wallet.grant_promo`, campaign `loadtest`, idempotency
  key `loadtest:credit:{user_id}`, expiring after 7 days so leftovers lapse even without `clean`.
  Covered by `tests/test_seed_credit.py`, written first: the balance equals the credit, every
  transaction sums to zero, and a repeat posts nothing.
- One bearer session per user, made the way `auth.verify_otp` makes it (random token, only
  `hash_token(token)` stored, 2-day expiry). Tokens go only into `state.json`.

**run**: refused when `APP_ENV` is `production`. Uses only the public API. Per pair, with session
starts spread over `--ramp` seconds (default N/10, at most 60):

1. astrologer `POST /v1/astrologer/me/presence {status: online}`;
2. client `POST /v1/sessions` (Idempotency-Key) → `requested`;
3. astrologer `GET /v1/astrologer/me/sessions/incoming`, then `POST /v1/sessions/{id}/accept`;
4. both `POST /v1/sessions/{id}/ws-ticket`, then open `GET /v1/sessions/{id}/ws?ticket=` with
   `Origin: --origin` (must be in the API's `CORS_ORIGINS`) and wait for `hello`;
5. once both see `active`, each side sends a fixed text every `--interval` seconds (the two sides
   are offset by half an interval) and pings every 20 s;
6. at `M` minutes minus `--end-margin` the client calls `/end`, and both sides must receive
   `ended`. The astrologer then goes offline. A pair that failed part-way cancels or ends its
   session, so nothing stays open.

Measured: connect time (ticket request until `hello`), accept until both sides see `active`,
message round trip (send until the other side receives the `message` event, on one process
clock), HTTP latency per endpoint, errors by type, billed minutes and active seconds.

Then it checks invariants read-only from Postgres (`verify.py`):

- every ledger transaction in the database balances (debits = credits);
- for each session of the run: `billed_paise = billed_minutes × price`, the user-side debits of
  its `consultation` transactions add up to the same amount, and there is one charge per minute
  with keys `session:{id}:minute:1..n`;
- each run client's balance projections equal the sum of their ledger entries.

It prints a short report and writes the JSON. The exit code is 0 only when the run passes:
no errors, every session completed, round-trip p95 under `--p95-target-ms` (default 500) and
the invariants hold. Message text is a constant and is never logged or stored by the tool.

The default `--end-margin 10` ends sessions 10 s before a minute boundary. Ending right at a
boundary races the meter, which charges minute n+1 on its first tick after the boundary
(`meter_tick_seconds`). The report lists those cases under `billing_vs_active_time`.

**clean**: refused unless `APP_ENV` is `development` or `test`, and while any load-test session
is still open (the meter ends those; run clean again afterwards). It finds the rows by their tags,
not by the state file.

- Removed: chat messages of load-test sessions, the users' auth sessions, astrologer presence
  keys in Redis, and the local `state.json`.
- Forfeited: leftover credit, through the ledger's own promo expiry (`promo_lot:{id}:expire`,
  the call account deletion uses).
- Hidden: astrologer profiles get `chat_enabled=false` and `show_in_directory=false`.
- Kept, and why: users, consents, ledger rows and consultation rows. Ledger and consents are
  append-only and reference the users. Consultation rows hold the money facts the ledger points
  to. This is the same split as account deletion (`privacy.execute_deletion`).

## Local run

```
# API under test (own database and Redis db; dev values only, nothing committed)
export DATABASE_URL=postgresql+asyncpg://USER:PASS@localhost:5432/astro_lt REDIS_URL=redis://localhost:6379/9
export APP_ENV=development LOG_LEVEL=WARNING MESSAGES_KEY=$(python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")
(cd services/api && uv run alembic upgrade head)
(cd services/api && ulimit -n 20000 && uv run uvicorn astro_api.main:app --port 8100 --no-access-log --log-level warning) &

uv run python -m loadtest seed --sessions 10
uv run python -m loadtest run --sessions 10 --minutes 2 --api http://localhost:8100
uv run python -m loadtest clean
fuser -k 8100/tcp
```

Raise `ulimit -n` for the API and the tool (the tool raises its own soft limit to the hard
limit). Each session holds two sockets, and on the API side each socket holds one Redis pub/sub
connection.

## Staging procedure (launch gate: 500 sessions)

1. Freeze deploys to staging for the window. Make sure the reconciliation job does not run
   against staging during the test.
2. Seed from a trusted shell that can reach the staging database. Today `seed` refuses any
   `APP_ENV` other than `development`/`test`, and the API hides `is_seed` astrologers whenever
   `APP_ENV` is `staging` or `production` (`marketplace.is_public`), so the session request would
   get a 404. Until a staging mode is decided (see "Open points"), run the gate on a
   production-like environment with `APP_ENV=development`: same build, real Postgres and Redis
   sizes, `BILLING_MINUTE_SECONDS=60`, a real `MESSAGES_KEY`, several API processes behind the
   load balancer.
3. `uv run python -m loadtest seed --sessions 500 --credit-minutes 30`
4. Warm up: `run --sessions 50 --minutes 2`.
5. Gate: `run --sessions 500 --minutes 5 --api https://<staging api> --origin https://<web origin>`
   from a load-generator host with `ulimit -n` of 65535 or more. Run it twice.
6. Pass criteria: zero errors (`errors_total = 0`, `completed = 500`), round-trip p95 < 500 ms,
   invariants OK (no unbalanced transactions, every session's charge = billed minutes × price,
   projections = entries). Also run `python -m astro_api.cli reconcile` for the day: zero drift.
7. During the run, watch API CPU and event-loop lag, Postgres connections (`pg_stat_activity`)
   and pool waits, Redis connected clients, and meter tick duration (it should stay well under
   `meter_tick_seconds` × a few).
8. `uv run python -m loadtest clean`, then attach the report JSON to the launch checklist.

## Open points

- `growth.md` §6 says the tool is refused only in production and targets staging. This tool's
  seed refuses everything except development/test, and `is_public` hides `is_seed` astrologers
  on staging. Pick one: a `LOADTEST_ALLOW_STAGING` override plus non-`is_seed` load-test
  astrologers on a closed staging, or document that the gate runs on a production-like
  environment with `APP_ENV=development`.
