# ADR-0011: Consent records, data export and account deletion

- Status: Proposed (retention periods pending the lawyer)
- Date: 2026-10-21
- Contract: [docs/api/trust.md §1–§2](../api/trust.md)

## Context

Phase 7 is the launch gate. DPDP (India) expects consent that can be shown later, a way for a
person to get their data and a way to erase it. At the same time the ledger is append-only by
design (ADR-0002) and tax law requires keeping financial records, the jobs and storage from
ADR-0009 already hold user files, and chat, AI questions and lead notes are encrypted at rest.

## Decision

### 1. Consents are append-only proof

- `consents (user_id, kind, version, accepted_at, ip_hash, device_hash)`, UNIQUE
  `(user_id, kind, version)`, a trigger rejects UPDATE and DELETE. The users row is never
  hard-deleted (deletion anonymises it), so the proof survives deletion.
- IP and the auth session's device id are HMAC-SHA256 keyed with `SECRET_KEY` (purposes
  `consent_ip`, `consent_device`), never raw: enough to show "this device accepted", useless
  if leaked without the key.
- Required kinds come from `policies.json` `consents`, and a consent counts only at the current
  `version`. A lawyer-approved new version therefore asks everyone again without a migration.
- Enforcement is one FastAPI dependency, `require_consent("user" | "astrologer")`, added to the
  endpoints that move money or start a consultation, and to astrologer portal writes. Signed-out
  requests still get 401 first. `age_18` sets `users.is_adult_confirmed`.
- There is no withdrawal endpoint: withdrawing consent is the deletion request (see open
  decisions).

### 2. Export: a file, built by a job

- `data_export` job (ids-only payload) builds one JSON document with `astro_api.privacy.
  build_export`, stores it with the documents storage under a random key and schedules an
  `account_cleanup` job at `expires_at` (7 days) that removes the file. Downloads use a
  10-minute HMAC link bound to the export id (key derived from `SECRET_KEY`, purpose
  `export-links`) or the owner's session, `no-store`, as for reports.
- One per 24 h (user row locked during the check); failed exports do not count.
- Content (trust.md §2): everything about the user, decrypted where we encrypt it (chat, AI
  questions/answers, lead notes, report notes). Chat transcripts are the user's own
  conversations, so both sides are included, the astrologer by display name. Never another
  client's data: an astrologer's export lists consultations served and reviews received without
  client ids or messages, because those messages are the clients' data and often quote their
  birth details. KYC documents are listed (metadata), not embedded. Admin-internal notes
  (verification reviewer notes, moderation resolution notes) are not included.

### 3. Deletion = anonymisation, ledger retained

- The user asks (`{confirm: "DELETE"}`), may cancel, and the account keeps working meanwhile.
  An admin executes, so a human checks money and open work first.
- Refused, writing nothing, while: a consultation is open (as client or astrologer), real
  wallet money or an astrologer payable is non-zero, or paid work is queued (report rendering,
  AI question, export). Real money is the user's money: it must be refunded or settled by hand
  before deletion. **Promo credit has no cash value and is forfeited**, posted through the
  normal expiry (`promo_lot:{id}:expire`) so the ledger still balances and reconciles.
- One transaction: tokens revoked, devices/roles/locale cleared, phone replaced by
  `deleted:{HMAC(phone)}:{user id}`. The tombstone is unique (the same number may sign up and
  delete again), frees the number for a new account, and lets a later abuse check recognise a
  number that deleted an account without storing it.
- Deleted: saved kundlis (with AI conversations), AI questions, chat messages of the user's own
  consultations, remedy leads, the user's note on astrologer reports. Kept: the anonymised
  users row, consents, all ledger rows, consultations (money facts that earnings, refunds and
  payouts reference), reviews (the astrologer's rating; they already show no reviewer
  identity), recharge orders, payouts, report orders/reports without snapshot or email,
  free-session claim HMACs (abuse prevention), moderation items, audit entries (ids only).
- Files (report PDFs, exports) cannot be removed inside a database transaction: their keys are
  listed on the request (`pending_files`) and an `account_cleanup` job deletes them (storage
  deletes ignore missing files, so retries are harmless).
- Astrologers: profile hidden (`suspended`, reason `account_deleted`, "Former astrologer", bio
  cleared, out of the directory, chat/call off, presence dropped), availability deleted.
  **KYC documents and files are kept** and the request is flagged `kyc_review_required`: KYC
  retention after deletion is a legal question (verification evidence vs. minimisation) and
  stays with the lawyer. Clients' transcripts with that astrologer are kept: they are the
  clients' data.
- Every step is audited (`privacy.deletion.*`) with ids, counts and amounts only.

## Alternatives considered

- **Hard delete with ON DELETE CASCADE.** Would cascade into consultations and break the
  append-only ledger and earnings; rejected.
- **Delete ledger rows or replace user ids in them.** Breaks ADR-0002 and tax retention.
- **Self-service immediate deletion.** Real money and open sessions need a human; a request plus
  admin execution is simpler to make correct. Can be automated later for accounts with nothing
  outstanding.
- **Export synchronously in the request.** Large accounts and decryption make it slow; the job
  queue already exists.

## Consequences

- Tests: `services/api/tests/test_consent_api.py`, `test_consent_enforcement.py` (matrix,
  written before wiring), `test_privacy_deletion.py` (written before the executor),
  `test_privacy_export.py`, `services/worker/tests/test_privacy_jobs.py`.
- A dev who signs in as a seed astrologer and accepts consents makes `seed` unable to delete
  that seed user (the consent trigger blocks the cascade). Intended: consents are proof.
- Public review lists still label every review "Verified client"; showing "Former client" for
  anonymised reviewers needs a change in `marketplace.py` (check `phone LIKE 'deleted:%'`).

## Open founder / lawyer decisions

- Retention periods: KYC documents after deletion or rejection; chat transcripts of a deleted
  astrologer kept for clients; consultations rows; free-session HMACs; tombstone HMAC; audit log.
- Whether to keep the phone tombstone at all (abuse prevention vs. minimisation).
- Promo forfeiture on deletion (implemented) and how real-money balances are refunded before
  deletion (manual today; no refund-to-source flow exists).
- Consent withdrawal short of deletion (e.g. withdrawing `privacy` blocks paid features only).
- Grievance response timelines and whether deletion must complete within a fixed period.
- Export file lifetime (7 days) and whether report PDFs should be embedded in the export.
- Whether unpaid report orders' snapshots should be purged on a schedule (ADR-0009).
