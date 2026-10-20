# ADR-0001: Ephemeris engine and licensing

- Status: **Accepted: option C** (founder decision, 2026-10-20). Conditions below.
- Date: 2026-10-20

## Context

Every astro value we show must come from an astronomical engine (PLAN.md §0.4, §6). Two
realistic foundations:

1. **Swiss Ephemeris** (Astrodienst). The de-facto standard for Vedic software: planets, lunar
   nodes, all ayanamshas (Lahiri and its variants), house systems, rise/set, eclipses.
   Dual-licensed:
   - **AGPL-3.0.** Its network clause means that if our service uses it, users who interact
     with that service over a network are owed the complete corresponding source of the
     program that includes it.
   - **Swiss Ephemeris Professional License.** One-time fee. The contract edition seen on
     2026-10-20 (dated September 2026) lists **CHF 700 for an unlimited number of projects**
     by the licensee. Astrodienst requires the choice to be made **before any public service
     using the software is activated**. Re-check the current contract at astro.com before
     buying; prices and terms change.
   - The Python binding `pyswisseph` inherits the same dual licence.
2. **Skyfield + JPL DE440/DE441** (MIT library; JPL ephemerides are US-government public
   domain). Highly accurate planetary positions, rise/set and Moon phases. Not provided:
   ayanamsha, lunar nodes, Vedic house conventions. We would implement those and validate them.

Things worth knowing either way:

- Planet positions are the easy part. Most disagreements between Vedic almanacs come from
  **conventions**: ayanamsha definition (Lahiri has several published variants up to ~1′
  apart), mean vs true node, sunrise convention (upper limb + refraction vs disc centre), year
  length in dasha maths. Those are ours to pin down whichever library we use.
- AGPL obligations attach to the program that includes the AGPL code. Isolating the engine as
  its own service (`/services/astro`) and publishing only that service's source is a
  pattern some companies use. Whether the rest of the platform is then outside the
  "corresponding source" is a legal question. **Get a lawyer's view before relying on it.**
- Running AGPL code privately (tests, CI, internal tools) without offering it to users over a
  network does not trigger the network clause.

## Options

| | A. Buy the Swiss Ephemeris licence | B. Skyfield + JPL, own Vedic layer | C. Swiss Ephemeris under AGPL, astro service open-sourced |
|---|---|---|---|
| Cost | CHF 700 one-time (per current contract) | Engineering time (~1–2 extra weeks in Phase 1) | Free; legal review |
| Time to Phase 1 gate | Fastest | Slowest | Fast |
| Accuracy risk | Lowest: industry reference | Medium: our ayanamsha/nodes must be validated | Lowest |
| Lock-in | Licence covers unlimited projects | None | Must keep the astro service public |
| Legal risk | Low (contract) | Lowest | Medium (AGPL scope) |

## Original proposal (before the founder's decision)

**Option A**, with two safeguards that keep B open:

1. The engine talks to an `EphemerisBackend` interface (positions, nodes, ayanamsha, houses,
   rise/set). The Swiss Ephemeris adapter is one implementation. A Skyfield adapter can be added
   later without touching endpoint code.
2. The golden-fixture harness (`/evals/astro`) checks tropical positions against **JPL
   Horizons**, an independent source, so we never validate Swiss Ephemeris only against itself.

Until the licence is signed, Swiss Ephemeris runs **only in local development and CI**, never in
a deployment reachable by users. If the founder prefers not to pay, choose **B**. The interface
and the fixtures stay the same; Phase 1 grows by the ayanamsha/node work and their validation.

## Decision: option C

The founder chose **C**: Swiss Ephemeris under AGPL-3.0, with the astro engine published as
open source. How the code keeps that boundary:

- Only `services/astro` may import `swisseph`. A test (`test_only_the_astro_service_imports_swiss_ephemeris`)
  fails the build if any other code does. The eval harness may use it only through the engine.
- `services/astro` is licensed `AGPL-3.0-only` (`services/astro/LICENSE`, `pyproject.toml`).
  Every other service talks to it over HTTP only; nothing links to it.
- `/v1/source` and `/v1/meta` link to the engine's source, as AGPL §13 requires for users who
  interact with it over a network.
- The ephemeris files are fetched with pinned SHA-256 checksums (`data/fetch_ephemeris.py`).

**Conditions before any public deployment** (tracked in COMPLIANCE.md):

1. A lawyer confirms that keeping the AGPL engine as a separate network service is enough for
   the rest of the platform to stay outside the AGPL's "corresponding source".
2. The engine's source is reachable at the `/v1/source` URL. Today that points at this repo;
   if the repo stays private, publish `services/astro` (with `data/astro` and the data
   scripts) as a public repository and update `SOURCE_URL`.
3. Any change to the engine is published there before it is deployed.

If the lawyer says no, switch to option A (buy the licence; no code change) or B (implement the
`EphemerisBackend` interface on Skyfield + JPL; the golden fixtures stay the same).

## Decisions this ADR also fixes

- Default ayanamsha: **Lahiri** (Swiss Ephemeris `SE_SIDM_LAHIRI`), configurable per request.
- Default node: **mean node** for Rahu/Ketu, true node available as an option. Most Indian
  almanacs use mean; record the choice in every API response.
- Ephemeris files: Swiss Ephemeris `sepl_18.se1` and `semo_18.se1` (1800–2399 CE) shipped in
  the astro image. The Moshier fallback is refused unless `ALLOW_MOSHIER` is set outside
  production, so precision never silently drops: a call that falls back raises an error.
- Every response carries `engine`, `engine_version`, `ayanamsha`, `node_type` so results are
  reproducible.

## Consequences

- Founder action: decide A/B/C; if A, buy before Phase 1 ships anything public.
- House-system choice goes in its own ADR in Phase 1. Whole-sign is the default for Vedic charts
  and works at any latitude; Placidus fails above the polar circles (fixture C11).
