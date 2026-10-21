"""Graha positions at an instant, optionally counted from a natal Moon sign (gochara)."""

import math
from datetime import datetime
from typing import Any

from astro_engine.ephemeris import Ayanamsha, EphemerisBackend, NodeType
from astro_engine.kundli import chart_settings, graha_positions
from astro_engine.timeutil import iso_z, jd_from_utc


def sign_at(backend: EphemerisBackend, jd: float, graha: str, ayanamsha: Ayanamsha) -> int:
    return math.floor(backend.body(jd, graha, ayanamsha, "mean").sidereal / 30.0) % 12


def sign_changes(
    backend: EphemerisBackend,
    graha: str,
    jd0: float,
    jd1: float,
    ayanamsha: Ayanamsha,
    step: float,
    tol: float,
) -> list[tuple[float, int]]:
    """(jd, new sign) for every sidereal sign change of a graha in (jd0, jd1], including
    retrograde re-entries. Scans every `step` days, then bisects to within `tol` days."""
    out = []
    jd, sign = jd0, sign_at(backend, jd0, graha, ayanamsha)
    while jd < jd1:
        nxt = min(jd + step, jd1)
        nsign = sign_at(backend, nxt, graha, ayanamsha)
        if nsign != sign:
            lo, hi = jd, nxt
            while hi - lo > tol:
                mid = (lo + hi) / 2
                if sign_at(backend, mid, graha, ayanamsha) == sign:
                    lo = mid
                else:
                    hi = mid
            out.append((hi, nsign))
            sign = nsign
        jd = nxt
    return out


def compute_transits(
    backend: EphemerisBackend,
    at: datetime,
    ayanamsha: Ayanamsha = "lahiri",
    node: NodeType = "mean",
    natal_moon_sign_index: int | None = None,
) -> dict[str, Any]:
    jd = jd_from_utc(at)
    grahas = graha_positions(backend, jd, ayanamsha, node)
    if natal_moon_sign_index is not None:
        for g in grahas:
            g["house_from_moon"] = (g["sign_index"] - natal_moon_sign_index) % 12 + 1
    return {
        "at": iso_z(at),
        "settings": chart_settings(backend, jd, ayanamsha, node),
        "grahas": grahas,
    }
