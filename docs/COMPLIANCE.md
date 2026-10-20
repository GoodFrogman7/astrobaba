# Compliance

Placeholder until Phase 7, which is the gate for public launch. Items already enforced in code
are marked.

- [x] Entertainment disclaimer on every page (web layout footer)
- [x] Analytics cannot carry chat content or contact details (closed schema)
- [x] Logs redact phones, emails, tokens and URL credentials
- [ ] 18+ gate, consent flow, privacy notice listing processors, grievance contact
- [ ] Refund and credit-expiry policy pages
- [ ] DPDP-aligned data export and deletion endpoints
- [ ] Chat safety: self-harm detection, crisis resources (verify current helplines), "not a helpline" notice
- [ ] Banned-topic list and moderation tooling; astrologer reporting and suspension
- [ ] Lawyer review of copy: consumer protection, Drugs and Magic Remedies (Objectionable Advertisements) Act, ASCI
- [ ] CA/lawyer: closed-loop wallet vs RBI prepaid-instrument rules; GST on commission vs gross
- [x] Ephemeris licence chosen: option C, AGPL-3.0 (ADR-0001)
- [ ] Lawyer confirms the AGPL engine as a separate network service keeps the rest of the platform outside its scope
- [ ] Astro engine source published at the `/v1/source` URL (public repo if this one stays private)
- [ ] Astrologer sign-off on `data/astro` tables marked `needs_astrologer_review` (Ashtakoota, dosha rules, nakshatra attributes); production blocks /v1/match and /v1/doshas until then
- [x] GeoNames CC-BY attribution returned with every city result (`attribution` field); show it in the UI (Phase 2)
