# Trust, safety and compliance API (Phase 7)

The launch gate (PLAN.md Phase 7). Errors `{"detail": {"code", "message", ...}}`. Data:
`data/legal/policies.json` (versions, operator, grievance contact, processors, retention),
`data/safety/helplines.json` (verified crisis numbers). Shared TS shapes:
`packages/shared/src/trust.ts`. Legal texts are drafts until a lawyer approves a version;
production refuses to start unless `LEGAL_APPROVED_VERSION` equals `policies.version`.

## 1. Age gate and consent

Table `consents (id, user_id, kind, version, accepted_at, ip_hash, device_hash)`; append-only
(a trigger rejects UPDATE and DELETE); one row per (user, kind, version). Kinds `age_18`,
`terms`, `privacy`, `astrologer_terms`. IP and device (the auth session's device id) are stored
only as HMAC-SHA256 keyed with `SECRET_KEY`. `users.is_adult_confirmed` is set by accepting
`age_18`. Which kinds are required comes from `policies.json` `consents` (`user` for everyone,
`astrologer` additionally for astrologers); a consent counts only at the current `version`, so
a new policies version asks everyone again. ADR-0011.

- `GET /v1/legal` (public) → `{version, status, documents, operator, grievance_officer,
  processors, retention}` from policies.json; every null is returned as the string
  `"to be published"` (`founder_to_fill` markers are kept).
- `GET /v1/me/consents` → `ConsentState` `{version, required: [kind], missing: [kind],
  accepted: [{kind, version, accepted_at}], current: bool}`:
  - `required`: every kind required for this user's roles (`age_18`, `terms`, `privacy`;
    astrologers also `astrologer_terms`), in that order;
  - `missing`: the required kinds not accepted at the current version;
  - `accepted`: the latest acceptance of each kind, any version;
  - `current`: true when `missing` is empty.
- `POST /v1/me/consents` `{version, kinds: [...]}` (1-4 known kinds, else 422) → the same
  `ConsentState`. `version` must equal the current one (`409 consent_version_stale` with the
  current `version`). Accepting a kind already accepted at this version records nothing new.
  Accepting `age_18` means the user confirms they are 18 or older.
- Enforcement (`astro_api.consent.require_consent`): every endpoint that moves money or starts a
  consultation (`POST /v1/wallet/recharge-orders`, `POST /v1/reports/orders`,
  `POST /v1/sessions`, `POST /v1/ai/conversations/{id}/questions`, `POST /v1/remedies/leads`)
  requires the current user consents → `403 consent_required` with `missing: [kind]` and
  `version`. Astrologer portal writes (`POST /v1/astrologer/me/presence`,
  `POST /v1/sessions/{id}/accept`, `PUT /v1/astrologer/me/availability`,
  `PATCH /v1/astrologer/me/consult`) require `astrologer_terms` (same error). Signed-out
  requests stay `401`. Free tools, browsing, reads and sign-in need no consent.

## 2. Your data (DPDP)

- `POST /v1/me/export` → 202 `{id, status: queued}`; a `data_export` job builds a JSON file
  (`format: astro-data-export/1`) of everything we hold about the user: profile (phone, locale,
  roles, devices, sign-in sessions), consents, saved kundlis, consultations as the client with
  every message of the conversation decrypted (the astrologer appears by display name; senders
  `you` / display name / `system`) and safety flags, reviews written, wallet (balance, full
  history, recharge orders), report orders and reports (list; PDFs stay downloadable from the
  reports page), AI questions and answers, remedy leads (with the note), astrologer reports the
  user filed (with their note), export and deletion requests, the free-session claim.
  Astrologers also: application, verification steps (no reviewer notes), KYC documents listed
  (not embedded), availability, all-time earnings and payable, payouts, consultations served
  (no client ids, no messages), reviews received (no client ids), strikes. Never another
  client's personal data. Stored with the documents storage under a random key.
  `GET /v1/me/exports` → `[{id, status: queued|ready|failed|expired, created_at, expires_at,
  download_url (10-minute signed) | null}]` (latest 20). One export per 24 h (`429
  export_rate_limited`, `Retry-After`); failed exports do not count. The file is removed 7 days
  after it is ready (`account_cleanup` job; status `expired`).
