"""Rules every horoscope text must pass before it reaches the review queue (and again when a
reviewer edits it): length, banned claims, and grounding in the computed facts.

Grounding: a planet or sign named in the text must be one the facts actually place there. Names
come from data/astro (grahas.json, signs.json) in English, Sanskrit transliteration and Hindi.
"""

import json
import re
from dataclasses import dataclass
from functools import cache
from typing import Any

from astro_api.shared_files import data_dir

AREAS = ("overall", "love", "career", "money", "health")
WORDS_PROMPT = (60, 110)  # what the prompt asks for
WORDS_ALLOWED = (45, 140)  # what the validator accepts (Hindi runs a little longer)

BANNED: tuple[str, ...] = (
    # guarantees and certainty
    r"\bguarantee",
    r"\bwill definitely\b",
    r"\bcertainly will\b",
    r"\b100\s?%",
    # fear and harm
    r"\bdeath\b",
    r"\bdie\b",
    r"\baccident",
    r"\bcurse",
    r"\bdoom",
    r"\bdisaster",
    # medical claims
    r"\bcure",
    r"\bdiagnos",
    r"\bmedicine\b",
    r"\bdisease\b",
    # financial calls
    r"\binvest",
    r"\b(buy|sell)\s+(stocks?|shares|crypto)",
    r"\blottery\b",
    r"\bgambl",
    r"\bbetting\b",
    # remedies and products
    r"\bgemstone",
    r"\bremed(y|ies)\b",
    r"\bpuja\b",
    # Hindi
    r"गारंटी",
    r"निश्चित रूप से",
    r"इलाज",
    r"मृत्यु",
    r"मौत",
    r"दुर्घटना",
    r"निवेश",
    r"लॉटरी",
    r"जुआ",
    r"श्राप",
    r"रत्न",
    r"उपाय",
)
_BANNED_RE = [re.compile(p, re.IGNORECASE) for p in BANNED]


@dataclass(frozen=True)
class Names:
    graha: dict[str, str]  # normalised name → graha id
    sign: dict[str, str]  # normalised name → sign id


# Hindi spelling varies between anusvara and a conjunct nasal (चंद्र / चन्द्र); compare both forms
# after mapping anusvara before a consonant to that consonant's class nasal.
_NASAL_BY_CLASS = [("कखगघ", "ङ्"), ("चछजझ", "ञ्"), ("टठडढ", "ण्"), ("तथदध", "न्"), ("पफबभ", "म्")]


def _norm_hi(text: str) -> str:
    out = []
    for i, ch in enumerate(text):
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch == "ं":
            nasal = next((n for group, n in _NASAL_BY_CLASS if nxt and nxt in group), None)
            out.append(nasal or ch)
        else:
            out.append(ch)
    return "".join(out)


@cache
def names() -> Names:
    grahas = json.loads((data_dir() / "grahas.json").read_text(encoding="utf-8"))["grahas"]
    signs = json.loads((data_dir() / "signs.json").read_text(encoding="utf-8"))["signs"]
    g = {_norm_hi(x[k]).lower(): x["id"] for x in grahas for k in ("en", "hi", "sa")}
    s = {_norm_hi(x[k]).lower(): x["id"] for x in signs for k in ("en", "hi", "sa")}
    return Names(graha=g, sign=s)


_SENTENCE = re.compile(r"[^.!?।]+")
_TOKEN = re.compile(r"[A-Za-z]+|[ऀ-ॿ]+")
_HOUSE = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)\s+house\b", re.IGNORECASE)


def _mentions(sentence: str, table: dict[str, str]) -> set[str]:
    found = set()
    for token in _TOKEN.findall(_norm_hi(sentence)):
        t = token.lower()
        for name, ident in table.items():
            # Hindi nouns inflect (चन्द्रमा, सूर्य); allow up to two trailing characters.
            if t == name or (not t.isascii() and t.startswith(name) and len(t) - len(name) <= 2):
                found.add(ident)
    return found


def _fact_index(facts: dict[str, Any]) -> tuple[dict[str, set[str]], dict[str, set[int]]]:
    signs: dict[str, set[str]] = {}
    houses: dict[str, set[int]] = {}
    for t in facts.get("transits", []):
        signs.setdefault(t["graha"], set()).add(t["sign"])
        houses.setdefault(t["graha"], set()).add(int(t["house_from_sign"]))
        for ing in t.get("ingresses", []) or []:
            signs[t["graha"]].add(ing["to_sign"])
    return signs, houses


def grounding_errors(text: str, facts: dict[str, Any]) -> list[str]:
    n = names()
    subject = facts["sign"]
    graha_signs, graha_houses = _fact_index(facts)
    all_fact_signs = {s for v in graha_signs.values() for s in v} | {subject}
    all_houses = {h for v in graha_houses.values() for h in v}
    errors = []
    for sentence in _SENTENCE.findall(text):
        grahas = _mentions(sentence, n.graha)
        for g in grahas - set(graha_signs):
            errors.append(f"mentions {g}, which is not in the facts")
        for s in _mentions(sentence, n.sign) - {subject}:
            allowed = (
                set().union(*(graha_signs.get(g, set()) for g in grahas))
                if grahas
                else all_fact_signs
            )
            if s not in allowed:
                who = ", ".join(sorted(grahas)) or "any planet"
                errors.append(f"places {who} in {s}, which the facts do not")
        for m in _HOUSE.finditer(sentence):
            house = int(m.group(1))
            allowed_h = (
                set().union(*(graha_houses.get(g, set()) for g in grahas)) if grahas else all_houses
            )
            if house not in allowed_h:
                errors.append(f"mentions the {house}th house, which the facts do not")
    return errors


def text_errors(sections: dict[str, Any], facts: dict[str, Any]) -> list[str]:
    """All problems with a set of sections; empty means it may enter the review queue."""
    errors = []
    if set(sections) != set(AREAS):
        errors.append(f"sections must be exactly {list(AREAS)}")
    for area in AREAS:
        text = sections.get(area)
        if not isinstance(text, str) or not text.strip():
            errors.append(f"{area}: missing")
            continue
        words = len(text.split())
        if not WORDS_ALLOWED[0] <= words <= WORDS_ALLOWED[1]:
            errors.append(f"{area}: {words} words (expected {WORDS_PROMPT[0]}-{WORDS_PROMPT[1]})")
        for rx in _BANNED_RE:
            if rx.search(text):
                errors.append(f"{area}: banned phrase /{rx.pattern}/")
        errors.extend(f"{area}: {e}" for e in grounding_errors(text, facts))
    return errors
