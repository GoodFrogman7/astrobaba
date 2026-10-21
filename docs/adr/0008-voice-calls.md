# ADR-0008: Voice calls as in-app VoIP through LiveKit (not masked PSTN)

- Status: Proposed (2026-10-21). Implemented in Phase 5.
- Contract: docs/api/portal.md §1; shapes in packages/shared/src/chat.ts (`SessionKind`,
  the `call` socket event, `CallToken`). Builds on ADR-0007 (sessions, meter, socket) and
  ADR-0002 (ledger).

## Context

Phase 5 adds paid voice consultations. PLAN.md §2 already chose "LiveKit in-app VoIP" for this
and left PSTN and masked-number calling for later. This record says why, and how a call fits
the session and metering design without a second billing path. The constraints are the same as
for chat: prepaid per-minute billing with no free or double minutes, the astrologer never sees
the client's phone number or name, and nothing said in a consultation is stored or logged.

## Options

1. **In-app VoIP (WebRTC) through an SFU we control: LiveKit.** Both people call from the web
   app or console, in the browser. Audio goes browser → LiveKit → browser.
2. **Masked PSTN.** A telephony provider bridges two real phone calls through a virtual number,
   so neither side sees the other's number (the teardown's model).
3. **Peer-to-peer WebRTC with our own signalling.** No media server, but NAT traversal needs
   TURN anyway, and the server has no reliable view of who is still connected.

## Decision

Option 1, with LiveKit (open source, Apache-2.0), self-hosted in development and either
self-hosted or LiveKit Cloud in production. `livekit-api` is the only dependency on our side.

### Why not PSTN at launch

- **Privacy is easier.** With VoIP nobody's phone number is involved at all. Masking needs
  a provider, virtual numbers, and care that numbers never leak in CDRs, SMS or support tools.
- **Regulation.** DND/NCPR preferences and TRAI's commercial-communication rules (TCCCPR) are
  about calls and SMS over telecom networks to phone numbers. An in-app audio session that the
  user starts, between two signed-in accounts, places no call to anyone's number, so in our
  reading those rules do not apply to it. Masked PSTN would place real calls to real numbers
  and needs that analysis (and possibly DLT registration for related SMS). The Phase 7 lawyer
  review should confirm this reading.
- **Billing stays in one place.** Our meter is the source of truth for minutes (ADR-0007). A
  telephony provider has its own call timers and per-minute costs, which we would have to
  reconcile against our ledger.
- **Cost and lock-in.** PSTN costs a per-minute telephony charge on both legs plus number
  rental. VoIP costs bandwidth (self-hosted) or LiveKit Cloud's usage pricing; with only two
  audio-only participants per room the load is small. Check current LiveKit Cloud pricing
  before choosing between self-hosting and Cloud; the code is the same for both.
- Trade-off accepted: both people need the app open and a data connection. Users who would
  rather take a normal phone call cannot, until PSTN is added (see below).

### How a call works (portal.md §1)

- **A call is a session** with `kind: "call"`. Create, queue, accept/decline, the prepaid
  per-minute meter, insufficient funds, free first session, refunds and reviews are all the
  ADR-0007 machinery, unchanged. Price per minute is the same as chat. Create refuses with
  `409 call_unavailable` unless the `voice_calls` flag is on and the astrologer's
  `flags.call_enabled` is true.
- **Join tokens.** `POST /v1/sessions/{id}/call-token` (accepted or active calls only) returns a
  LiveKit JWT signed with the API secret: identity = the role (`user`/`astrologer`, never a
  phone or a name), room `session-{id}`, grants join + subscribe + publish **microphone only**
  (`canPublishSources: ["microphone"]`), no data channel, no room admin, no metadata, TTL 10
  minutes (only needed to join; a rejoin asks again). The token also carries the room settings
  (two participants, closes when empty), and the API creates the room up front so production
  LiveKit can run with automatic room creation off.
