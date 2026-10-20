# ADR-0004: Astro engine conventions

- Status: Accepted (engineering defaults; an astrologer may revisit the Jyotish choices)
- Date: 2026-10-20

Vedic almanacs disagree mostly because of conventions, not astronomy. These are ours. Every
response states the ones it used (`settings` block), so results are reproducible.

| Topic | Choice | Why / alternatives |
|---|---|---|
| Zodiac | Sidereal | Vedic standard |
| Ayanamsha | Lahiri (Swiss Ephemeris `SIDM_LAHIRI`) by default; `raman`, `krishnamurti`, `true_chitra` on request | Official Indian (Calendar Reform Committee) ayanamsha |
| Positions | Geocentric, apparent, true equinox of date | Same as JPL Horizons quantity 31, which we validate against |
| Rahu / Ketu | Mean node by default; true node on request | Most Indian almanacs use the mean node; Ketu = Rahu + 180° |
| Houses | **Whole sign**: house 1 is the lagna's sign | Traditional for Parashari charts and defined at every latitude. Quadrant systems (Placidus etc.) fail above the polar circles (fixture C11). Bhava chalit can be added later. |
| Unknown birth time | No lagna, no houses, flag `unknown_birth_time`; planets at local noon; Moon reported at 00:00 and 23:59:59 local so a sign/nakshatra change that day is visible | Never guess a lagna |
| Historical offsets | tz database by default; caller may pass `utc_offset` (e.g. `+05:53`) for births where local practice differed (pre-1955 Indian city times) | tzdata models one zone for all of India |
| Nonexistent / ambiguous local times | Rejected with codes `nonexistent_local_time` / `ambiguous_local_time`; ambiguous accepted with `fold` | Never silently shift a birth time |
| Sunrise / sunset | Upper limb on the horizon, standard refraction (1013.25 hPa, 15 °C), sea level | Same as USNO, our reference. Some panchangs use disc centre ("Hindu rising"); add as an option if a reviewer asks |
| Panchang day | Sunrise to next sunrise at the place; vaara = weekday of the local date | Standard. Elements are returned as every span touching the day, with `kshaya` / `vriddhi` flags |
| Rahu Kaal | Daytime split into 8 equal parts; weekday part from `data/astro/weekdays.json` | Standard table |
| Vimshottari | Balance from the Moon's position in its nakshatra; year = 365.25 days | Julian year is common; 365.2425 and 360-day years exist. The value lives in `data/astro/vimshottari.json` |
| Mangal dosha | Mars in houses 1, 2, 4, 7, 8, 12 from lagna or Moon; no cancellations in v1 | Many variants; rules in `data/astro/doshas.json`, pending astrologer review |
| Kaal Sarp | All seven planets strictly on one side of the nodal axis; type named by Rahu's house | Partial Kaal Sarp not reported in v1 |
| Sade Sati | Saturn in the 12th, 1st and 2nd sidereal sign from the natal Moon; retrograde re-entries kept as separate phases, gaps under 3 years stay in one cycle | |
| Ashtakoota | North Indian 36-point system; tables in `data/astro/matching.json` | Yoni, vashya and gana tables vary between sources. **Production refuses `/v1/match` and `/v1/doshas` until an astrologer marks the tables verified** |
| Time output | UTC instants (ISO-8601 `Z`) plus the IANA zone; formatting at the edge | PLAN.md §5 Phase 1 |
| Not in Phase 1 | Masa names and adhik masa, yamaganda, gulika, choghadiya, hora, moonrise | Phase 2, with their own fixtures |
