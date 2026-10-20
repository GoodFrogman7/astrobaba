"""Daily panchang for a place: the Hindu day runs from sunrise to the next sunrise."""

import math
from collections.abc import Callable
from datetime import date
from typing import Any

from astro_engine.ephemeris import Ayanamsha, EphemerisBackend, norm
from astro_engine.tables import KARANA_SPAN, NAKSHATRA_SPAN, TITHI_SPAN, get_table, get_tables
from astro_engine.timeutil import (
    TimeInputError,
    iso_z,
    jd_from_utc,
    local_midnight_utc,
    utc_from_jd,
    zone,
)
from astro_engine.zodiac import placement

AngleFn = Callable[[float], tuple[float, float]]  # jd → (angle degrees, rate degrees/day)


def crossing(fn: AngleFn, jd0: float, span: float, *, forward: bool) -> float:
    """Time the angle next (or last) crossed a multiple of `span`, by Newton iteration."""
    angle, _ = fn(jd0)
    k = math.floor(angle / span + 1e-12)
    target = (k + 1) * span if forward else k * span
    jd = jd0
    for _ in range(40):
        angle, rate = fn(jd)
        diff = ((target - angle + 180.0) % 360.0) - 180.0
        if abs(diff) < 1e-9:
            break
        jd += diff / rate
    return jd


