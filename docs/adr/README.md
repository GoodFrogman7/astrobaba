# Architecture decision records

One file per decision, numbered in the order written. Status is Proposed until the founder
accepts it, then Accepted (or Superseded by NNNN).

| # | Decision | Status | Plan ref |
|---|---|---|---|
| [0001](0001-ephemeris-licensing.md) | Ephemeris engine and licensing | **Accepted: option C** (AGPL, engine open-sourced; lawyer check before launch) | §2 ADR-1 |
| [0002](0002-ledger-design.md) | Wallet ledger design | Proposed | §2 ADR-2 |
| [0003](0003-monorepo-tooling.md) | Monorepo tooling and dev stack | Accepted | Phase 0 |
| [0004](0004-astro-conventions.md) | Astro engine conventions (ayanamsha, nodes, houses, sunrise, dasha year) | Accepted | Phase 1 |
| [0005](0005-horoscope-pipeline.md) | Horoscope generation pipeline (facts → LLM → validator → human QA → publish) | Accepted | §2 ADR-5 |
| [0006](0006-marketplace-trust.md) | Marketplace visibility rule, KYC document handling, role-based admin | Accepted | Phase 3 |

Still to write, in the phase that needs them: chat transport (Phase 4), in-app VoIP vs masked
PSTN (Phase 5).
