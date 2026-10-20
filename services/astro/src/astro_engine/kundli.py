"""Birth chart: sidereal graha positions, ascendant and whole-sign houses (ADR-0004)."""

from datetime import timedelta
from typing import Any

from astro_engine.ephemeris import GRAHA_ORDER, Ayanamsha, EphemerisBackend, NodeType
from astro_engine.timeutil import ResolvedTime, iso_z, jd_from_utc
from astro_engine.zodiac import placement


def chart_settings(
    backend: EphemerisBackend, jd: float, ayanamsha: Ayanamsha, node: NodeType
) -> dict[str, Any]:
    return {
        "engine": backend.name,
        "engine_version": backend.version,
        "zodiac": "sidereal",
        "ayanamsha": ayanamsha,
        "ayanamsha_deg": round(backend.ayanamsha(jd, ayanamsha), 6),
        "node": node,
        "house_system": "whole_sign",
        "positions": "geocentric apparent",
    }


def graha_positions(
    backend: EphemerisBackend, jd: float, ayanamsha: Ayanamsha, node: NodeType
) -> list[dict[str, Any]]:
    out = []
    for graha in GRAHA_ORDER:
        pos = backend.body(jd, graha, ayanamsha, node)
        out.append(
            {
                "id": graha,
                **placement(pos.sidereal),
                "tropical_longitude": round(pos.tropical, 6),
                "speed_deg_per_day": round(pos.speed, 6),
                "retrograde": pos.speed < 0,
            }
        )
    return out


def compute_kundli(
    backend: EphemerisBackend,
    when: ResolvedTime,
    lat: float,
    lon: float,
    ayanamsha: Ayanamsha = "lahiri",
    node: NodeType = "mean",
) -> dict[str, Any]:
    jd = when.jd
    grahas = graha_positions(backend, jd, ayanamsha, node)
    flags: list[str] = []
    ascendant = None
    houses = None
    moon_range = None

    if when.assumed_time:
        # Without a birth time there is no ascendant and no houses. Planets are computed for local
        # noon; only the Moon moves enough in a day to matter, so report its range.
        flags.append("unknown_birth_time")
        start = when.local.replace(hour=0, minute=0, second=0)
        end = start + timedelta(hours=23, minutes=59, seconds=59)
        moon_start = placement(backend.body(jd_from_utc(start), "moon", ayanamsha, node).sidereal)
        moon_end = placement(backend.body(jd_from_utc(end), "moon", ayanamsha, node).sidereal)
        moon_range = {
            "start": {"at": iso_z(start), **moon_start},
            "end": {"at": iso_z(end), **moon_end},
            "sign_changes": moon_start["sign"] != moon_end["sign"],
            "nakshatra_changes": moon_start["nakshatra"] != moon_end["nakshatra"],
        }
    else:
        asc = placement(backend.ascendant(jd, lat, lon, ayanamsha))
        ascendant = asc
        houses = []
        for n in range(12):
            sign_index = (asc["sign_index"] + n) % 12
            houses.append(
                {
                    "house": n + 1,
                    "sign_index": sign_index,
                    "occupants": [g["id"] for g in grahas if g["sign_index"] == sign_index],
                }
            )
        for g in grahas:
            g["house"] = (g["sign_index"] - asc["sign_index"]) % 12 + 1

    return {
        "birth": {
            "utc": iso_z(when.utc),
            "local": when.local.isoformat(),
            "tz": when.tz,
            "utc_offset": when.utc_offset,
            "unknown_time": when.assumed_time,
            "julian_day_ut": round(jd, 8),
        },
        "place": {"lat": lat, "lon": lon},
        "settings": chart_settings(backend, jd, ayanamsha, node),
        "ascendant": ascendant,
        "grahas": grahas,
        "houses": houses,
        "moon_range": moon_range,
        "flags": flags,
    }
