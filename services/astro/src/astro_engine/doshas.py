"""Dosha checks. Each applies one documented rule from data/astro/doshas.json and says so."""

import math
from datetime import datetime
from typing import Any

from astro_engine.ephemeris import Ayanamsha, EphemerisBackend
from astro_engine.tables import get_tables
from astro_engine.timeutil import iso_z, jd_from_utc, utc_from_jd


def _by_id(chart: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {g["id"]: g for g in chart["grahas"]}


def mangal_dosha(chart: dict[str, Any]) -> dict[str, Any]:
    rule = get_tables().doshas["mangal"]
    g = _by_id(chart)
    mars, moon = g["mars"]["sign_index"], g["moon"]["sign_index"]
    from_points: dict[str, int | None] = {"moon": (mars - moon) % 12 + 1}
    if chart["ascendant"] is not None:
        from_points["lagna"] = (mars - chart["ascendant"]["sign_index"]) % 12 + 1
    else:
        from_points["lagna"] = None  # unknown birth time
    hits = [p for p, house in from_points.items() if house in rule["houses"]]
    return {
        "present": bool(hits),
        "from": hits,
        "mars_house_from": from_points,
        "rule": rule["note"],
        "houses_checked": rule["houses"],
    }


def kaal_sarp(chart: dict[str, Any]) -> dict[str, Any]:
    rule = get_tables().doshas["kaal_sarp"]
    g = _by_id(chart)
    rahu = g["rahu"]["longitude"]
    offsets = [(g[p]["longitude"] - rahu) % 360.0 for p in rule["planets"]]
    rahu_to_ketu = all(0 < o < 180 for o in offsets)
    ketu_to_rahu = all(180 < o < 360 for o in offsets)
    present = rahu_to_ketu or ketu_to_rahu
    kind = None
    if present and chart["ascendant"] is not None:
        house = g["rahu"]["house"]
        kind = rule["types_by_rahu_house"][str(house)]
    return {
        "present": present,
        "direction": "rahu_to_ketu" if rahu_to_ketu else "ketu_to_rahu" if ketu_to_rahu else None,
        "type": kind,
        "rule": rule["note"],
    }


def _saturn_sign(backend: EphemerisBackend, jd: float, ayanamsha: Ayanamsha) -> int:
    return math.floor(backend.body(jd, "saturn", ayanamsha, "mean").sidereal / 30.0) % 12


def saturn_sign_periods(
    backend: EphemerisBackend,
    jd_start: float,
    jd_end: float,
    ayanamsha: Ayanamsha,
    step_days: float = 5.0,
) -> list[tuple[float, float, int]]:
    """Saturn's sidereal sign as a list of (start_jd, end_jd, sign) covering [jd_start, jd_end].
    Retrograde re-entries appear as separate periods. Boundaries refined to ~10 seconds."""
    periods = []
    start, sign = jd_start, _saturn_sign(backend, jd_start, ayanamsha)
    jd = jd_start
    while jd < jd_end:
        nxt = min(jd + step_days, jd_end)
        nsign = _saturn_sign(backend, nxt, ayanamsha)
        if nsign != sign:
            lo, hi = jd, nxt
            while hi - lo > 1e-4:
                mid = (lo + hi) / 2
                if _saturn_sign(backend, mid, ayanamsha) == sign:
                    lo = mid
                else:
                    hi = mid
            periods.append((start, hi, sign))
            start, sign = hi, nsign
        jd = nxt
    periods.append((start, jd_end, sign))
    return periods


def sade_sati(
    backend: EphemerisBackend,
    moon_sign_index: int,
    birth: datetime,
    as_of: datetime,
    ayanamsha: Ayanamsha = "lahiri",
    years: int = 100,
) -> dict[str, Any]:
    rule = get_tables().doshas["sade_sati"]
    signs = {(moon_sign_index + o) % 12: str(o) for o in rule["offsets_from_moon_sign"]}
    jd0 = jd_from_utc(birth)
    jd1 = jd0 + years * 365.25
    phases = [
        {
            "phase": rule["phase_names"][signs[sign]],
            "saturn_sign_index": sign,
            "start": iso_z(utc_from_jd(a)),
            "end": iso_z(utc_from_jd(b)),
        }
        for a, b, sign in saturn_sign_periods(backend, jd0, jd1, ayanamsha)
        if sign in signs
    ]
    # Group phases into cycles. A short retrograde exit and re-entry stays in the same cycle;
    # cycles are ~30 years apart, so any gap under 3 years is the same cycle.
    cycles: list[dict[str, Any]] = []
    for ph in phases:
        gap_days = (
            (datetime.fromisoformat(ph["start"]) - datetime.fromisoformat(cycles[-1]["end"])).days
            if cycles
            else None
        )
        if gap_days is not None and gap_days < 3 * 365:
            cycles[-1]["phases"].append(ph)
            cycles[-1]["end"] = ph["end"]
        else:
            cycles.append({"start": ph["start"], "end": ph["end"], "phases": [ph]})
    stamp = iso_z(as_of)
    current = next((p for p in phases if p["start"] <= stamp < p["end"]), None)
    return {
        "moon_sign_index": moon_sign_index,
        "active": current is not None,
        "current_phase": current,
        "cycles": cycles,
        "rule": rule["note"],
        "window_years": years,
    }
