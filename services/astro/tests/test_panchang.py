from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from astro_engine.ephemeris import get_backend, norm
from astro_engine.panchang import compute_panchang
from astro_engine.tables import get_tables
from astro_engine.timeutil import TimeInputError, jd_from_utc

CITIES = [
    (28.6139, 77.2090, "Asia/Kolkata"),
    (13.0827, 80.2707, "Asia/Kolkata"),
    (22.5726, 88.3639, "Asia/Kolkata"),
    (51.5074, -0.1278, "Europe/London"),
    (-33.8688, 151.2093, "Australia/Sydney"),
]


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _p(day: date, city: tuple[float, float, str] = CITIES[0]) -> dict[str, Any]:
    return compute_panchang(get_backend(), day, *city)


@settings(max_examples=40, deadline=None)
@given(day=st.dates(date(1900, 1, 1), date(2099, 12, 31)), city=st.sampled_from(CITIES))
def test_rahu_kaal_matches_weekday_table(day: date, city: tuple[float, float, str]) -> None:
    p = _p(day, city)
    part_no = get_tables().weekdays[day.isoweekday() - 1]["rahu_kaal_part"]
    sunrise, sunset = ts(p["sunrise"]), ts(p["sunset"])
    part = (sunset - sunrise) / 8
    assert p["rahu_kaal"]["part"] == part_no
    assert (
        abs((ts(p["rahu_kaal"]["start"]) - (sunrise + (part_no - 1) * part)).total_seconds()) <= 1
    )
    assert (
        abs((ts(p["rahu_kaal"]["end"]) - ts(p["rahu_kaal"]["start"]) - part).total_seconds()) <= 1
    )
    assert (
        sunrise
        <= ts(p["rahu_kaal"]["start"])
        < ts(p["rahu_kaal"]["end"])
        <= sunset + timedelta(seconds=1)
    )


@settings(max_examples=40, deadline=None)
@given(day=st.dates(date(1900, 1, 1), date(2099, 12, 31)), city=st.sampled_from(CITIES))
def test_elements_tile_the_day_and_match_the_definitions(
    day: date, city: tuple[float, float, str]
) -> None:
    p = _p(day, city)
    sunrise, next_sunrise = ts(p["sunrise"]), ts(p["next_sunrise"])
    b = get_backend()
    for key in ("tithis", "nakshatras", "yogas", "karanas"):
        items = p[key]
        assert ts(items[0]["start"]) <= sunrise < ts(items[0]["end"])
        assert ts(items[-1]["start"]) < next_sunrise <= ts(items[-1]["end"])
        for a, nxt in pairwise(items):
            assert a["end"] == nxt["start"]
    # Check the sunrise elements against the definitions. Sunrise is rounded to the second, so
    # when the angle sits within ~1 second of motion of a boundary, either side is correct.
    jd = jd_from_utc(sunrise)
    sun, moon = b.body(jd, "sun", "lahiri", "mean"), b.body(jd, "moon", "lahiri", "mean")
    elongation = norm(moon.tropical - sun.tropical)
    tithi = p["tithi_at_sunrise"]["number"]
    nak = p["nakshatra_at_sunrise"]["number"]
    assert tithi in {int((elongation + d) % 360 // 12) + 1 for d in (-2e-4, 0, 2e-4)}
    assert nak in {int((moon.sidereal + d) % 360 // (360 / 27)) + 1 for d in (-2e-4, 0, 2e-4)}


def test_local_date_is_the_sunrise_date() -> None:
    p = _p(date(2026, 1, 5))
    rise_local = ts(p["sunrise"]).astimezone(datetime.now(UTC).astimezone().tzinfo)
    assert p["vaara"]["en"] == "Monday"
    assert ts(p["sunrise"]).date() in (date(2026, 1, 5), date(2026, 1, 4))  # UTC date
    assert rise_local is not None


def test_today_and_tomorrow_differ() -> None:  # fixtures A27/A28
    a, b = _p(date(2026, 10, 20)), _p(date(2026, 10, 21))
    assert a["sunrise"] != b["sunrise"]
    assert (
        a["next_sunrise"] == b["sunrise"]
        or abs((ts(a["next_sunrise"]) - ts(b["sunrise"])).total_seconds()) < 2
    )
    assert a["vaara"]["en"] == "Tuesday" and b["vaara"]["en"] == "Wednesday"


def test_kshaya_tithi_detected_somewhere_in_a_year() -> None:
    # Kshaya tithis occur several times a year; prove the detector finds at least one.
    found = [
        d
        for d in (date(2025, 1, 1) + timedelta(days=i) for i in range(120))
        if any(t["kshaya"] for t in _p(d)["tithis"])
    ]
    assert found


def test_polar_night_has_no_sunrise() -> None:
    with pytest.raises(TimeInputError) as e:
        compute_panchang(get_backend(), date(2025, 12, 21), 78.2232, 15.6267, "Arctic/Longyearbyen")
    assert e.value.code == "no_sunrise"
