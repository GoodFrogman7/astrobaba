# Astro engine golden fixtures

Status: **proposal** (Phase 0). Phase 1 fills every `expected` block and wires these files into CI.
A regression against them blocks merges (PLAN.md §7).

| File | What | Rows |
|---|---|---|
| `fixtures/charts.yaml` | Birth charts: grahas, ascendant, nakshatra/pada, dasha | 14 charts + 2 invalid inputs |
| `fixtures/almanac.yaml` | Daily panchang: sunrise/sunset, tithi, nakshatra, Rahu Kaal | 34 date × place rows |

## Why synthetic charts

The plan asks for public-domain charts. Famous-person charts carry disputed birth times and are
personal data; the engine does not care whose chart it is. Synthetic instants are public domain by
construction and let us pick edge cases on purpose (historical offsets, DST, high latitude,
date rollovers, leap day, unknown time). If you want a few well-known historical charts as an
extra sanity check, add them with a Rodden AA source cited, as a separate file.

## Where expected values come from (never hand-typed, never from an LLM)

| Quantity | Primary reference | Cross-check | Notes |
|---|---|---|---|
| Tropical geocentric apparent longitude, Sun to Saturn | JPL Horizons API (observer table, ecliptic of date) | — | US government work, public domain |
| Sidereal longitude (Lahiri), Rahu/Ketu, ascendant | Swiss Ephemeris via `pyswisseph`, **run only in the eval harness** | Indian Astronomical Ephemeris yearly ayanamsha | Running AGPL code privately in CI does not trigger AGPL obligations; see ADR-0001 |
| Sunrise, sunset | US Naval Observatory API (public domain) | NOAA solar calculator | Upper limb, 34′ refraction. If an almanac uses disc centre, record it as a convention difference |
| Tithi, nakshatra end times; adhik masa; kshaya/vriddhi picks | Rashtriya Panchang (Positional Astronomy Centre, Govt. of India) | One independent published almanac | Transcribed by hand from the published tables, with source and page/URL per value |
| Rahu Kaal | Derived from our sunrise/sunset and the weekday slot table | Published almanac, ±2 min | The slot table lives in `/data`, not in code |

The sandbox Phase 0 was built in cannot reach Horizons or USNO, so a fetch script
(`scripts/fetch_reference.py`, Phase 1) runs on a developer machine or in CI and commits values
with provenance.

## Property tests (Phase 1)

- Ashtakoota: total = sum of the 8 kootas; each koota within its max (1, 2, 3, 4, 5, 6, 7, 8); total ≤ 36.
- Rahu Kaal: always the weekday's slot of 8 equal daytime parts; inside sunrise–sunset.
- Tithi = floor((Moon − Sun) mod 360 / 12) + 1; nakshatra = floor(sidereal Moon / 13°20′) + 1.
- Monotonic: tithi and nakshatra indices only advance (mod wrap) as time advances.
- Unknown birth time: no ascendant, no houses, `unknown_birth_time` flag set.
