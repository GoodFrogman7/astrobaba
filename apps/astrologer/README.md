# Astrologer portal

Next.js portal for live astrologers. English only, never indexed (`X-Robots-Tag`, `robots.txt`
disallow all, `noindex` metadata), never framed. Port 3002.
Navigation: Console, Schedule, Earnings, Payouts, Reviews, Settings, History.

- `/login`: phone OTP through the core API. The session token lives only in an httpOnly,
  SameSite=Strict cookie (`ap_astro_session`, at most 12 h). Users with no astrologer record are
  signed out at once; applicants who are not live see their status and a link to the public
  site's application status page.
- `/`: Online/Offline toggle (heartbeat `POST /v1/astrologer/me/presence` every 60 s while
  online and the tab is open; TTL 120 s) and incoming requests (polled every 3 s while online,
  30 s while offline), each marked **Chat** or **Voice call**, with price, free/paid, waiting
  time, Accept / Decline. New requests are announced with a visual banner, a live region and a
  `(N)` tab-title badge; no audio. When a schedule slot is running and the astrologer is
  offline, a gentle, dismissible reminder appears (the schedule never changes presence).
- `/sessions/<id>`: chat room (WebSocket with a single-use ticket, reconnect with backoff,
  backfill via `messages?after_seq=`, ping every 20 s, typing, End) or, for `kind: "call"`, the
  call room: the same control socket without a text box, microphone check first, then a LiveKit
  token from `POST /api/sessions/<id>/call-token` and an audio-only room (remote audio attached,
  "Tap to enable audio" after an autoplay block), who has joined (socket `call` event), elapsed
  time, mute/unmute, End with confirm, rejoin with a fresh token after a drop, and guidance
  when the microphone is blocked. The audio leaves on `ended`/close 4000, when another tab takes
  the call, and when the server deletes the room. Client shown by label only.
- `/schedule`: weekly IST slots in 15-minute steps (add, remove, copy a day), checked like the
  API (start < end, no overlaps, at most 21; `24:00` ends a day so an overnight shift is two
  slots); a `422 invalid_slots` is shown at the slot it names.
- `/settings`: chat and voice-call toggles (`PATCH …/consult`); the call toggle is disabled
  with an explanation while voice calls are off on the platform (`voice_calls_available` false
  or `409 call_unavailable`). Price and tier are read-only ("set by the platform").
- `/earnings`: this month / last month / custom IST dates (≤ 366 days); totals (gross,
  commission, refunds, net, sessions, minutes), a per-day table with CSS bars, session rows
  with paging, payable balance and the last payout.
- `/payouts`, `/payouts/<id>`: monthly statements with status, lines, adjustments, the
  "TDS/GST not modelled yet" note and a CSV download (`/api/payouts/<id>/statement.csv`, streamed
  from the API with only `content-type` (must be CSV) and `content-disposition` passed on).
- `/reviews`: all or unreplied reviews with rating, text, date and published/held status; one
  final reply per review (two-step send), existing replies shown.
- `/history`: `GET /v1/sessions?role=astrologer` with type, billed minutes and amount.

The browser only talks to this app; route handlers under `src/app/api/` add the Bearer token
and forward to the API (cores in `src/lib/routes.ts`, tested). Chat state is a pure reducer
(`src/lib/chat/reducer.ts`) and the socket logic a small class with injected socket and timers
(`src/lib/chat/socket.ts`), both unit-tested. Portal logic is pure and tested too:
`src/lib/availability.ts` (schedule rules, editing, IST "now"), `src/lib/earnings.ts` (IST
periods, formatting), `src/lib/call/state.ts` + `src/lib/call/audio.ts` (call state and the
LiveKit join/rejoin/leave controller, with the adapter in `src/lib/call/livekit-room.ts`), and
`src/lib/portal-routes.ts` (schedule, consult, reply and CSV route cores). `livekit-client` is
loaded only on the call page. `Permissions-Policy` allows `microphone=(self)`; camera and
location stay off.

Environment:

| Variable | Default | Use |
|---|---|---|
| `API_URL` | `http://localhost:8000` | core API, server side |
| `API_WS_URL` or `NEXT_PUBLIC_API_WS_URL` | `ws://localhost:8000` | API WebSocket origin handed to the browser; read at request time, so images need no rebuild |
| `PUBLIC_SITE_URL` or `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | links to the public application pages |

The API's `CORS_ORIGINS` must include this app's origin (e.g. `http://localhost:3002`) for the
WebSocket `Origin` check. For calls the browser connects straight to the LiveKit URL the API
returns with the token (`LIVEKIT_PUBLIC_URL`); this app needs no LiveKit settings of its own.

Run: `API_URL=http://localhost:8000 pnpm --filter @astro/astrologer dev` (port 3002).
