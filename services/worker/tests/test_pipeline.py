import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from astro_api.shared_files import data_dir
from astro_worker.horoscopes import _write, build_prompt
from astro_worker.llm import LlmRequest, LlmResult

FACTS: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "api/tests/fixtures/facts_aries_daily.json").read_text()
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


GOOD = valid_text(FACTS)
_g, _s = false_pair(FACTS)
BAD = f"{GRAHAS[_g]['en']} in {SIGNS[_s]['en']} guarantees a lucky break. {FILLER}"


@dataclass
class Scripted:
    outputs: list[str]
    name: str = "scripted"
    prompts: list[str] = field(default_factory=list)

    async def generate(self, req: LlmRequest) -> LlmResult:
        self.prompts.append(req.user)
        return LlmResult(self.outputs.pop(0), "scripted-model")


def sections(text: str) -> str:
    return json.dumps({a: text for a in ("overall", "love", "career", "money", "health")})


def test_prompt_contains_facts_and_localised_names_only() -> None:
    p = build_prompt(FACTS, "hi")
    first = FACTS["transits"][0]
    assert (
        f'"sign": "{FACTS["sign"]}"' in p and f'"house_from_sign": {first["house_from_sign"]}' in p
    )
    assert GRAHAS[first["graha"]]["hi"] in p and "Hindi" in p
    assert "lucky" not in p  # lucky values are not for the model to write about


async def test_retry_once_with_the_validator_errors() -> None:
    provider = Scripted([sections(BAD), sections(GOOD)])
    result, model, errors = await _write(provider, FACTS, "en")
    assert errors == [] and model == "scripted-model" and result is not None
    assert len(provider.prompts) == 2
    assert f"places {_g} in {_s}" in provider.prompts[1] and "guarantee" in provider.prompts[1]


async def test_gives_up_after_one_retry() -> None:
    provider = Scripted([sections(BAD), "not json"])
    result, _, errors = await _write(provider, FACTS, "en")
    assert result is None and errors == ["output is not valid JSON"]
    assert len(provider.prompts) == 2
