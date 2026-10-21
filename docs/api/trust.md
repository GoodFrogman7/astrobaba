# Trust, safety and compliance API (Phase 7)

The launch gate (PLAN.md Phase 7). Errors `{"detail": {"code", "message", ...}}`. Data:
`data/legal/policies.json` (versions, operator, grievance contact, processors, retention),
`data/safety/helplines.json` (verified crisis numbers). Shared TS shapes:
`packages/shared/src/trust.ts`. Legal texts are drafts until a lawyer approves a version;
production refuses to start unless `LEGAL_APPROVED_VERSION` equals `policies.version`.

## 1. Age gate and consent

Table `consents (id, user_id, kind, version, accepted_at, ip_hash, device_hash)`; append-only;
kinds `age_18`, `terms`, `privacy`, `astrologer_terms`. `users.is_adult_confirmed` mirrors the
latest `age_18`.

- `GET /v1/legal` (public) → `{version, status, documents, operator, grievance_officer,
  processors, retention}` from policies.json (nulls shown as "to be published").
- `GET /v1/me/consents` → `{version, required: [kind], accepted: [{kind, version, accepted_at}],
  current: bool}`.
- `POST /v1/me/consents` `{version, kinds: [...]}` → same. `version` must equal the current one
  (`409 consent_version_stale`). Accepting `age_18` means the user confirms they are 18 or older.
- Enforcement: every endpoint that moves money or starts a consultation (recharge orders, report
  orders, sessions create, AI questions, remedy leads) requires current user consents →
  `403 consent_required` with `missing: [kind]`. Astrologer portal writes (presence, accept,
  availability, consult settings) require `astrologer_terms`. Free tools, browsing and sign-in
  do not.

## 2. Your data (DPDP)

- `POST /v1/me/export` → 202 `{id, status: queued}`; a `data_export` job builds a JSON file of
  everything we hold about the user (profile, consents, saved kundlis, sessions with their own
  chat messages decrypted, wallet history, reports list, AI questions and answers, remedy leads,
  reviews; astrologers also: application, availability, earnings, payouts — KYC files listed,
  not embedded). Stored like reports; `GET /v1/me/exports` → `[{id, status, created_at,
  download_url (10-minute signed) | null}]`. One export per 24 h (`429`).
- `POST /v1/me/deletion` `{confirm: "DELETE"}` → 202 `{id, status: requested, ...}`. While a
  request is open the account keeps working; `DELETE /v1/me/deletion` cancels it.
  `GET /v1/me/deletion` → current request or 404.
- Deletion is executed by an admin (`POST /v1/admin/deletions/{id}/execute`) after open
  sessions end and any wallet balance is settled (`409 balance_outstanding` /
  `session_open`). Execution (one transaction + a cleanup job for files): sessions and auth
  tokens revoked; phone replaced by a tombstone hash; name/locale cleared; saved kundlis, chat
  messages, AI questions, remedy leads, report files and snapshots, export files deleted;
  reviews anonymised ("Former client"); consents kept (proof) with the user id; ledger rows kept
  (append-only, tax law) pointing at the anonymised user; astrologer profile hidden and KYC
  files handled per the retention decision. Audited. The phone can sign up again as a new user.

## 3. Safety in consultations

- One classifier for chat and AI (`astro_api.safety`): self-harm (en, hi, Hinglish), plus
  medical/legal/financial-advice and scam signals for moderation. Tested by `evals/safety`.
- Chat: every message from either side is checked before it is stored.
  - Self-harm language from the **client** → the message is delivered, the session gets
    `safety_flag` (one `safety_event` row: session, message seq, kind, at), and both sides get a
    socket event `{type: "safety", kind: "self_harm"}`: the client sees the crisis resources
    and the not-a-helpline notice; the astrologer sees guidance (share the resources, no
    selling, the client may end anytime). Upsell pauses for the session: no `low_balance`
    recharge prompts are sent (the meter still ends at zero balance) and the session cannot be
    extended with a free-session offer. The client may end with the session billed only to the
    current minute (as today).
  - Messages from the **astrologer**: contact details or off-platform payment requests →
    refused (`error message_blocked` with `reason`), not stored; claims of cures, guaranteed
    outcomes, fear-based selling or remedy/gemstone sales → refused the same way and counted as
    a `moderation_event` for the astrologer. Each refusal is visible in the admin queue (no
    message text stored for refused messages — only reason codes).
- Consultation pages always show the entertainment disclaimer and the not-a-helpline notice.
- `GET /v1/safety/resources` (public) → helplines.json (localized fields).

## 4. Reports and moderation

- `POST /v1/reports/astrologer` (signed in, `Idempotency-Key`) `{astrologer_id, session_id?,
  reason: harassment|scam|fear_selling|medical_claims|off_platform|other, note? (≤500)}` →
  201. One open report per user per astrologer. Note encrypted at rest.
- Admin queue `GET /v1/admin/moderation?kind=report|safety|refused&status=open|closed` →
  items with astrologer, reason codes, counts, session id, time; never chat text by default.
  `GET /v1/admin/moderation/{id}/message` reveals the one flagged message (decrypted) for a
  `safety` item, audited with the admin id. Actions `POST /v1/admin/moderation/{id}` `{action:
  dismiss|warn|suspend, note}`; `suspend` uses the existing astrologer suspension; `warn`
  records a strike the astrologer sees in the portal (`GET /v1/astrologer/me/strikes`).
- Astrologer conduct: `astrologer_terms` consent required (§1); the portal shows the banned-topic
  list from `data/safety/conduct.json`.

## 5. Copy checks

`scripts/claims-check` (CI): scans user-facing copy (web/admin/astrologer messages and content
files, remedies.json, products.json) for banned marketing claims (guarantees, cures, "100%",
fear wording, gemstone selling) in en and hi; failures block CI. Exceptions need an explicit
allow-list entry with a reason.
