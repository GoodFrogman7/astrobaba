from datetime import date, datetime, timedelta
from itertools import pairwise
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from astro_engine.ephemeris import get_backend
from astro_engine.panchang import compute_panchang
from astro_engine.tables import get_table, get_tables

CITIES = [
    (28.6139, 77.2090, "Asia/Kolkata"),
    (13.0827, 80.2707, "Asia/Kolkata"),
    (51.5074, -0.1278, "Europe/London"),
    (-33.8688, 151.2093, "Australia/Sydney"),
]
days = st.dates(date(1900, 1, 1), date(2099, 12, 30))


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _p(day: date, city: tuple[float, float, str]) -> dict[str, Any]:
    return compute_panchang(get_backend(), day, *city)


def _tiles(items: list[dict[str, Any]], start: str, end: str) -> None:
    assert items[0]["start"] == start
    assert abs((ts(items[-1]["end"]) - ts(end)).total_seconds()) <= 1
    for a, b in pairwise(items):
        assert a["end"] == b["start"]


@settings(max_examples=40, deadline=None)
@given(day=days, city=st.sampled_from(CITIES))
def test_choghadiya_tiles_the_day_and_follows_the_rules(
    day: date, city: tuple[float, float, str]
) -> None:
    p = _p(day, city)
    c = p["choghadiya"]
    assert len(c["day"]) == 8 and len(c["night"]) == 8
    _tiles(c["day"], p["sunrise"], p["sunset"])
    _tiles(c["night"], p["sunset"], p["next_sunrise"])
    table = get_table("choghadiya")
    ids = [x["id"] for x in table["cycle"]]
    lord = get_tables().weekdays[day.isoweekday() - 1]["lord"]
    day_start = next(i for i, x in enumerate(table["cycle"]) if x["planet"] == lord)
    assert [x["id"] for x in c["day"]] == [ids[(day_start + k) % 7] for k in range(8)]
    night_start = (day_start + 5) % 7
    assert [x["id"] for x in c["night"]] == [ids[(night_start - 2 * k) % 7] for k in range(8)]
    # The 8th day part repeats the 1st, as in published tables.
    assert c["day"][7]["id"] == c["day"][0]["id"]


@settings(max_examples=40, deadline=None)
@given(day=days, city=st.sampled_from(CITIES))
def test_horas_tile_the_day_and_continue_into_the_next(
    day: date, city: tuple[float, float, str]
) -> None:
    p = _p(day, city)
    h = p["hora"]
    assert [x["number"] for x in h] == list(range(1, 25))
    assert [x["part"] for x in h] == ["day"] * 12 + ["night"] * 12
    _tiles(h[:12], p["sunrise"], p["sunset"])
    _tiles(h[12:], p["sunset"], p["next_sunrise"])
    order = get_table("hora")["chaldean_order"]
    assert h[0]["lord"] == p["vaara"]["lord"]
    for a, b in pairwise(h):
        assert order.index(b["lord"]) == (order.index(a["lord"]) + 1) % 7
    # Hora 25 (the next sunrise) is the next weekday's lord: the week of planetary days.
    nxt = _p(day + timedelta(days=1), city)
    assert nxt["hora"][0]["lord"] == order[(order.index(h[23]["lord"]) + 1) % 7]


def test_known_weekday_starts() -> None:
    # Monday 2026-01-05: day starts with Amrit (Moon), night with Char.
    p = _p(date(2026, 1, 5), CITIES[0])
    assert p["choghadiya"]["day"][0]["id"] == "amrit"
    assert p["choghadiya"]["night"][0]["id"] == "char"
    assert p["hora"][0]["lord"] == "moon"
    assert p["settings"]["tables_review_status"]["choghadiya"] == "needs_astrologer_review"
