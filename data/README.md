# Static data

| Path | What | Source / licence |
|---|---|---|
| `astro/*.json` | Jyotish reference tables: names (en/hi), lords, panchang name lists, Vimshottari periods, Rahu Kaal weekday parts, dosha rules, Ashtakoota tables | Standard Jyotish texts and commonly published tables; each file names its source. Files with a `review` block need a vetted astrologer's sign-off before the features that use them go public. |
| `build/cities.tsv.gz` | City index for place search (generated, gitignored) | GeoNames, CC-BY 4.0. Attribution required wherever place data is shown. |
| `raw/` | Downloads (Swiss Ephemeris files, GeoNames dumps); gitignored | Swiss Ephemeris files are AGPL-3.0 (ADR-0001). |

Generate everything with `make data` (needs network the first time).

Rules for these files: values here are static tradition or published data, never computed
astronomy and never LLM output. Change them only with a cited source.
