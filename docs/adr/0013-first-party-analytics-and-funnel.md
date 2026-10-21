# ADR-0013: First-party analytics and the growth funnel

- Status: Proposed (2026-10-21). Implemented in Phase 8.
- Contract: docs/api/growth.md §1; schema `packages/shared/analytics/events.json` (v2); targets
  `data/growth/targets.json`.

## Context

PLAN.md Phase 8 asks for a funnel dashboard (visit → tool use → OTP → free session → first
recharge → repeat) to test the plan's conversion assumptions. The guardrails apply: no chat
content in analytics, no PII in logs, no dark patterns, and DPDP rights (export, deletion).
A third-party tag (GA, Meta pixel) would ship visitor data to another processor, add a consent
banner and leak into ad targeting.

## Decision

```
browser ──beacon──> web /api/e ──(aid cookie, token, client IP)──> API /v1/analytics/events
  page_view, tool_*, cta, otp_requested      drops: GPC/DNT/opt-out, bots     validate_event (closed schema)
web OTP verify route ──server-side otp_verified──┘                             analytics_events (pseudonymous)

admin funnel = analytics_events (visit, tool use, anon→user link)
             + free_session_claims, consult_sessions, recharge_orders (authoritative)
```

1. **First party only.** Our own collector and our own Postgres table; nothing is sent to a third party.
2. **Closed schema.** There are no free-text properties, so names, birth details, phones,
   emails and chat text can't be recorded even by mistake. The TS and Python validators share
   test cases.
3. **Pseudonymous id in an HttpOnly first-party cookie** (`aid`, 180 days). There is no
   fingerprinting, and no IP or user agent is stored. An IP HMAC is used for rate limiting only.
   GPC/DNT and an opt-out switch on the privacy page turn collection off.
4. **Money and session steps come from the source tables**, not from client events: a blocked
   beacon can't lose or invent a recharge.
5. **Two funnels.**
   - The visitor funnel (pseudonymous cohort) shows where visitors drop off.
   - The account funnel (every account) is exact and unaffected by opt-outs.
   - The gap between them estimates the traffic we can't see.
6. **Retention:** raw events are kept for 400 days, then purged by a daily CLI. Deleting an
   account deletes its linked events, and an export includes them.

## Alternatives

- **GA4 / a hosted tool:** fastest, but adds a processor, a cookie banner and data leaving our
  control; rejected.
- **Plausible-style cookieless counting** (a daily-rotating hash): no cookie, but it can't link
  a visit to a sign-up days later, so tool → OTP would be undercounted. It is a reasonable
  fallback if the lawyer requires opt-in consent for the cookie.

## Consequences

- The visitor funnel undercounts people with GPC/DNT or blocked cookies; the dashboard says so.
- **Founder/lawyer:** confirm under DPDP whether the pseudonymous analytics cookie needs opt-in
  consent (then set `aid` only after that consent, or switch to cookieless counting),
  and confirm the 180-day cookie and 400-day retention.
