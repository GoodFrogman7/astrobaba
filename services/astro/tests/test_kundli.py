from datetime import date, time

from astro_engine.ephemeris import get_backend
from astro_engine.kundli import compute_kundli
from astro_engine.timeutil import resolve_local

DELHI = (28.6139, 77.2090)


def _chart(d: date, t: time | None, tz: str = "Asia/Kolkata", lat: float = DELHI[0], lon: float = DELHI[1]):  # type: ignore[no-untyped-def]
    return compute_kundli(get_backend(), resolve_local(d, t, tz), lat, lon)


def test_structure_and_conventions() -> None:
    k = _chart(date(2000, 1, 1), time(12, 0))
    ids = [g["id"] for g in k["grahas"]]
    assert ids == ["sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn", "rahu", "ketu"]
    g = {x["id"]: x for x in k["grahas"]}
    assert abs((g["ketu"]["longitude"] - g["rahu"]["longitude"]) % 360 - 180) < 1e-6
    assert not g["sun"]["retrograde"] and not g["moon"]["retrograde"]
    assert g["rahu"]["retrograde"]  # mean node always moves backwards
    assert k["settings"]["ayanamsha"] == "lahiri" and k["settings"]["house_system"] == "whole_sign"
    assert 23.8 < k["settings"]["ayanamsha_deg"] < 23.9
    assert k["flags"] == []


def test_whole_sign_houses_consistent() -> None:
    k = _chart(date(1985, 7, 15), time(6, 10), lat=19.0760, lon=72.8777)
    asc = k["ascendant"]["sign_index"]
    assert [h["sign_index"] for h in k["houses"]] == [(asc + i) % 12 for i in range(12)]
    for g in k["grahas"]:
        assert k["houses"][g["house"] - 1]["sign_index"] == g["sign_index"]
        assert g["id"] in k["houses"][g["house"] - 1]["occupants"]
    assert sum(len(h["occupants"]) for h in k["houses"]) == 9


def test_birth_just_after_sunrise_has_sun_near_ascendant() -> None:  # fixture C02
    k = _chart(date(1985, 7, 15), time(6, 10), lat=19.0760, lon=72.8777)
    sun = next(g for g in k["grahas"] if g["id"] == "sun")
    assert abs((k["ascendant"]["longitude"] - sun["longitude"] + 180) % 360 - 180) < 10


def test_unknown_birth_time() -> None:  # fixture C13
    k = _chart(date(1995, 4, 14), None, lat=26.9124, lon=75.7873)
    assert k["flags"] == ["unknown_birth_time"]
    assert k["ascendant"] is None and k["houses"] is None
    assert all("house" not in g for g in k["grahas"])
    assert k["birth"]["unknown_time"] is True
    assert set(k["moon_range"]) == {"start", "end", "sign_changes", "nakshatra_changes"}


def test_high_latitude_whole_sign_works() -> None:  # fixture C11, above the Arctic Circle
    k = _chart(date(2020, 6, 21), time(12, 0), tz="Europe/Oslo", lat=69.6492, lon=18.9553)
    assert k["ascendant"] is not None and len(k["houses"]) == 12


def test_ayanamsha_option_changes_sidereal_only() -> None:
    when = resolve_local(date(2000, 1, 1), time(12, 0), "Asia/Kolkata")
    a = compute_kundli(get_backend(), when, *DELHI, ayanamsha="lahiri")
    b = compute_kundli(get_backend(), when, *DELHI, ayanamsha="raman")
    assert a["grahas"][0]["tropical_longitude"] == b["grahas"][0]["tropical_longitude"]
    assert a["grahas"][0]["longitude"] != b["grahas"][0]["longitude"]
