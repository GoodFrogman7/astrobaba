"""Horoscope facts: transits counted from a Moon sign and rule-based life-area scores.

Everything here is computed from the ephemeris and data/astro/horoscope_rules.json. Prose is
written elsewhere (an LLM, then a human QA queue) and may only describe these facts.
"""

import math
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from astro_engine.ephemeris import GRAHA_ORDER, Ayanamsha, EphemerisBackend
from astro_engine.tables import get_table, get_tables
from astro_engine.timeutil import iso_z, jd_from_utc, utc_from_jd
from astro_engine.transits import sign_at, sign_changes
from astro_engine.zodiac import placement

Period = Literal["daily", "weekly", "monthly"]
IST = ZoneInfo("Asia/Kolkata")
# Scan steps (days) for sign-change search; each well under the shortest stay in a sign.
_SCAN_STEP = {"moon": 0.25, "sun": 1.0, "mercury": 0.5, "venus": 1.0, "mars": 1.0}
_DEFAULT_STEP = 2.0


def ist_midnight(day: date) -> datetime:
    return datetime.combine(day, time(0, 0), tzinfo=IST).astimezone(UTC)


def window(period: Period, day: date) -> tuple[date, date]:
    """First and last IST calendar dates of the period containing `day`."""
    if period == "daily":
        return day, day
    if period == "weekly":
        monday = day - timedelta(days=day.isoweekday() - 1)
        return monday, monday + timedelta(days=6)
    first = day.replace(day=1)
    nxt = (first + timedelta(days=32)).replace(day=1)
    return first, nxt - timedelta(days=1)


def ingresses(
    backend: EphemerisBackend, graha: str, jd0: float, jd1: float, ayanamsha: Ayanamsha
) -> list[dict[str, Any]]:
    """Sign changes of a graha in (jd0, jd1], refined by bisection to about a minute."""
    step = _SCAN_STEP.get(graha, _DEFAULT_STEP)
    signs = get_tables().signs
    return [
        {"at": iso_z(utc_from_jd(at)), "to_sign": signs[sign]["id"]}
        for at, sign in sign_changes(backend, graha, jd0, jd1, ayanamsha, step, 5e-4)
    ]


def _score(r: float, thresholds: list[float]) -> int:
    if r <= thresholds[0]:
        return 1
    if r <= thresholds[1]:
        return 2
    if r < thresholds[2]:
        return 3
    if r < thresholds[3]:
        return 4
    return 5


def area_weights(period: Period) -> dict[str, dict[str, float]]:
    rules = get_table("horoscope_rules")
    out: dict[str, dict[str, float]] = {}
    for area, weights in rules["areas"].items():
        w = {g: float(v) for g, v in weights.items()}
        if period == "daily":
            dm = rules["daily_moon"]
            w["moon"] = w.get("moon", float(dm["default_weight"])) * dm["multiplier"]
        elif period in rules["periods_without_moon"]:
            w.pop("moon", None)
        out[area] = w
    return out


def compute_horoscope_facts(
    backend: EphemerisBackend,
    sign_id: str,
    period: Period,
    day: date,
    ayanamsha: Ayanamsha = "lahiri",
) -> dict[str, Any]:
    t = get_tables()
    rules = get_table("horoscope_rules")
    sign_index = next(i for i, s in enumerate(t.signs) if s["id"] == sign_id)
    first, last = window(period, day)
    start, end = ist_midnight(first), ist_midnight(last + timedelta(days=1))
    jd0, jd1 = jd_from_utc(start), jd_from_utc(end)
    jd_mid = (jd0 + jd1) / 2
    jd_moon = jd_from_utc(datetime.combine(day, time(12, 0), tzinfo=IST).astimezone(UTC))

    def house(graha: str, jd: float) -> int:
        return (sign_at(backend, jd, graha, ayanamsha) - sign_index) % 12 + 1

    # Positions in `transits` are taken at the same instants the scores use (window midpoint;
    # 12:00 IST for the daily Moon), so the table and the score reasons always agree.
    evaluated = {g: (jd_moon if g == "moon" and period == "daily" else jd_mid) for g in GRAHA_ORDER}
    transits = []
    for g in GRAHA_ORDER:
        pos = backend.body(evaluated[g], g, ayanamsha, "mean")
        transits.append(
            {
                "graha": g,
                "sign": t.signs[math.floor(pos.sidereal / 30.0) % 12]["id"],
                "house_from_sign": house(g, evaluated[g]),
                "retrograde": pos.speed < 0,
                "evaluated_at": iso_z(utc_from_jd(evaluated[g])),
                "ingresses": [] if g == "ketu" else ingresses(backend, g, jd0, jd1, ayanamsha),
            }
        )
    # Ketu mirrors Rahu: same instants, opposite sign.
    sign_ids = [s["id"] for s in t.signs]
    rahu = next(x for x in transits if x["graha"] == "rahu")
    ketu = next(x for x in transits if x["graha"] == "ketu")
    ketu["ingresses"] = [
        {"at": i["at"], "to_sign": sign_ids[(sign_ids.index(i["to_sign"]) + 6) % 12]}
        for i in rahu["ingresses"]
    ]

    houses = {x["graha"]: x["house_from_sign"] for x in transits}
    areas: dict[str, Any] = {}
    for area, weights in area_weights(period).items():
        reasons = []
        total = signed = 0.0
        for g, w in weights.items():
            fav = houses[g] in rules["favourable_houses"][g]
            reasons.append(
                {
                    "graha": g,
                    "house_from_sign": houses[g],
                    "effect": "favourable" if fav else "challenging",
                    "weight": w,
                }
            )
            total += w
            signed += w if fav else -w
        score = _score(signed / total, rules["thresholds"])
        areas[area] = {"score": score, "label": rules["labels"][str(score)], "reasons": reasons}

    lord = t.signs[sign_index]["lord"]
    numbers = {v: int(k) for k, v in get_table("numerology")["number_planet"].items()}
    moon_start = placement(backend.body(jd0, "moon", ayanamsha, "mean").sidereal)
    return {
        "sign": sign_id,
        "sign_index": sign_index,
        "period": period,
        "settings": {
            "engine": backend.name,
            "engine_version": backend.version,
            "ayanamsha": ayanamsha,
            "reference": "moon_sign",
            "evaluated_at": {
                "slow_grahas": iso_z(utc_from_jd(jd_mid)),
                "moon": iso_z(utc_from_jd(jd_moon)) if period == "daily" else None,
            },
            "rules_review_status": rules["review"]["status"],
        },
        "window": {
            "start_ist_date": first.isoformat(),
            "end_ist_date": last.isoformat(),
            "start": iso_z(start),
            "end": iso_z(end),
        },
        "transits": transits,
        "moon": {
            "start": {"sign": moon_start["sign"], "nakshatra": moon_start["nakshatra"]},
            "ingresses": next(x for x in transits if x["graha"] == "moon")["ingresses"],
        },
        "areas": areas,
        "lucky": {
            "day": next(w["id"] for w in t.weekdays if w["lord"] == lord),
            "number": numbers[lord],
        },
    }
