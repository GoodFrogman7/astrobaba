# Compliance

The gate for public launch (PLAN.md Phase 7). `[x]` = enforced in code; `[ ]` = needs a person
(founder, lawyer, CA) before launch. Production refuses to start until a lawyer-approved policies
version is configured (`LEGAL_APPROVED_VERSION`).

- [x] Entertainment disclaimer on every page (web layout footer)
- [x] Analytics cannot carry chat content or contact details (closed schema)
- [x] Logs redact phones, emails, tokens and URL credentials
- [x] OTP sign-in: codes stored only as HMACs, single use, attempt limit, rate limits, no account enumeration
- [ ] SMS provider chosen (MSG91 or similar) with DLT template registration (TRAI) before launch
- [x] Consent records (18+, terms, privacy; astrologer conduct terms), versioned and append-only; required before any payment, consultation, report, AI question or remedy request
- [ ] Lawyer approves the consent wording and privacy notice; encryption at rest for saved_kundlis (decide)
- [ ] Editorial review of all page copy (English and Hindi) and of the curated Hindi city names
- [x] 18+ gate and consent flow; privacy notice lists processors (`data/legal/policies.json`)
- [ ] Operator legal name/address and grievance officer name/contact filled in `policies.json`
- [x] Refund and credit-expiry policy pages generated from the configured rules (drafts)
- [ ] Lawyer approves every policy text (terms, privacy, refunds, credit, grievance) and sets `LEGAL_APPROVED_VERSION`
- [x] DPDP data export (JSON, signed link) and account deletion (anonymisation; ledger kept for tax law) (ADR-0011)
- [ ] Retention periods (KYC, transcripts with deleted astrologers, tombstones), deletion timelines and promo forfeiture confirmed with the lawyer
- [x] Chat safety: self-harm detection (en/hi/Hinglish), crisis panel both sides, upsell paused, "not a helpline" notice; AI questions blocked for free (ADR-0012, `evals/safety` in CI)
- [ ] Founder calls Tele-MANAS 14416 and 112 and sets `verified_by_founder` in `data/safety/helplines.json`
- [ ] Native-speaker review of the Hindi/Hinglish safety rules and conduct text
- [x] Banned-topic rules for astrologer messages (contact details, off-platform payment, cures, guarantees, fear selling, remedy sales) enforced; reports, moderation queue, strikes and suspension
- [x] CI blocks banned marketing claims in user-facing copy (`scripts/claims-check.mjs`)
- [ ] Lawyer review of copy: consumer protection, Drugs and Magic Remedies (Objectionable Advertisements) Act, ASCI; remedies catalogue reviewed
- [ ] CA/lawyer: closed-loop wallet vs RBI prepaid-instrument rules; GST on commission vs gross
- [x] Ephemeris licence chosen: option C, AGPL-3.0 (ADR-0001)
- [ ] Lawyer confirms the AGPL engine as a separate network service keeps the rest of the platform outside its scope
- [ ] Astro engine source published at the `/v1/source` URL (public repo if this one stays private)
- [ ] Astrologer sign-off on `data/astro` tables marked `needs_astrologer_review` (Ashtakoota, dosha rules, nakshatra attributes, choghadiya, numerology, horoscope rules); production blocks /v1/match and /v1/doshas until then
- [ ] A named editor reviews horoscope prose daily before it publishes (ADR-0005)
- [x] GeoNames CC-BY attribution returned with every city result (`attribution` field); show it in the UI (Phase 2)

## Marketplace (Phase 3)

- [x] KYC documents: random storage keys, type/size checks, admin-only access, every view audited
- [ ] S3 bucket in ap-south-1 with SSE-KMS and no public access before any real applicant uploads
- [ ] KYC retention and deletion policy (DPDP): how long documents are kept after approval/rejection
- [ ] Astrologer terms (independent contractor, conduct rules, banned topics) reviewed by a lawyer
- [ ] Admin second factor (TOTP) before more than one admin exists
- [x] Reviews only after completed sessions; contact details and outcome claims held for moderation

## Launch and growth (Phase 8)

- [x] First-party analytics only (no third-party tags); closed schema; GPC/DNT and a privacy-page switch turn it off; events deleted with the account and included in the export (ADR-0013)
- [ ] Lawyer confirms whether the pseudonymous analytics cookie (`aid`, 180 days) needs opt-in consent under DPDP, and the 400-day event retention
- [x] Staging and preview builds are `noindex`; only `NEXT_PUBLIC_SITE_ENV=production` is indexable
- [x] Articles publish only with a named reviewer; claims check and SEO check run on them in CI
- [ ] 30–50 real astrologers vetted through all four steps before marketing (docs/LAUNCH.md §2)
- [ ] Staging load test: 500 chat sessions, no errors, p95 round trip < 500 ms, ledger invariants hold
