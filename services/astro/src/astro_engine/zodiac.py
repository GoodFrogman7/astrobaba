"""Derive sign, nakshatra and pada from a sidereal longitude, using data/astro tables."""

import math
from typing import Any

from astro_engine.tables import NAKSHATRA_SPAN, PADA_SPAN, get_tables

# Floating-point guard so 29.99999999° is not reported as the next sign.
_EPS = 1e-9


def _index(longitude: float, span: float, count: int) -> int:
    return math.floor((longitude % 360.0) / span + _EPS) % count


def placement(longitude: float) -> dict[str, Any]:
    t = get_tables()
    lon = longitude % 360.0
    sign_i = _index(lon, 30.0, 12)
    nak_i = _index(lon, NAKSHATRA_SPAN, 27)
    pada = math.floor((lon - nak_i * NAKSHATRA_SPAN) / PADA_SPAN + _EPS) % 4 + 1
    sign, nak = t.signs[sign_i], t.nakshatras[nak_i]
    return {
        "longitude": round(lon, 6),
        "sign": sign["id"],
        "sign_index": sign_i,
        "sign_lord": sign["lord"],
        "degree_in_sign": round(lon - sign_i * 30.0, 6),
        "dms_in_sign": dms(lon - sign_i * 30.0),
        "nakshatra": nak["id"],
        "nakshatra_index": nak_i,
        "nakshatra_lord": nak["lord"],
        "pada": pada,
    }


def dms(degrees: float) -> str:
    """12.5083 → 12°30'30" (truncating, so the sign boundary is never crossed by rounding)."""
    total = math.floor(degrees * 3600 + _EPS)
    d, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{d}°{m:02d}'{s:02d}\""