- `GET /v1/me/exports/{id}/file?sig=` → the JSON (`Content-Disposition: attachment`,
  `Cache-Control: private, no-store`), with a valid signature or the owner's session. Bad
  signature 403, expired 410, no signature and no session 401, not ready/expired 404.
- `POST /v1/me/deletion` `{confirm: "DELETE"}` → 202 `{id, status: requested, requested_at,
  cancelled_at, executed_at}` (anything else than `"DELETE"` → `422 confirm_required`; asking
  again returns the open request). While a request is open the account keeps working;
  `DELETE /v1/me/deletion` cancels it (→ the request, `status: cancelled`; 404 when none).
  `GET /v1/me/deletion` → the open request or 404.
- `GET /v1/admin/deletions?status=requested|all&cursor=` (admin) → `{items: [{id, user_id,
  status, requested_at, open_sessions: int, wallet_balance_paise: {real, promo}, executed_at,
  files_pending, kyc_review_required}], next_cursor}`, oldest first, 50 per page.
  `open_sessions` counts open consultations as client or astrologer; `promo` is the spendable
  promo credit (forfeited on execution).
- `POST /v1/admin/deletions/{id}/execute` (admin) → 200 `{...request, status: executed,
  promo_forfeited_paise, files_pending, kyc_review_required}`. Refused, with nothing written:
  `404` unknown; `409 deletion_not_open` (`request_status`); `409 session_open`
  (`session_ids`, as client or astrologer); `409 balance_outstanding` (`real_paise`,
  `payable_paise`: real wallet money must be refunded/settled manually first, an astrologer's
  payable must be paid out or be zero); `409 work_pending` (`pending: report | ai_question |
  export` still queued). Execution, in one transaction, every step audited with ids and counts
  only (`privacy.deletion.*`):
  - leftover promo credit forfeited through the ledger (`promo_lot:{id}:expire`, no cash value);
    every other ledger row untouched (append-only, tax law), pointing at the anonymised user;
  - every auth token revoked and device ids removed; phone replaced by a tombstone
    `deleted:{HMAC(phone)}:{user id}`, devices, roles, locale and last sign-in cleared; the
    phone can sign up again as a new user;
  - deleted: saved kundlis (with AI conversations), AI questions, chat messages of the user's own
    consultations, remedy leads, the note of astrologer reports the user filed;
  - report orders/reports kept as purchase records without snapshot or email; report and export
    files listed in the request and removed by an `account_cleanup` job;
  - kept: consents (proof), consultations (money facts), reviews (on the anonymised user),
    free-session claims (HMACs only), recharge orders, payouts, moderation items (without the
    note), audit entries;
  - astrologers: profile hidden (`suspended`, reason `account_deleted`, display name "Former
    astrologer", bio cleared, not in the directory, chat/call off, presence dropped),
    availability deleted; KYC documents and files kept and the request marked
    `kyc_review_required` until the retention decision. Clients' transcripts with the
    astrologer are kept (they are the clients' data).

## 3. Safety in consultations

- One classifier for chat and AI (`astro_api.safety`; `ai_safety.classify` delegates to it):
  categories `self_harm`, `emergency`, `medical`, `legal`, `financial`, `scam` (en, hi,
  Hinglish), plus the astrologer conduct rules. Tested by `evals/safety` (in CI). ADR-0012.
- Chat: every text message from either side is checked before it is stored.
  - Self-harm (or emergency: danger, violence) language from the **client** → the message is
    delivered, the session is flagged (one `safety_events` row per session and kind: session,
    message seq, kind, at; no text) and a `safety` item enters the moderation queue. Both sides
    get `{type: "safety", kind: "self_harm"}` after the message, and again right after `hello`
    on every (re)connect of a flagged session; `SessionView.safety_flag` is `true`. The client
    sees the crisis resources and the not-a-helpline notice; the astrologer sees the guidance
    (`crisis_guidance` in conduct.json: share the resources, no selling, the client may end
    anytime). Upsell pauses for the session: no `low_balance` event or system message (the meter
    still ends at zero balance) and no free-session extension (none exists today). The client
    may end with the session billed only to the current minute (as today). Client messages are
    never refused.
  - Messages from the **astrologer** that break a conduct rule are refused: not stored, not
    relayed, and the sender gets
    `{type: "error", code: "message_blocked", message, reason, client_id}` where `message` is
    the rule's English text and `reason` is one of `BLOCK_REASONS` (chat.ts):
    `contact_details` (phone, email, link, messaging app), `off_platform_payment` (UPI, payment
    apps, bank details, OTP, advance fees), `cure_claim` (cures, or telling a client to stop
    medicine / avoid doctors), `guarantee`, `fear_selling` (death predictions, curses, black
    magic, threats), `remedy_sale` (pricing or offering to send gemstones, yantras, pujas).
    Each refusal is a `refused` item in the admin queue with the reason code only (repeats of a
    rule in one session add to that item's count). Investment and legal advice are conduct
    rules handled through reports (`enforced: "review"`), not automatic refusals.
- Consultation pages always show the entertainment disclaimer and the not-a-helpline notice.
- `GET /v1/safety/resources` (public) → `SafetyResources` (trust.ts) from helplines.json: both
  languages of every field, plus `verified_by_founder` and `checked_on`.
- `GET /v1/safety/conduct` (public) → data/safety/conduct.json as is: `{version, rules: [{id,
  enforced: auto|review, title: {en, hi}, rule: {en, hi}}], crisis_guidance: {en, hi}}`. Rule
  ids of the `auto` rules equal `BLOCK_REASONS`.

## 4. Reports and moderation

- `POST /v1/reports/astrologer` (signed in, `Idempotency-Key`) `{astrologer_id, session_id?,
  reason: harassment|scam|fear_selling|medical_claims|off_platform|other, note? (≤500)}` →
  201 `{id, astrologer_id, session_id, reason, status, has_note, created_at}`. The same key and
  body replays the report (backed by a unique key in Postgres); another body →
  `409 idempotency_conflict`. One open report per user per astrologer (`409 report_open` with
  `report_id`). `session_id` must be the reporter's own session with that astrologer
  (`404 session_not_found`); reporting yourself → `409 own_profile`. Note encrypted at rest
  (chat key set, AAD bound to the report id); never logged or audited.
- Admin queue `GET /v1/admin/moderation?kind=report|safety|refused&status=open|closed
  &cursor&limit` (default open, newest activity first) → `{items, next_cursor}`; each item
  `{id, kind, status, astrologer: {id, slug, display_name}, reasons: [code], session_id|null,
  counts: {reports, safety, refused}, created_at, resolution: {action, note, by, at}|null}`.
  `counts` are the astrologer's open items (`refused` sums repeated refusals). Never chat text.
- `GET /v1/admin/moderation/{id}/message` → `{message: {seq, sender, text, sent_at}}`: the one
  flagged message of a `safety` item, decrypted, audited (`moderation.reveal`, admin id, no
  text). Other kinds → `404 no_message` (refused messages were never stored);
  `404 message_gone` once the chat was deleted.
- Actions `POST /v1/admin/moderation/{id}` `{action: dismiss|warn|suspend, note? (≤500)}` →
  the item; `409 already_closed` when handled. `warn` records a strike; `suspend` records a
  strike and uses the existing astrologer suspension (same status change and audit as
  `POST /v1/admin/astrologers/{id}/suspend`; if that refuses, e.g. `409 invalid_transition`,
  nothing is written). Audited as `moderation.{action}` with ids and codes only.
- `GET /v1/astrologer/me/strikes` → `{items: [{id, note, created_at}]}`, newest first. `note`
  is the admin's note (admins: it is shown to the astrologer) or, without one, the text of the
  broken rule.
- Astrologer conduct: `astrologer_terms` consent required (§1); the portal shows the rules from
  `GET /v1/safety/conduct`.

## 5. Copy checks

`scripts/claims-check` (CI): scans user-facing copy (web/admin/astrologer messages and content
files, remedies.json, products.json) for banned marketing claims (guarantees, cures, "100%",
fear wording, gemstone selling) in en and hi; failures block CI. Exceptions need an explicit
allow-list entry with a reason.