- **Liveness from three sources.** The control socket (the same chat socket, with text refused:
  `call_has_no_text`) stays the heartbeat, exactly as for chat. In addition, LiveKit's signed
  webhooks say who is in the audio room: `participant_joined`, `participant_left`,
  `participant_connection_aborted`. They are kept in Redis per role
  (`call:{session}:{role}`: state, participant sid, event time) and sent to both sockets as
  `{type: "call", joined: {user, astrologer}}`. Third, the meter asks LiveKit who is in the
  room before charging each call minute (below).
  - **Activation** needs both sockets connected **and** both participants in the room. Minute
    1 is charged only then, so nobody pays for time spent waiting for the other side's audio.
  - **A side that leaves the room** counts as last seen at the time it left, even though its
    socket is still open. The meter then ends the call `user_dropped`/`astrologer_dropped` at
    that time once `heartbeat_grace_s` has passed, unless the side rejoined. A rejoin after
    the grace period (before a meter looked) is recorded as a gap, like a heartbeat gap in
    ADR-0007 §3, so the call still ends at the leave time. The `astrologer_drop` refund rule
    applies as for chat.
  - **The meter checks with LiveKit before charging.** Before charging the next minute of an
    active call, the meter lists the room's participants (`ListParticipants`). It does this at
    most once per call per minute boundary, for all due calls at once, each with a 2-second
    timeout, so one slow call cannot hold up the tick for the others. A call minute is charged
    only when a successful listing covers it. State lives in Redis (`callver:{session}`:
    `ok_upto`, `last_try`, `fail_since`).
    - Both roles listed: the minute is charged as before.
    - A role is missing: that side is marked as having left at the time of the check, through
      the same path as a `participant_left` webhook. The grace period still applies, so a
      brief reconnect is not penalised. A rejoin webhook from a new connection counts even if
      its one-second timestamp is earlier than the check.
    - LiveKit is unreachable, errors or times out: nothing is charged, and the check is
      retried once a minute. If it answers again within `heartbeat_grace_s`, billing
      continues, and the minutes that started in between are charged once. If it stays
      unanswerable for longer than that, the call ends at the time the checks first failed.
      The end reason is `service_unavailable` (migration 0007): it is our outage, so it is
      never counted against the astrologer, and its own refund rule (`service_unavailable`
      in billing.json) refunds minutes charged after presence was last confirmed. The audit
      log also records `session.call_unverified` with the time checks first failed.
  - **Webhook hygiene.** The JWT in `Authorization` is checked with `livekit-api`'s
    `TokenVerifier`/`WebhookReceiver` (issuer = API key, HS256 with the secret, and the
    `sha256` claim must equal the SHA-256 of the raw body). A bad or missing signature returns
    401 and changes nothing. Each event id is processed once (Redis, 24 h). Events are ordered
    by LiveKit's own timestamp, and the late `participant_left` of a connection that was
    replaced by a newer one with the same identity (a second device) is ignored by comparing
    participant sids. Unknown rooms and events get 200 and are ignored.
- **Ending.** Every end path (user or astrologer end, insufficient funds, free minutes used,
  drop, join timeout, cancel after accept, activation without funds) goes through
  `after_end()`, which for a call deletes the LiveKit room. That disconnects both sides at once,
  so no audio continues unbilled after the money runs out. The delete is best effort with a
  short timeout: it never delays or reverses the end. If it fails, `settled_at` stays empty and
  the meter's settle sweep retries it. If someone joins with a still-valid token after the end,
  the `participant_joined` webhook deletes the room again.
- **No recording.** Audio passes only through LiveKit's SFU. We do not enable egress, store or
  transcribe it, and tokens cannot publish data. Our servers see only join and leave events.

### Configuration

`LIVEKIT_URL` (server API, e.g. `http://livekit:7880`), `LIVEKIT_PUBLIC_URL` (`wss://…` for
browsers), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (at least 32 characters), and LiveKit's
webhook URL set to `{API}/v1/calls/livekit/webhook`. Production refuses to start with
`voice_calls` on and these missing (config.check_production_settings). Without keys, in
development and test only, the API uses an in-memory fake (`livekit_client.FakeCalls`) that
signs and verifies with the same code. Recommended production LiveKit settings: TLS (wss),
TURN/TLS on 443 for restrictive networks, `room.auto_create: false`, and webhooks pointing at
the API.

## Alternatives considered

- **Bill from LiveKit's room or participant durations after the call.** That is post-paid, can
  go negative, and adds a second clock. Rejected, as for chat (ADR-0007).
- **Only the socket as liveness.** A user whose audio dropped but whose tab stays open would
  keep paying. The webhooks close that gap.
- **Only webhooks as liveness.** If webhooks stopped arriving (LiveKit down, network partition),
  nothing would end the call. The socket stays the primary heartbeat.

## Consequences and limits

- If LiveKit dies without sending `participant_left`, no further minute is charged: the
  meter's room listing fails, and the call ends at the first failed check after the grace
  period. The cost is one `ListParticipants` request per call per minute.
- Minutes inside the grace period after a side has left (by webhook or by listing) are still
  charged, exactly as for a dropped chat. The `astrologer_drop` refund rule returns the
  astrologer side's minutes.
- Webhook timestamps have one-second resolution, so a drop time is accurate to about a second.
- Join tokens are bearer credentials for 10 minutes. They are returned only to the session's
  participants over authenticated HTTPS, and they are never logged.

## Later: what PSTN would need

A telephony provider with Indian virtual numbers and a click-to-call or bridge API, a
`kind: "phone"` session that bills from our meter with the provider's call events as liveness
(the same shape as the LiveKit webhooks here), per-minute telephony cost in the price card or
commission, consent and DND/TCCCPR analysis, DLT registration for any SMS, number-masking
guarantees in CDRs and support tools, and reconciliation of the provider's invoices against
the ledger.
