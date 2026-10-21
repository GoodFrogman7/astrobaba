# Admin console

Internal Next.js app (Phase 3), English only, never indexed. Sign-in is phone OTP through the
core API; only users with the `admin` role see anything.

- `/astrologers`: application and KYC queue by status, astrologer detail with documents,
  verification checklist (identity → qualification → interview → probation), approve with
  tier + price, suspend / reinstate / reject, flags, audit trail
- `/reviews`: review moderation (flagged first)
- `/horoscopes`: horoscope prose review queue (approve, edit, reject), ADR-0005
- `/`: counts of pending work

Run: `API_URL=http://localhost:8000 pnpm --filter @astro/admin dev` (port 3001).
Grant a role: `uv run python -m astro_api.cli grant-role <phone> admin`.
