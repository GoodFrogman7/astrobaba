from hypothesis import given, settings
from hypothesis import strategies as st

from astro_engine.matching import ashtakoota
from astro_engine.tables import get_tables
from astro_engine.zodiac import placement

moons = st.floats(0, 360, exclude_max=True)


@settings(max_examples=300, deadline=None)
@given(groom=moons, bride=moons)
def test_total_is_sum_of_eight_kootas_and_within_maxima(groom: float, bride: float) -> None:
    r = ashtakoota(placement(groom), placement(bride))
    assert [k["koota"] for k in r["kootas"]] == [
        "varna",
        "vashya",
        "tara",
        "yoni",
        "graha_maitri",
        "gana",
        "bhakoot",
        "nadi",
    ]
    assert [k["max"] for k in r["kootas"]] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert r["total"] == sum(k["points"] for k in r["kootas"])
    for k in r["kootas"]:
        assert 0 <= k["points"] <= k["max"]
    assert 0 <= r["total"] <= 36 == r["max"]
    assert r["doshas"]["nadi"] == (r["kootas"][7]["points"] == 0)


def test_same_moon_position() -> None:
    p = placement(100.0)
    r = ashtakoota(p, p)
    k = {x["koota"]: x["points"] for x in r["kootas"]}
    assert k["yoni"] == 4 and k["graha_maitri"] == 5 and k["nadi"] == 0 and k["bhakoot"] == 7


def test_tables_shape() -> None:
    m = get_tables().matching
    yoni = m["yoni"]["matrix"]
    assert len(yoni) == 14 and all(len(r) == 14 for r in yoni)
    assert all(yoni[i][j] == yoni[j][i] for i in range(14) for j in range(14))
    assert all(yoni[i][i] == 4 for i in range(14))
    a = m["yoni"]["animals"]
    for x, y in [
        ("horse", "buffalo"),
        ("elephant", "lion"),
        ("sheep", "monkey"),
        ("serpent", "mongoose"),
        ("dog", "deer"),
        ("cat", "rat"),
        ("cow", "tiger"),
    ]:
        assert yoni[a.index(x)][a.index(y)] == 0, (x, y)
    assert len(m["vashya"]["matrix"]) == 5 and len(m["gana"]["matrix"]) == 3
    assert sum(m["maxima"].values()) == 36


def test_nakshatra_attribute_counts() -> None:
    naks = get_tables().nakshatras
    assert len(naks) == 27
    for attr in ("gana", "nadi"):
        counts: dict[str, int] = {}
        for n in naks:
            counts[n[attr]] = counts.get(n[attr], 0) + 1
        assert sorted(counts.values()) == [9, 9, 9], attr
    lords = [n["lord"] for n in naks]
    assert lords[:9] * 3 == lords
    assert {n["yoni"]["animal"] for n in naks} <= set(get_tables().matching["yoni"]["animals"])
