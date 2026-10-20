"""Numerology from data/astro/numerology.json: mulank, bhagyank and name number."""

import re
from datetime import date
from itertools import pairwise
from typing import Any, Literal

from astro_engine.tables import get_table
from astro_engine.timeutil import TimeInputError

System = Literal["chaldean", "pythagorean"]
_IGNORED = re.compile(r"[\s\-'.]")


class NumerologyInputError(TimeInputError):
    """Invalid numerology input; `code` is returned to API clients (422)."""


def digit_sum(n: int) -> int:
    return sum(int(d) for d in str(n))


def reduce(n: int) -> tuple[int, list[int]]:
    """Repeated digit sum down to 1-9; returns the result and the intermediate totals."""
    chain = [n]
    while n > 9:
        n = digit_sum(n)
        chain.append(n)
    return n, chain


def _planet(n: int) -> str:
    planets: dict[str, str] = get_table("numerology")["number_planet"]
    return planets[str(n)]


def _chain_steps(chain: list[int]) -> str:
    """[29, 11, 2] → '2+9 = 11 → 1+1 = 2'."""
    return " → ".join(f"{'+'.join(str(a))} = {b}" for a, b in pairwise(chain))


def mulank(dob: date) -> dict[str, Any]:
    number, chain = reduce(dob.day)
    steps = str(dob.day) if dob.day < 10 else f"{dob.day} → {_chain_steps(chain)}"
    return {"number": number, "steps": steps, "planet": _planet(number)}


def bhagyank(dob: date) -> dict[str, Any]:
    digits = dob.strftime("%d%m%Y")
    total = sum(int(d) for d in digits)
    number, chain = reduce(total)
    steps = f"{'+'.join(digits)} = {total}"
    if total > 9:
        steps += f" → {_chain_steps(chain)}"
    return {"number": number, "steps": steps, "planet": _planet(number)}


def name_number(name: str, system: System = "chaldean") -> dict[str, Any]:
    letters = _IGNORED.sub("", name).upper()
    if not letters:
        raise NumerologyInputError("nothing_to_compute", "The name has no letters.")
    if not all("A" <= c <= "Z" for c in letters):
        raise NumerologyInputError(
            "latin_letters_required",
            "Name numerology uses Latin letters (A-Z). Please write the name in English "
            "letters, e.g. a Hindi name transliterated as it is spelled in official documents.",
        )
    values: dict[str, int] = get_table("numerology")["systems"][system]
    breakdown: list[dict[str, Any]] = [{"letter": c, "value": values[c]} for c in letters]
    compound = sum(values[c] for c in letters)
    number, _ = reduce(compound)
    return {"compound": compound, "number": number, "letters": breakdown, "planet": _planet(number)}


def compute_numerology(
    name: str | None, dob: date | None, system: System = "chaldean"
) -> dict[str, Any]:
    if not (name and name.strip()) and dob is None:
        raise NumerologyInputError("nothing_to_compute", "Send a name, a date of birth, or both.")
    return {
        "settings": {"system": system, "reduction": "repeated digit sum to 1-9"},
        "mulank": mulank(dob) if dob else None,
        "bhagyank": bhagyank(dob) if dob else None,
        "name_number": name_number(name, system) if name and name.strip() else None,
        "review_status": get_table("numerology")["review"]["status"],
    }
