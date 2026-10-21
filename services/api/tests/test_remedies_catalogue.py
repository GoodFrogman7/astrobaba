"""The remedies catalogue (data/marketplace/remedies.json): neutral descriptions only, no gemstones,
no prices, no outcome claims, and nothing from a dev-only partner outside development/test."""

import re
from typing import Any

import pytest

from astro_api import remedies_api
from astro_api.config import Settings
from astro_api.moderation import moderation_reasons

PRICE_NOTE = {
    "en": "Price is set by the partner and shared before booking",
    "hi": "कीमत पार्टनर तय करते हैं और बुकिंग से पहले बताते हैं",
}

# Outcome, cure, guarantee, fear and product words (en + hi). The catalogue describes what a
# service is, never what it does for you (Drugs and Magic Remedies Act, ASCI).
BANNED = re.compile(
    r"\b(?:guarantee\w*|cure\w*|heal\w*|remove\w*|remov\w*|protect\w*|ward\w*|"
    r"success\w*|prosper\w*|wealth|money|health\w*|disease\w*|fertil\w*|marriage|job|"
    r"bless\w*|lucky|luck|fortune|dosha\w*|malefic|curse\w*|evil|negative|bad|danger\w*|"
    r"sure|certain\w*|promise[sd]?|result\w*|effective\w*|powerful|miracle\w*|"
    r"gem\w*|stone\w*|ring\w*|yantra\w*|rudraksha|amulet\w*|kavach\w*|product\w*|"
    r"rs\.?|inr|₹|\d+\s*rupees?)\b"
    r"|गारंटी|इलाज|ठीक|दोष|शांति|सफलता|समृद्धि|धन|स्वास्थ्य|बीमारी|रोग|"
    r"रत्न|नग|अंगूठी|यंत्र|कवच|रुद्राक्ष|भाग्य|सौभाग्य|आशीर्वाद|नकारात्मक|बुरी|ख़तर|खतर|"
    r"चमत्कार|निश्चित|पक्का|रुपये|₹",
    re.IGNORECASE,
)


def test_the_claims_filter_catches_typical_remedy_copy() -> None:
    for bad in (
        "Removes Mangal dosha for a happy marriage",
        "Guaranteed results within 21 days",
        "Wear a blue sapphire gemstone",
        "Brings wealth and good health",
        "शनि दोष से मुक्ति और धन लाभ",
        "₹1,100 only",
    ):
        assert BANNED.search(bad), bad


def data() -> dict[str, Any]:
    return remedies_api.catalogue_file()


def texts(entry: dict[str, Any]) -> list[str]:
    return [entry["name"][lang] for lang in ("en", "hi")] + [
        entry["description"][lang] for lang in ("en", "hi")
    ]


def test_entries_are_complete_and_reviewed() -> None:
    d = data()
    assert d["review"] == "needs_editorial_review"
    partners = {p["id"]: p for p in d["partners"]}
    ids = [r["id"] for r in d["remedies"]]
    assert len(ids) == len(set(ids)) and ids
    for r in d["remedies"]:
        assert r["kind"] in ("puja", "consultation_followup")
        assert re.fullmatch(r"[a-z0-9-]{1,64}", r["id"])
        assert r["partner_id"] in partners
        assert r["review"] == "needs_editorial_review"
        assert r["price_note"] == PRICE_NOTE
        for field in ("name", "description"):
            assert set(r[field]) == {"en", "hi"}
            assert r[field]["en"].strip() and r[field]["hi"].strip()
        # Hindi text is actually Devanagari, not a copy of the English.
        assert re.search(r"[ऀ-ॿ]", r["description"]["hi"])
        assert "price_paise" not in r and "price" not in r
    assert {"puja", "consultation_followup"} <= {r["kind"] for r in d["remedies"]}


@pytest.mark.parametrize("remedy_id", [r["id"] for r in remedies_api.catalogue_file()["remedies"]])
def test_no_claims_gemstones_prices_or_fear(remedy_id: str) -> None:
    entry = next(r for r in data()["remedies"] if r["id"] == remedy_id)
    for text in texts(entry):
        assert not BANNED.search(text), (remedy_id, BANNED.search(text))
        assert moderation_reasons(text) == []


def test_notice_says_we_sell_nothing_and_promise_nothing() -> None:
    notice = data()["notice"]
    assert "don't sell remedies" in notice["en"] and "no outcome is promised" in notice["en"]
    assert "वादा नहीं" in notice["hi"]


def test_demo_partner_is_dev_only_and_uses_the_console() -> None:
    demo = next(p for p in data()["partners"] if p["id"] == "demo-partner")
    assert demo["dev_only"] is True
    assert demo["contact"]["channel"] == "console"
    # Only the demo partner exists until the founder signs a real one.
    assert all(p.get("dev_only") for p in data()["partners"])


@pytest.mark.parametrize("env", ["staging", "production"])
def test_production_never_shows_dev_only_entries(env: str) -> None:
    s = Settings(app_env=env)
    assert remedies_api.visible_remedies(s) == []
    assert remedies_api.partner("demo-partner", s) is None
    assert remedies_api.find_remedy("ganesh-puja", s) is None


def test_development_shows_the_demo_catalogue() -> None:
    s = Settings(app_env="test")
    shown = remedies_api.visible_remedies(s)
    assert [r["id"] for r in shown] == [r["id"] for r in data()["remedies"]]
    view = remedies_api.remedy_view(shown[0])
    assert set(view) == {"id", "kind", "name", "description", "price_note", "review"}


def test_visibility_follows_partner_state(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = {
        "review": "needs_editorial_review",
        "notice": {"en": "", "hi": ""},
        "partners": [
            {"id": "real", "contact": {"channel": "email", "address": "p@x.test"}, "active": True},
            {"id": "paused", "contact": {}, "active": False},
            {"id": "dev", "contact": {}, "active": True, "dev_only": True},
        ],
        "remedies": [
            {"id": "a", "partner_id": "real"},
            {"id": "b", "partner_id": "paused"},
            {"id": "c", "partner_id": "dev"},
            {"id": "d", "partner_id": "missing"},
            {"id": "e", "partner_id": "real", "active": False},
        ],
    }
    monkeypatch.setattr(remedies_api, "catalogue_file", lambda: fake)
    prod, dev = Settings(app_env="production"), Settings(app_env="test")
    assert [r["id"] for r in remedies_api.visible_remedies(prod)] == ["a"]
    assert [r["id"] for r in remedies_api.visible_remedies(dev)] == ["a", "c"]
