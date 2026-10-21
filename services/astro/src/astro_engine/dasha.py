"""Vimshottari dasha from the Moon's sidereal longitude at birth."""

from datetime import datetime, timedelta
from typing import Any

from astro_engine.tables import NAKSHATRA_SPAN, get_tables
from astro_engine.timeutil import iso_z


def _period(
    lord: str, start: datetime, years: float, year_days: float
) -> tuple[dict[str, Any], datetime]:
    end = start + timedelta(days=years * year_days)
    return {"lord": lord, "start": iso_z(start), "end": iso_z(end), "years": round(years, 6)}, end


def vimshottari(
    moon_sidereal: float, birth_utc: datetime, as_of: datetime | None = None
) -> dict[str, Any]:
    t = get_tables()
    seq: list[dict[str, Any]] = t.vimshottari["sequence"]
    year_days = float(t.vimshottari["year_days"])
    total = sum(p["years"] for p in seq)

    lon = moon_sidereal % 360.0
    nak_i = int(lon // NAKSHATRA_SPAN)
    elapsed_fraction = (lon - nak_i * NAKSHATRA_SPAN) / NAKSHATRA_SPAN
    lord = t.nakshatras[nak_i]["lord"]
    first = next(i for i, p in enumerate(seq) if p["lord"] == lord)
    first_years = seq[first]["years"]

    start = birth_utc - timedelta(days=elapsed_fraction * first_years * year_days)
    mahadashas = []
    for k in range(len(seq)):
        md = seq[(first + k) % len(seq)]
        entry, md_end = _period(md["lord"], start, md["years"], year_days)
        sub_start = start
        subs = []
        for j in range(len(seq)):
            ad = seq[(first + k + j) % len(seq)]
            sub, sub_start = _period(
                ad["lord"], sub_start, md["years"] * ad["years"] / total, year_days
            )
            subs.append(sub)
        entry["antardashas"] = subs
        mahadashas.append(entry)
        start = md_end

    result: dict[str, Any] = {
        "system": "vimshottari",
        "year_days": year_days,
        "moon_nakshatra": t.nakshatras[nak_i]["id"],
        "balance_at_birth": {
            "lord": lord,
            "years": round((1 - elapsed_fraction) * first_years, 6),
        },
        "mahadashas": mahadashas,
        "current": None,
    }
    if as_of is not None:
        stamp = iso_z(as_of)
        for md in mahadashas:
            if md["start"] <= stamp < md["end"]:
                current_ad: dict[str, Any] | None = next(
                    (a for a in md["antardashas"] if a["start"] <= stamp < a["end"]), None
                )
                result["current"] = {
                    "as_of": stamp,
                    "mahadasha": md["lord"],
                    "antardasha": current_ad["lord"] if current_ad else None,
                }
    return result
