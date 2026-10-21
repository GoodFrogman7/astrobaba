# ADR-0006: Marketplace visibility, KYC documents and admin access

- Status: Accepted
- Date: 2026-10-21

## Context

Phase 3 brings astrologers onto the platform. Users must only ever see astrologers who passed
verification (PLAN.md §5 Phase 3: "unapproved astrologers are invisible everywhere"), applicants
upload identity documents that are among the most sensitive data we will hold, and operations
staff need an admin panel.

## Decisions

1. **One visibility rule, one helper.** Public means `status ∈ {probation, approved}`, the
   `show_in_directory` flag is on, and (in staging/production) the row is not demo seed data.
   Every public read path (directory, slugs, profile, reviews, replies, presence) goes through
   `astro_api.marketplace`'s helper; tests create astrologers in every non-public status and
   assert they appear nowhere, including the sitemap.
2. **Probation is live.** After identity, qualification and interview pass, approval puts the
   astrologer on probation: visible and bookable, but monitored. Passing probation makes them
   `approved`; failing it makes them `rejected` (invisible). This matches the plan's
   verification steps while letting real consultations be part of the evaluation.
3. **KYC documents** are stored under random keys (never the uploader's filename), validated by
   magic bytes, size and count, and readable only through an admin endpoint that streams them
   with `no-store`, `nosniff` and a sandbox CSP, writing `kyc_document.view` to the audit log.
   Development uses local files; staging/production refuse to start unless the S3 backend
   (ap-south-1, SSE-KMS) is configured.
4. **Admins are users with a role**, not holders of a shared token. They sign in with the same
   phone OTP; the admin app keeps its own 12-hour, SameSite=Strict cookie and checks the role on
   every request. Roles are granted from the server CLI only. The old `ADMIN_TOKEN` is removed.
5. **Reviews come only from completed sessions**, one per session. New reviews with contact
   details, abuse or health/legal outcome claims are held for moderation; reported reviews stay
   visible until a moderator decides. Author identity is never shown ("Verified client").
6. **Demo data is labelled and contained.** `make seed` refuses outside development/test, seeded
   rows say "Demo" in names, bios and reviews, the UI badges them, and they are `noindex`.

## Consequences

- A second factor for admin sign-in (TOTP) is required before launch; phone OTP alone is
  acceptable only while the admin team is the founder.
- Retention and deletion rules for KYC documents must be written (DPDP) before real applicants
  upload anything (COMPLIANCE.md).
- Directory ordering by presence happens in application code; revisit with SQL-side ranking if
  supply grows past ~10k astrologers.
