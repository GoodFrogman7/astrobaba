import copy
import json
from pathlib import Path
from typing import Any

from astro_api.horoscope_rules import grounding_errors, text_errors
from astro_api.shared_files import data_dir

FACTS: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "facts_aries_daily.json").read_text()
)

# --- Sample text built from the fixture's facts, so tests survive regenerating the fixture. ---
_TABLES = data_dir()
GRAHAS = {g["id"]: g for g in json.loads((_TABLES / "grahas.json").read_text())["grahas"]}
SIGNS = {s["id"]: s for s in json.loads((_TABLES / "signs.json").read_text())["signs"]}
AREAS = ("overall", "love", "career", "money", "health")
FILLER = (
    "Take the day one step at a time, listen closely, and keep plans flexible while you sort out "
    "what matters most to you. A calm pace suits you, and small, steady choices add up over the "
    "coming hours. Leave room for rest and for people who make you feel at ease today."
)


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def true_claim(facts: dict[str, Any]) -> str:
    """A sentence naming a planet with the sign and house the facts actually give it."""
    t = facts["transits"][0]
    g, s = GRAHAS[t["graha"]]["en"], SIGNS[t["sign"]]["en"]
    return f"With {g} in {s}, in your {ordinal(t['house_from_sign'])} house, effort is noticed."


def valid_text(facts: dict[str, Any]) -> str:
    return f"{true_claim(facts)} {FILLER}"


def false_pair(facts: dict[str, Any]) -> tuple[str, str]:
    """A (graha, sign) placement the facts do NOT contain (and not the subject sign)."""
    for t in facts["transits"]:
        placed = {t["sign"], *(i["to_sign"] for i in t.get("ingresses") or [])}
        for sign in SIGNS:
            if sign not in placed and sign != facts["sign"]:
                return t["graha"], sign
    raise AssertionError("facts place every planet everywhere")


def false_house(facts: dict[str, Any]) -> tuple[str, int]:
    t = facts["transits"][0]
    houses = {x["house_from_sign"] for x in facts["transits"] if x["graha"] == t["graha"]}
    return t["graha"], next(h for h in range(1, 13) if h not in houses)


def ok_sections() -> dict[str, str]:
    return {a: valid_text(FACTS) for a in AREAS}


def test_valid_text_passes() -> None:
    assert text_errors(ok_sections(), FACTS) == []


def test_invented_position_is_caught() -> None:
    graha, sign = false_pair(FACTS)
    text = f"{GRAHAS[graha]['en']} in {SIGNS[sign]['en']} brings a lucky break."
    assert grounding_errors(text, FACTS) == [f"places {graha} in {sign}, which the facts do not"]


def test_ingress_target_and_subject_sign_are_allowed() -> None:
    # Validator input, not astro data: give the first planet an ingress so the rule is exercised.
    facts = copy.deepcopy(FACTS)
    t = facts["transits"][0]
    _, target = false_pair({**facts, "transits": [t]})
    t["ingresses"] = [{"at": facts["window"]["end"], "to_sign": target}]
    g, here, there = GRAHAS[t["graha"]]["en"], SIGNS[t["sign"]]["en"], SIGNS[target]["en"]
    subject = SIGNS[facts["sign"]]["en"]
    assert (
        grounding_errors(f"As {g} moves from {here} into {there}, {subject} feels lighter.", facts)
        == []
    )
    assert grounding_errors(f"As {g} moves from {here} into {there}, it helps.", FACTS) != []


def test_wrong_house_is_caught() -> None:
    graha, house = false_house(FACTS)
    text = f"{GRAHAS[graha]['en']} in your {ordinal(house)} house helps."
    assert grounding_errors(text, FACTS) == [
        f"mentions the {house}th house, which the facts do not"
    ]


def test_hindi_names_and_spelling_variants() -> None:
    moon = next(t for t in FACTS["transits"] if t["graha"] == "moon")
    # चंद्रमा (anusvara + inflection) must match चन्द्र from data/astro.
    assert grounding_errors(f"चंद्रमा {SIGNS[moon['sign']]['hi']} राशि में है।", FACTS) == []
    graha, sign = false_pair(FACTS)
    errors = grounding_errors(f"{GRAHAS[graha]['hi']} {SIGNS[sign]['hi']} राशि में है।", FACTS)
    assert errors == [f"places {graha} in {sign}, which the facts do not"]


def test_banned_phrases() -> None:
    s = ok_sections()
    s["money"] = s["money"] + " This is a guarantee that you should invest in stocks."
    s["health"] = s["health"] + " इलाज की ज़रूरत नहीं।"
    errors = text_errors(s, FACTS)
    assert any("money: banned phrase" in e and "guarantee" in e for e in errors)
    assert any("money: banned phrase" in e and "invest" in e for e in errors)
    assert any("health: banned phrase" in e for e in errors)


def test_length_and_shape() -> None:
    s = ok_sections()
    s["love"] = "Too short."
    del s["health"]
    errors = text_errors(s, FACTS)
    assert any(e.startswith("sections must be exactly") for e in errors)
    assert any(e.startswith("love: 2 words") for e in errors)
    assert "health: missing" in errors
