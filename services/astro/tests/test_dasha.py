from datetime import UTC, datetime, timedelta

from hypothesis import given, settings
from hypothesis import strategies as st

from astro_engine.dasha import vimshottari

BIRTH = datetime(2000, 1, 1, 6, 30, tzinfo=UTC)


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


@settings(max_examples=60, deadline=None)
@given(moon=st.floats(0, 360, exclude_max=True))
def test_periods_are_contiguous_and_sum_to_120_years(moon: float) -> None:
    d = vimshottari(moon, BIRTH)
    mds = d["mahadashas"]
    assert len(mds) == 9
    total_days = (ts(mds[-1]["end"]) - ts(mds[0]["start"])).total_seconds() / 86400
    assert abs(total_days - 120 * 365.25) < 1
    for a, b in zip(mds, mds[1:], strict=False):
        assert abs((ts(b["start"]) - ts(a["end"])).total_seconds()) <= 1
    for md in mds:
        ads = md["antardashas"]
        assert ads[0]["lord"] == md["lord"]
        assert abs((ts(ads[-1]["end"]) - ts(md["end"])).total_seconds()) <= 2
    assert ts(mds[0]["start"]) <= BIRTH < ts(mds[0]["end"])
    remaining = (ts(mds[0]["end"]) - BIRTH).total_seconds() / 86400 / 365.25
    assert abs(remaining - d["balance_at_birth"]["years"]) < 1e-3


def test_start_of_ashwini_is_full_ketu() -> None:
    d = vimshottari(0.0, BIRTH)
    assert d["balance_at_birth"] == {"lord": "ketu", "years": 7.0}
    assert d["mahadashas"][0]["start"] == "2000-01-01T06:30:00Z"


def test_current_period() -> None:
    d = vimshottari(0.0, BIRTH, BIRTH + timedelta(days=365.25 * 8))
    assert d["current"]["mahadasha"] == "venus"
