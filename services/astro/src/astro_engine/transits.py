"""Graha positions at an instant, optionally counted from a natal Moon sign (gochara)."""

from datetime import datetime
from typing import Any

from astro_engine.ephemeris import Ayanamsha, EphemerisBackend, NodeType
from astro_engine.kundli import chart_settings, graha_positions
from astro_engine.timeutil import iso_z, jd_from_utc


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
