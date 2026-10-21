"""The one safety classifier (astro_api.safety, docs/api/trust.md §3) and its data files.

Category coverage (self-harm, medical, legal, financial, scam, fear selling, benign controls in
en/hi/Hinglish) lives in evals/safety; these tests cover the mechanics: client messages are never
refused, negations, rule ids vs conduct.json, helplines vs helplines.json, the AI delegating to
this module, and shapes shared with packages/shared.
"""

import json
import re

import pytest

from astro_api import ai_safety, safety
from astro_api.models_safety import MODERATION_REASONS, REPORT_REASONS
from astro_api.shared_files import safety_dir, shared_dir


def test_client_messages_are_never_refused() -> None:
    # Even text that would be refused from an astrologer goes through from the client.
    for text in (
        "Call me on 9876543210",
        "pay me on gpay directly",
        "you will definitely marry, 100% guaranteed",
        "I want to kill myself",
        "मैं आत्महत्या करना चाहता हूँ",
    ):
        check = safety.check_message("user", text)
        assert check.action != "refuse" and check.refusal is None


def test_crisis_from_the_client_flags_and_shows_the_banner() -> None:
    check = safety.check_message("user", "I don't want to live anymore")
    assert check.action == "flag" and check.crisis == "self_harm" and check.banner == "crisis"
    check = safety.check_message("user", "my husband is beating me right now")
    assert check.action == "flag" and check.crisis == "emergency" and check.banner == "crisis"
    check = safety.check_message("user", "When will I get married?")
    assert check.action == "deliver" and check.banner == "none"


def test_self_harm_words_from_the_astrologer_are_not_refused() -> None:
    # Sharing crisis resources must always work.
    for text in (
        "If you are thinking about suicide, please call Tele-MANAS on 14416 now.",
        "अगर आप ख़ुद को नुक़सान पहुँचाने की सोच रहे हैं तो अभी 14416 पर कॉल करें।",
        "In an emergency please dial 112.",
    ):
        assert safety.check_message("astrologer", text).action == "deliver", text


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("Message me on WhatsApp", "contact_details"),
        ("my number is 98765 43210", "contact_details"),
        ("+91-9876543210", "contact_details"),
        ("write to me at guru.ji@example.com", "contact_details"),
        ("see www.example.com", "contact_details"),
        ("send the money to my UPI id", "off_platform_payment"),
        ("guruji@okaxis pe bhej do", "off_platform_payment"),
        ("This neelam costs Rs 5000, I will courier it", "remedy_sale"),
        ("मैं पूजा करवा दूंगा, 2100 रुपये लगेंगे", "remedy_sale"),
        ("This yantra will cure your diabetes", "cure_claim"),
        ("आपकी बीमारी ठीक हो जाएगी", "cure_claim"),
        ("I guarantee you will get the job", "guarantee"),
        ("100% shaadi hogi", "guarantee"),
        ("There is a curse on your family", "fear_selling"),
        ("आपके परिवार पर श्राप है", "fear_selling"),
        ("Stop taking your medicines, the stars will heal you", "cure_claim"),
        ("दवा बंद कर दो", "cure_claim"),
    ],
)
def test_astrologer_rules(text: str, reason: str) -> None:
    check = safety.check_message("astrologer", text)
    assert check.action == "refuse" and check.refusal == reason
    assert check.banner == "none"


@pytest.mark.parametrize(
    "text",
    [
        "I cannot guarantee anything; this is guidance.",
        "No remedy can cure an illness. Please see a doctor.",
        "मैं कोई गारंटी नहीं देता।",
        "Don't stop your medicines without your doctor.",
        "दवा बंद मत करो, डॉक्टर से पूछो।",
        "Please don't pay anyone outside the app.",
        "Remedies are optional and you don't need to buy any gemstone.",
        "Saturn brings delays now; pay attention to your routine.",
        "Your chart is good.In 2027 a job change is possible.",
        "Your Moon is in Cancer and Jupiter aspects your 7th house.",
    ],
)
def test_negations_and_ordinary_astrology_pass(text: str) -> None:
    assert safety.check_message("astrologer", text).action == "deliver", text


