# Astrologer console

Minimal Next.js console for live astrologers (Phase 4 slice; the full portal with schedule,
earnings, payouts and review replies is Phase 5). English only, never indexed (`X-Robots-Tag`,
`robots.txt` disallow all, `noindex` metadata), never framed. Port 3002.

- `/login`: phone OTP through the core API. The session token lives only in an httpOnly,
  SameSite=Strict cookie (`ap_astro_session`, at most 12 h). Users with no astrologer record are
  signed out at once; applicants who are not live see their status and a link to the public
  site's application status page.
- `/`: Online/Offline toggle (heartbeat `POST /v1/astrologer/me/presence` every 60 s while
  online and the tab is open; TTL 120 s) and incoming requests (polled every 3 s while online,
  30 s while offline) with price, free/paid, waiting time, Accept / Decline. New requests are
  announced with a visual banner, a live region and a `(N)` tab-title badge; no audio.
- `/sessions/<id>`: chat room. WebSocket with a single-use ticket from a route handler,
  reconnect with backoff, backfill via `messages?after_seq=`, ping every 20 s, typing, End.
  Shows the client's label only, elapsed time and billed minutes.
- `/history`: `GET /v1/sessions?role=astrologer` with billed minutes and amount.

The browser only talks to this app; route handlers under `src/app/api/` add the Bearer token
and forward to the API (cores in `src/lib/routes.ts`, tested). Chat state is a pure reducer
(`src/lib/chat/reducer.ts`) and the socket logic a small class with injected socket and timers
(`src/lib/chat/socket.ts`), both unit-tested.

Environment:

| Variable | Default | Use |
|---|---|---|
| `API_URL` | `http://localhost:8000` | core API, server side |
| `API_WS_URL` or `NEXT_PUBLIC_API_WS_URL` | `ws://localhost:8000` | API WebSocket origin handed to the browser; read at request time, so images need no rebuild |
| `PUBLIC_SITE_URL` or `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | links to the public application pages |

The API's `CORS_ORIGINS` must include this app's origin (e.g. `http://localhost:3002`) for the
WebSocket `Origin` check.

Run: `API_URL=http://localhost:8000 pnpm --filter @astro/astrologer dev` (port 3002).