def spans(
    fn: AngleFn, span: float, count: int, day_start: float, day_end: float
) -> list[dict[str, Any]]:
    """Every element (tithi, nakshatra, …) that is current at any moment of [day_start, day_end)."""
    out = []
    start = crossing(fn, day_start, span, forward=False)
    while start < day_end:
        end = crossing(fn, max(start, day_start) + 1e-7, span, forward=True)
        mid_angle, _ = fn((start + end) / 2)
        index = int(mid_angle // span) % count
        out.append({"index": index, "start_jd": start, "end_jd": end})
        start = end
    for s in out:
        s["kshaya"] = s["start_jd"] > day_start and s["end_jd"] < day_end  # spans no sunrise
        s["vriddhi"] = s["start_jd"] <= day_start and s["end_jd"] >= day_end  # spans both sunrises
    return out


def _named(s: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    return {
        **entry,
        "start": iso_z(utc_from_jd(s["start_jd"])),
        "end": iso_z(utc_from_jd(s["end_jd"])),
        "kshaya": s["kshaya"],
        "vriddhi": s["vriddhi"],
    }


def _even_parts(start: float, end: float, n: int) -> list[tuple[float, float]]:
    step = (end - start) / n
    return [(start + i * step, start + (i + 1) * step) for i in range(n)]


def choghadiya(
    weekday_lord: str, sunrise: float, sunset: float, next_sunrise: float
) -> dict[str, Any]:
    """Day and night choghadiya (data/astro/choghadiya.json)."""
    table = get_table("choghadiya")
    cycle: list[dict[str, Any]] = table["cycle"]
    n = len(cycle)
    day_start = next(i for i, c in enumerate(cycle) if c["planet"] == weekday_lord)
    night_start = (day_start + table["night_start_offset"]) % n

    def run(first: int, step: int, start: float, end: float) -> list[dict[str, Any]]:
        out = []
        for k, (a, b) in enumerate(_even_parts(start, end, table["parts"])):
            c = cycle[(first + k * step) % n]
            out.append({**c, "start": iso_z(utc_from_jd(a)), "end": iso_z(utc_from_jd(b))})
        return out

    return {
        "day": run(day_start, table["day_step"], sunrise, sunset),
        "night": run(night_start, table["night_step"], sunset, next_sunrise),
    }


def horas(
    weekday_lord: str, sunrise: float, sunset: float, next_sunrise: float
) -> list[dict[str, Any]]:
    """24 planetary hours from sunrise (data/astro/hora.json)."""
    table = get_table("hora")
    order: list[str] = table["chaldean_order"]
    first = order.index(weekday_lord)
    k = table["parts_per_half"]
    spans_ = [("day", a, b) for a, b in _even_parts(sunrise, sunset, k)] + [
        ("night", a, b) for a, b in _even_parts(sunset, next_sunrise, k)
    ]
    return [
        {
            "number": i + 1,
            "lord": order[(first + i) % len(order)],
            "part": part,
            "start": iso_z(utc_from_jd(a)),
            "end": iso_z(utc_from_jd(b)),
        }
        for i, (part, a, b) in enumerate(spans_)
    ]


def compute_panchang(
    backend: EphemerisBackend,
    day: date,
    lat: float,
    lon: float,
    tz: str,
    ayanamsha: Ayanamsha = "lahiri",
) -> dict[str, Any]:
    t = get_tables()
    zone(tz)
    jd_midnight = jd_from_utc(local_midnight_utc(day, tz))
    sunrise = backend.sunrise(jd_midnight, lat, lon)
    sunset = backend.sunset(sunrise, lat, lon) if sunrise else None
    next_sunrise = backend.sunrise(sunset, lat, lon) if sunset else None
    if sunrise is None or sunset is None or next_sunrise is None:
        raise TimeInputError(
            "no_sunrise", "The Sun does not rise or set at this place on this date."
        )
    if sunrise - jd_midnight >= 1.0:
        raise TimeInputError("no_sunrise", "The Sun does not rise at this place on this date.")

    def sun_moon(jd: float) -> tuple[Any, Any]:
        return backend.body(jd, "sun", ayanamsha, "mean"), backend.body(
            jd, "moon", ayanamsha, "mean"
        )

    def elongation(jd: float) -> tuple[float, float]:
        s, m = sun_moon(jd)
        return norm(m.tropical - s.tropical), m.speed - s.speed

    def moon_sidereal(jd: float) -> tuple[float, float]:
        m = backend.body(jd, "moon", ayanamsha, "mean")
        return m.sidereal, m.speed

    def yoga_angle(jd: float) -> tuple[float, float]:
        s, m = sun_moon(jd)
        return norm(s.sidereal + m.sidereal), s.speed + m.speed

    tithis = [
        _named(s, t.tithis[s["index"]])
        for s in spans(elongation, TITHI_SPAN, 30, sunrise, next_sunrise)
    ]
    nakshatras = [
        _named(
            s,
            {
                "number": s["index"] + 1,
                **{k: t.nakshatras[s["index"]][k] for k in ("id", "en", "hi", "lord")},
            },
        )
        for s in spans(moon_sidereal, NAKSHATRA_SPAN, 27, sunrise, next_sunrise)
    ]
    yogas = [
        _named(s, t.yogas[s["index"]])
        for s in spans(yoga_angle, NAKSHATRA_SPAN, 27, sunrise, next_sunrise)
    ]
    karanas = []
    for s in spans(elongation, KARANA_SPAN, 60, sunrise, next_sunrise):
        n = s["index"] + 1
        k = t.karanas_fixed.get(str(n)) or t.karanas_movable[(n - 2) % 7]
        karanas.append(_named(s, {"number": n, **k}))

    weekday = t.weekdays[day.isoweekday() - 1]
    part = (sunset - sunrise) / 8
    rk_start = sunrise + (weekday["rahu_kaal_part"] - 1) * part
    sun, moon = sun_moon(sunrise)

    return {
        "date": day.isoformat(),
        "place": {"lat": lat, "lon": lon, "tz": tz},
        "settings": {
            "engine": backend.name,
            "engine_version": backend.version,
            "ayanamsha": ayanamsha,
            "sunrise_convention": "upper limb, standard refraction (1013.25 hPa, 15 °C), sea level",
            "day": "sunrise to next sunrise",
            "tables_review_status": {"choghadiya": get_table("choghadiya")["review"]["status"]},
        },
        "vaara": {k: weekday[k] for k in ("iso", "id", "en", "hi", "lord")},
        "sunrise": iso_z(utc_from_jd(sunrise)),
        "sunset": iso_z(utc_from_jd(sunset)),
        "next_sunrise": iso_z(utc_from_jd(next_sunrise)),
        "rahu_kaal": {
            "part": weekday["rahu_kaal_part"],
            "start": iso_z(utc_from_jd(rk_start)),
            "end": iso_z(utc_from_jd(rk_start + part)),
        },
        "tithi_at_sunrise": tithis[0],
        "nakshatra_at_sunrise": nakshatras[0],
        "tithis": tithis,
        "nakshatras": nakshatras,
        "yogas": yogas,
        "karanas": karanas,
        "choghadiya": choghadiya(weekday["lord"], sunrise, sunset, next_sunrise),
        "hora": horas(weekday["lord"], sunrise, sunset, next_sunrise),
        "sun_at_sunrise": placement(sun.sidereal),
        "moon_at_sunrise": placement(moon.sidereal),
    }