def test_refusal_reasons_are_conduct_rules() -> None:
    rules = {r["id"]: r for r in safety.conduct()["rules"]}
    for reason in safety.REFUSALS:
        assert reason in rules, reason
        assert rules[reason]["enforced"] == "auto"
        assert safety.refusal_message(reason) == rules[reason]["rule"]["en"]
    assert {r["enforced"] for r in rules.values()} <= {"auto", "review"}
    for rule in rules.values():
        for field in ("title", "rule"):
            assert rule[field]["en"].strip() and rule[field]["hi"].strip()
            assert re.search(r"[ऀ-ॿ]", rule[field]["hi"]), rule["id"]
    guidance = safety.conduct()["crisis_guidance"]
    assert guidance["en"] and guidance["hi"]


def test_rule_text_shows_no_phone_numbers() -> None:
    raw = (safety_dir() / "conduct.json").read_text("utf-8")
    assert not re.search(r"\d{3,}", raw.replace("2026-10-21", "").replace("100%", ""))


def test_resources_serve_helplines_json_unchanged() -> None:
    raw = json.loads((safety_dir() / "helplines.json").read_text("utf-8"))
    out = safety.resources()
    assert [h["number"] for h in out["helplines"]] == [h["number"] for h in raw["helplines"]]
    assert out["not_a_helpline"] == raw["not_a_helpline"]
    assert out["verified_by_founder"] is raw["verified_by_founder"]
    # packages/shared/src/trust.ts Helpline
    ts = (shared_dir() / "src" / "trust.ts").read_text("utf-8")
    block = ts.split("export interface Helpline {", 1)[1].split("\n}", 1)[0]
    fields = set(re.findall(r"^  (\w+):", block, re.MULTILINE))
    for h in out["helplines"]:
        assert set(h) == fields
        assert set(h["name"]) == set(h["hours"]) == {"en", "hi"}


def test_report_reasons_match_packages_shared() -> None:
    ts = (shared_dir() / "src" / "trust.ts").read_text("utf-8")
    block = ts.split("ASTROLOGER_REPORT_REASONS = [", 1)[1].split("]", 1)[0]
    assert tuple(re.findall(r'"(\w+)"', block)) == REPORT_REASONS
    assert set(safety.REFUSALS) | set(safety.CRISIS_KINDS) <= set(MODERATION_REASONS)


def test_safety_event_and_block_reasons_match_packages_shared() -> None:
    ts = (shared_dir() / "src" / "chat.ts").read_text("utf-8")
    assert '{ type: "safety"; kind: "self_harm" }' in ts
    block = ts.split("export const BLOCK_REASONS = [", 1)[1].split("]", 1)[0]
    assert tuple(re.findall(r'"(\w+)"', block)) == safety.REFUSALS
    assert "safety_flag: boolean;" in ts


def test_financial_advice_is_left_to_reports() -> None:
    # Not one of the automatic refusal reasons (chat.ts BLOCK_REASONS): handled by review.
    assert safety.check_message("astrologer", "Buy shares of this company tomorrow").action == (
        "deliver"
    )
    rules = {r["id"]: r for r in safety.conduct()["rules"]}
    assert rules["financial_advice"]["enforced"] == "review"


def test_ai_classifier_delegates_to_the_shared_one() -> None:
    samples = [
        "I want to end my life",
        "my father collapsed",
        "Will my cancer treatment work?",
        "Will I win my court case?",
        "Should I buy crypto?",
        "Pay me on gpay",  # scam is chat-only: the AI does not block it
        "When will I get married?",
    ]
    for text in samples:
        kind = safety.classify(text, ai_safety.AI_CATEGORIES)
        v = ai_safety.classify(text)
        assert v.kind == kind
    assert ai_safety.classify("Pay me on gpay").reason is None
    assert safety.classify("Pay me on gpay") == "scam"


@pytest.mark.parametrize(
    "text",
    [
        "Is Leo compatible with Cancer?",
        "I have Cancer moon and Leo sun",
        "My wife has Cancer as her sign",
        "कर्क राशि वालों के लिए यह महीना कैसा है?",
        "meri rashi kark hai, career kaisa rahega",
    ],
)
def test_zodiac_cancer_is_not_medical(text: str) -> None:
    assert safety.classify(text) is None
    assert ai_safety.classify(text).reason is None


def test_categories_lists_every_match_in_priority_order() -> None:
    cats = safety.categories("My loan and court case make me want to kill myself")
    assert cats[0] == "self_harm" and "legal" in cats and "financial" in cats
    assert safety.categories("What does my 10th house say about work?") == ()
