from datetime import date, time

import pytest

from astro_engine.timeutil import TimeInputError, jd_from_utc, resolve_local, utc_from_jd


def test_ist_birth() -> None:
    r = resolve_local(date(2000, 1, 1), time(12, 0), "Asia/Kolkata")
    assert r.utc.isoformat() == "2000-01-01T06:30:00+00:00"
    assert r.utc_offset == "+05:30"


def test_wartime_india_offset_from_tzdata() -> None:
    r = resolve_local(date(1943, 5, 10), time(10, 0), "Asia/Kolkata")
    assert r.utc_offset == "+06:30"


def test_user_confirmed_offset_overrides_tzdata() -> None:
    r = resolve_local(date(1943, 5, 10), time(10, 0), "Asia/Kolkata", utc_offset="+05:53")
    assert r.utc.isoformat() == "1943-05-10T04:07:00+00:00"


def test_nonexistent_local_time_rejected() -> None:  # fixture X01
    with pytest.raises(TimeInputError) as e:
        resolve_local(date(2024, 3, 31), time(1, 30), "Europe/London")
    assert e.value.code == "nonexistent_local_time"


def test_ambiguous_local_time_needs_fold() -> None:  # fixture X02
    with pytest.raises(TimeInputError) as e:
        resolve_local(date(2024, 11, 3), time(1, 30), "America/New_York")
    assert e.value.code == "ambiguous_local_time"
    first = resolve_local(date(2024, 11, 3), time(1, 30), "America/New_York", fold=0)
    second = resolve_local(date(2024, 11, 3), time(1, 30), "America/New_York", fold=1)
    assert (second.utc - first.utc).total_seconds() == 3600


def test_unknown_time_assumes_noon_and_says_so() -> None:
    r = resolve_local(date(1995, 4, 14), None, "Asia/Kolkata")
    assert r.assumed_time
    assert r.local.hour == 12


@pytest.mark.parametrize("bad", ["Mars/Olympus", ""])
def test_unknown_zone(bad: str) -> None:
    with pytest.raises(TimeInputError):
        resolve_local(date(2000, 1, 1), time(0, 0), bad)


def test_invalid_offset() -> None:
    with pytest.raises(TimeInputError):
        resolve_local(date(2000, 1, 1), time(0, 0), "Asia/Kolkata", utc_offset="+25:00")


def test_julian_day_round_trip() -> None:
    r = resolve_local(date(1955, 11, 2), time(4, 30), "Asia/Kolkata")
    assert utc_from_jd(jd_from_utc(r.utc)) == r.utc
    assert abs(jd_from_utc(resolve_local(date(2000, 1, 1), time(17, 30), "Asia/Kolkata").utc) - 2451545.0) < 1e-9
