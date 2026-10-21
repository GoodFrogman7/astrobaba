import time
from datetime import date, datetime

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from astro_engine.ephemeris import get_backend
from astro_engine.horoscope import area_weights, compute_horoscope_facts, window
from astro_engine.tables import get_table, get_tables

SIGNS = [s["id"] for s in get_tables().signs]
PERIODS = ["daily", "weekly", "monthly"]


def test_windows() -> None:
    assert window("weekly", date(2026, 10, 25)) == (date(2026, 10, 19), date(2026, 10, 25))
    assert window("weekly", date(2026, 10, 19)) == (date(2026, 10, 19), date(2026, 10, 25))
    assert window("monthly", date(2026, 2, 14)) == (date(2026, 2, 1), date(2026, 2, 28))
    assert window("monthly", date(2028, 2, 29)) == (date(2028, 2, 1), date(2028, 2, 29))
    assert window("monthly", date(2026, 12, 31)) == (date(2026, 12, 1), date(2026, 12, 31))
    f = compute_horoscope_facts(get_backend(), "aries", "daily", date(2026, 10, 21))
    # IST midnight boundaries: 00:00 IST is 18:30 UTC the previous day.
    assert (
        f["window"]["start"] == "2026-10-20T18:30:00Z"
        and f["window"]["end"] == "2026-10-21T18:30:00Z"
    )


def test_weights_follow_the_table() -> None:
    rules = get_table("horoscope_rules")
    daily, weekly = area_weights("daily"), area_weights("weekly")
    assert daily["love"]["moon"] == rules["areas"]["love"]["moon"] * 2
    assert daily["career"]["moon"] == 2  # absent in table → default 1, doubled
    assert all("moon" not in w for w in weekly.values())
    assert weekly["career"]["sun"] == 2


@settings(max_examples=30, deadline=None)
@given(
    sign=st.sampled_from(SIGNS),
    period=st.sampled_from(PERIODS),
    day=st.dates(date(1900, 1, 1), date(2099, 12, 1)),
)
def test_scores_in_range_and_consistent(sign: str, period: str, day: date) -> None:
    f = compute_horoscope_facts(get_backend(), sign, period, day)  # type: ignore[arg-type]
    rules = get_table("horoscope_rules")
    assert set(f["areas"]) == {"overall", "love", "career", "money", "health"}
    for area in f["areas"].values():
        assert 1 <= area["score"] <= 5
        assert area["label"] == rules["labels"][str(area["score"])]
        for r in area["reasons"]:
            fav = r["house_from_sign"] in rules["favourable_houses"][r["graha"]]
            assert r["effect"] == ("favourable" if fav else "challenging")
    assert [t["graha"] for t in f["transits"]] == [
        "sun",
        "moon",
        "mars",
        "mercury",
        "jupiter",
        "venus",
        "saturn",
        "rahu",
        "ketu",
    ]
    for t in f["transits"]:
        for i in t["ingresses"]:
            assert f["window"]["start"] < i["at"] <= f["window"]["end"]


def test_deterministic() -> None:
    a = compute_horoscope_facts(get_backend(), "leo", "monthly", date(2026, 10, 3))
    b = compute_horoscope_facts(get_backend(), "leo", "monthly", date(2026, 10, 30))
    assert a == b  # same window → identical facts


def test_daily_moon_ingress_and_lucky() -> None:
    f = compute_horoscope_facts(get_backend(), "aries", "daily", date(2026, 10, 21))
    assert f["lucky"] == {"day": "tuesday", "number": 9}  # Aries: Mars
    moon = next(t for t in f["transits"] if t["graha"] == "moon")
    assert f["moon"]["ingresses"] == moon["ingresses"]
    rahu = next(t for t in f["transits"] if t["graha"] == "rahu")
    ketu = next(t for t in f["transits"] if t["graha"] == "ketu")
    assert len(rahu["ingresses"]) == len(ketu["ingresses"])


@pytest.mark.parametrize("period", PERIODS)
def test_fast_enough_for_all_signs(period: str) -> None:
    for sign in SIGNS:
        t0 = time.perf_counter()
        compute_horoscope_facts(get_backend(), sign, period, date(2026, 10, 21))  # type: ignore[arg-type]
        assert time.perf_counter() - t0 < 0.3, (sign, period)


def test_window_start_utc_parses() -> None:
    f = compute_horoscope_facts(get_backend(), "pisces", "weekly", date(2026, 10, 21))
    assert datetime.fromisoformat(f["window"]["start"]).utcoffset() is not None


@pytest.mark.parametrize("period", ["daily", "weekly", "monthly"])
def test_transit_table_and_score_reasons_agree(period: str) -> None:
    """A page shows both; they must never place a graha in two different houses."""
    for sign in ("aries", "leo", "pisces"):
        f = compute_horoscope_facts(get_backend(), sign, period, date(2026, 10, 21))  # type: ignore[arg-type]
        houses = {t["graha"]: t["house_from_sign"] for t in f["transits"]}
        for area in f["areas"].values():
            for r in area["reasons"]:
                assert r["house_from_sign"] == houses[r["graha"]], (sign, r)
