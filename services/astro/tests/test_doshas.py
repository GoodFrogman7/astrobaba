from datetime import UTC, date, datetime, time
from typing import Any

from astro_engine.doshas import kaal_sarp, mangal_dosha, sade_sati
from astro_engine.ephemeris import get_backend
from astro_engine.kundli import compute_kundli
from astro_engine.timeutil import resolve_local
from astro_engine.zodiac import placement


def _synthetic(longitudes: dict[str, float], asc: float | None = 0.0) -> dict[str, Any]:
    grahas = []
    for gid, lon in longitudes.items():
        g = {"id": gid, **placement(lon)}
        if asc is not None:
            g["house"] = (g["sign_index"] - placement(asc)["sign_index"]) % 12 + 1
        grahas.append(g)
    return {"grahas": grahas, "ascendant": placement(asc) if asc is not None else None}


BASE = {"sun": 40, "moon": 50, "mars": 60, "mercury": 70, "jupiter": 80, "venus": 90, "saturn": 100}


def test_kaal_sarp_all_planets_on_one_side() -> None:
    chart = _synthetic({**BASE, "rahu": 10.0, "ketu": 190.0})
    r = kaal_sarp(chart)
    assert r["present"] and r["direction"] == "rahu_to_ketu" and r["type"] == "Anant"


def test_kaal_sarp_broken_by_one_planet() -> None:
    chart = _synthetic({**BASE, "saturn": 250.0, "rahu": 10.0, "ketu": 190.0})
    assert not kaal_sarp(chart)["present"]


def test_mangal_dosha_from_lagna_and_moon() -> None:
    chart = _synthetic({**BASE, "mars": 190.0, "rahu": 10.0, "ketu": 190.0}, asc=0.0)  # Mars in 7th
    r = mangal_dosha(chart)
    assert r["present"] and "lagna" in r["from"]
    assert r["mars_house_from"]["lagna"] == 7


def test_mangal_dosha_unknown_time_uses_moon_only() -> None:
    chart = _synthetic({**BASE, "mars": 50.0, "rahu": 10.0, "ketu": 190.0}, asc=None)
    r = mangal_dosha(chart)
    assert r["mars_house_from"]["lagna"] is None
    assert r["from"] == ["moon"]  # Mars with the Moon = 1st from Moon


def test_sade_sati_periods_are_saturn_in_the_three_signs() -> None:
    when = resolve_local(date(2000, 1, 1), time(12, 0), "Asia/Kolkata")
    k = compute_kundli(get_backend(), when, 28.6139, 77.2090)
    moon = next(g for g in k["grahas"] if g["id"] == "moon")
    r = sade_sati(get_backend(), moon["sign_index"], when.utc, datetime(2012, 1, 1, tzinfo=UTC), years=60)
    assert r["active"]
    allowed = {(moon["sign_index"] + o) % 12 for o in (-1, 0, 1)}
    for c in r["cycles"]:
        assert {p["saturn_sign_index"] for p in c["phases"]} <= allowed
        assert c["start"] < c["end"]
    # Saturn takes ~29.5 years per orbit, so 60 years hold two cycles.
    assert len(r["cycles"]) == 2
