"""Safety fixtures (PLAN.md §7, docs/api/trust.md §3): every prompt in fixtures/*.yaml goes
through the one classifier (astro_api.safety) and the AI assistant's gate (astro_api.ai_safety),
and must get the expected category, chat action, banner, refusal reason and AI hand-off.

The fixtures are hand-written test prompts (inputs), not astrology data. A regression blocks
merges, like evals/astro.

Fields per case (file `defaults` apply first):
  from      client | astrologer
  lang      en | hi | hinglish
  text      the message
  chat      deliver | flag | refuse          (safety.check_message)
  banner    crisis | none                    (what the client sees)
  refusal   a chat.ts BLOCK_REASONS code     (refuse only)
  category  first category or null           (safety.classify; client cases)
  includes  categories that must be present  (safety.categories)
  handoff   AI notice kind or null           (ai_safety.classify: null = the AI may answer)
"""

from collections import Counter
from pathlib import Path
from typing import Any

import pytest
import yaml

from astro_api import ai_safety, safety

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FILES = sorted(FIXTURES.glob("*.yaml"))
LANGS = ("en", "hi", "hinglish")


def _load() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for path in FILES:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        defaults = doc.get("defaults") or {}
        for raw in doc["cases"]:
            case = {**defaults, **raw, "file": path.stem}
            cases.append(case)
    return cases


CASES = _load()


def test_fixture_files_are_present_and_well_formed() -> None:
    names = {p.stem for p in FILES}
    assert {
        "self_harm",
        "emergency",
        "medical",
        "legal",
        "financial",
        "scam",
        "fear_selling",
        "benign",
    } <= names
    ids = Counter(c["id"] for c in CASES)
    assert not [i for i, n in ids.items() if n > 1], "duplicate ids"
    for c in CASES:
        assert c["from"] in ("client", "astrologer"), c["id"]
        assert c["lang"] in LANGS, c["id"]
        assert c["chat"] in ("deliver", "flag", "refuse"), c["id"]
        assert isinstance(c["text"], str) and c["text"].strip(), c["id"]
        if c["chat"] == "refuse":
            assert c["from"] == "astrologer" and c.get("refusal") in safety.REFUSALS, c["id"]
        if c["from"] == "client":
            assert "handoff" in c and "category" in c, c["id"]


def test_coverage_languages_and_reasons() -> None:
    for file in ("self_harm", "emergency", "medical", "legal", "financial", "scam", "benign"):
        langs = {c["lang"] for c in CASES if c["file"] == file}
        assert langs == set(LANGS), (file, langs)
    per_lang = Counter(c["lang"] for c in CASES if c["file"] == "self_harm")
    assert min(per_lang.values()) >= 5, per_lang
    refusals = {c.get("refusal") for c in CASES if c["chat"] == "refuse"}
    assert refusals == set(safety.REFUSALS)
    benign = [c["text"] for c in CASES if c["file"] == "benign"]
    assert any("Cancer" in t for t in benign), "zodiac Cancer control missing"
    assert sum(1 for c in CASES if c["file"] == "benign" and c["from"] == "astrologer") >= 10


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_case(case: dict[str, Any]) -> None:
    role = "user" if case["from"] == "client" else "astrologer"
    check = safety.check_message(role, case["text"])
    assert check.action == case["chat"]
    assert check.banner == case.get("banner", "crisis" if case["chat"] == "flag" else "none")
    assert check.refusal == (case.get("refusal") if case["chat"] == "refuse" else None)
    if "category" in case:
        assert safety.classify(case["text"]) == case["category"]
    for cat in case.get("includes") or ():
        assert cat in safety.categories(case["text"])
    if case["from"] == "client":
        verdict = ai_safety.classify(case["text"])
        assert verdict.kind == case["handoff"]
        if verdict.kind is not None:
            for lang in ("en", "hi"):
                assert ai_safety.notice(verdict.kind, lang)


def test_no_missed_crisis_and_no_false_refusals() -> None:
    """Headline numbers: every crisis prompt flags (recall 1.0), no benign message is flagged or
    refused, and no client message is ever refused."""
    crisis = [c for c in CASES if c["file"] in ("self_harm", "emergency")]
    flagged = [c for c in crisis if safety.check_message("user", c["text"]).action == "flag"]
    assert len(flagged) == len(crisis)
    for c in CASES:
        role = "user" if c["from"] == "client" else "astrologer"
        action = safety.check_message(role, c["text"]).action
        if c["file"] == "benign":
            assert action == "deliver", c["id"]
        if role == "user":
            assert action != "refuse", c["id"]


def test_crisis_banner_has_verified_resources() -> None:
    res = safety.resources()
    assert res["helplines"] and res["not_a_helpline"]["en"] and res["not_a_helpline"]["hi"]
    assert any(h["id"] == "tele-manas" for h in res["helplines"])
    assert "helpline" in ai_safety.notice("self_harm", "en")
