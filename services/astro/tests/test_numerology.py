from datetime import date

import pytest
from hypothesis import given
from hypothesis import strategies as st

from astro_engine.numerology import (
    NumerologyInputError,
    System,
    compute_numerology,
    name_number,
    reduce,
)

dates = st.dates(date(1800, 1, 2), date(2399, 12, 30))
names = st.text(
    alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'.", min_size=1, max_size=40
)


@given(n=st.integers(1, 10**9))
def test_reduce_is_digital_root(n: int) -> None:
    number, chain = reduce(n)
    assert 1 <= number <= 9
    assert number == 1 + (n - 1) % 9
    assert chain[0] == n and chain[-1] == number


@given(dob=dates)
def test_mulank_and_bhagyank_in_range(dob: date) -> None:
    r = compute_numerology(None, dob)
    assert r["mulank"]["number"] == 1 + (dob.day - 1) % 9
    digits = sum(int(c) for c in dob.strftime("%d%m%Y"))
    assert r["bhagyank"]["number"] == 1 + (digits - 1) % 9
    assert r["name_number"] is None


@given(name=names.filter(lambda s: any(c.isalpha() for c in s)))
def test_name_number_case_insensitive_and_in_range(name: str) -> None:
    systems: tuple[System, ...] = ("chaldean", "pythagorean")
    for system in systems:
        a, b = name_number(name.upper(), system), name_number(name.lower(), system)
        assert a == b
        assert 1 <= a["number"] <= 9
        assert a["compound"] == sum(x["value"] for x in a["letters"])


def test_worked_examples() -> None:
    r = compute_numerology("Asha Verma", date(1990, 7, 29))
    assert r["mulank"] == {"number": 2, "steps": "29 → 2+9 = 11 → 1+1 = 2", "planet": "moon"}
    assert r["bhagyank"]["steps"] == "2+9+0+7+1+9+9+0 = 37 → 3+7 = 10 → 1+0 = 1"
    assert r["name_number"]["compound"] == 28 and r["name_number"]["number"] == 1
    assert compute_numerology(None, date(2000, 1, 5))["mulank"]["steps"] == "5"
    assert name_number("abc", "pythagorean")["compound"] == 6


def test_errors() -> None:
    with pytest.raises(NumerologyInputError) as e:
        compute_numerology(None, None)
    assert e.value.code == "nothing_to_compute"
    with pytest.raises(NumerologyInputError) as e:
        compute_numerology("आशा", None)
    assert e.value.code == "latin_letters_required"
