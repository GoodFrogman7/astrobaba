# Architecture decision records

One file per decision, numbered in the order written. Status is Proposed until the founder
accepts it, then Accepted (or Superseded by NNNN).

| # | Decision | Status | Plan ref |
|---|---|---|---|
| [0001](0001-ephemeris-licensing.md) | Ephemeris engine and licensing | **Accepted: option C** (AGPL, engine open-sourced; lawyer check before launch) | §2 ADR-1 |
| [0002](0002-ledger-design.md) | Wallet ledger design (promo credit first) | Accepted | §2 ADR-2 |
| [0003](0003-monorepo-tooling.md) | Monorepo tooling and dev stack | Accepted | Phase 0 |
| [0004](0004-astro-conventions.md) | Astro engine conventions (ayanamsha, nodes, houses, sunrise, dasha year) | Accepted | Phase 1 |
| [0005](0005-horoscope-pipeline.md) | Horoscope generation pipeline (facts → LLM → validator → human QA → publish) | Accepted | §2 ADR-5 |
| [0006](0006-marketplace-trust.md) | Marketplace visibility rule, KYC document handling, role-based admin | Accepted | Phase 3 |
| [0007](0007-sessions-and-metering.md) | Consultation sessions, prepaid per-minute metering, chat transport | Proposed | Phase 4 |
| [0008](0008-voice-calls.md) | Voice calls: in-app VoIP with LiveKit (not masked PSTN), billing and presence checks | Proposed | §2 ADR-4, Phase 5 |
| [0009](0009-reports-and-jobs.md) | Paid reports: engine snapshot, Chromium print of a web page, Postgres job queue, refunds | Proposed | Phase 6 |
| [0010](0010-ai-assistant.md) | AI assistant: pre-LLM safety block, grounded answers, validator, per-question billing | Proposed | §9.4, Phase 6 |

All ADRs listed in PLAN.md §2 are written.
