"""Horoscope generation and review.

generate: engine facts → prompt (facts only) → LLM → validation (one retry with the errors) →
horoscope_entries row with status pending_review. Nothing is public until a person approves it.
"""

import datetime as dt
import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from astro_api.audit import audit
from astro_api.horoscope_rules import AREAS, WORDS_PROMPT, text_errors
from astro_api.horoscopes import SIGNS, apply_approval
from astro_api.models import HoroscopeEntry
from astro_api.shared_files import data_dir
from astro_worker.llm import LlmProvider, LlmRequest, ProviderError

PROMPT_VERSION = "horoscope-v1"
LANGUAGE = {"en": "English", "hi": "Hindi, in natural Devanagari script"}

SYSTEM = f"""You write short horoscope texts for a Vedic astrology website.

Rules:
- Interpret only the planetary positions in the facts you are given. Never introduce a planet,
  sign, house, date, event or number that is not in the facts.
- When you name a planet's sign or house, use exactly the sign and house the facts give it.
- Write for a general audience in the second person ("you"), warm and practical.
- No fear, no predictions of harm, no guarantees or certainty about outcomes.
- No medical, legal or financial advice; no remedies, rituals, gemstones or products.
- Each of the five areas (overall, love, career, money, health) gets
  {WORDS_PROMPT[0]}-{WORDS_PROMPT[1]} words.
- Return only a JSON object with the keys overall, love, career, money, health.
"""


@dataclass
class Report:
    stored: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: dict[str, list[str]] = field(default_factory=dict)


def _names(locale: str) -> dict[str, dict[str, str]]:
    grahas = json.loads((data_dir() / "grahas.json").read_text(encoding="utf-8"))["grahas"]
    signs = json.loads((data_dir() / "signs.json").read_text(encoding="utf-8"))["signs"]
    return {
        "planets": {g["id"]: g[locale] for g in grahas},
        "signs": {s["id"]: s[locale] for s in signs},
    }


def build_prompt(facts: dict[str, Any], locale: str) -> str:
    view = {
        "sign": facts["sign"],
        "period": facts["period"],
        "window": facts["window"],
        "transits": facts["transits"],
        "areas": {a: facts["areas"][a] for a in AREAS},
    }
    return (
        f"Write the {facts['period']} horoscope for people whose Moon sign is {facts['sign']}, "
        f"in {LANGUAGE[locale]}.\n"
        "house_from_sign counts houses from their Moon sign. Each area has a score from 1 (hard) "
        "to 5 (easy) with the reasons behind it; match the tone to the score.\n"
        "Names to use for planets and signs in this language: "
        f"{json.dumps(_names(locale), ensure_ascii=False)}\n"
        f"Facts:\n{json.dumps(view, ensure_ascii=False, indent=1)}"
    )


def parse_sections(text: str) -> tuple[dict[str, Any], list[str]]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}, ["output is not valid JSON"]
    if not isinstance(data, dict):
        return {}, ["output is not a JSON object"]
    return data, []


async def fetch_facts(
    http: httpx.AsyncClient, astro_url: str, sign: str, period: str, day: dt.date
) -> dict[str, Any]:
    r = await http.get(
        f"{astro_url.rstrip('/')}/v1/horoscope/facts",
        params={"sign": sign, "period": period, "date": day.isoformat()},
    )
    r.raise_for_status()
    facts: dict[str, Any] = r.json()
    return facts


async def _write(
    provider: LlmProvider, facts: dict[str, Any], locale: str
) -> tuple[dict[str, str] | None, str, list[str]]:
    """Ask the provider, validate, retry once with the errors. Returns (sections, model, errors)."""
    user = build_prompt(facts, locale)
    errors: list[str] = []
    model = provider.name
    for attempt in range(2):
        prompt = (
            user
            if attempt == 0
            else (
                f"{user}\n\nYour previous answer was rejected for these reasons; "
                "fix all of them:\n- " + "\n- ".join(errors)
            )
        )
        try:
            result = await provider.generate(LlmRequest(SYSTEM, prompt, facts, locale))
        except ProviderError as exc:
            return None, model, [str(exc)]
        model = result.model
        sections, errors = parse_sections(result.text)
        if not errors:
            errors = text_errors(sections, facts)
        if not errors:
            return {a: str(sections[a]) for a in AREAS}, model, []
    return None, model, errors


async def generate(
    *,
    period: str,
    day: dt.date,
    signs: list[str],
    locales: list[str],
    force: bool,
    provider: LlmProvider,
    http: httpx.AsyncClient,
    astro_url: str,
    sessionmaker: async_sessionmaker[AsyncSession],
) -> Report:
    report = Report()
    for sign in signs:
        try:
            facts = await fetch_facts(http, astro_url, sign, period, day)
        except httpx.HTTPError as exc:
            report.failed[f"{period}/{sign}"] = [f"facts unavailable: {type(exc).__name__}"]
            continue
        start = dt.date.fromisoformat(facts["window"]["start_ist_date"])
        end = dt.date.fromisoformat(facts["window"]["end_ist_date"])
        for locale in locales:
            label = f"{period}/{sign}/{start.isoformat()}/{locale}"
            async with sessionmaker() as db:
                existing = (
                    await db.execute(
                        select(HoroscopeEntry).where(
                            HoroscopeEntry.period == period,
                            HoroscopeEntry.sign == sign,
                            HoroscopeEntry.ist_date == start,
                            HoroscopeEntry.locale == locale,
                        )
                    )
                ).scalar_one_or_none()
                if existing is not None and (existing.status == "published" or not force):
                    report.skipped.append(label)
                    continue
                sections, model, errors = await _write(provider, facts, locale)
                if sections is None:
                    report.failed[label] = errors
                    continue
                entry = existing or HoroscopeEntry(
                    period=period, sign=sign, ist_date=start, locale=locale
                )
                entry.ist_date_end = end
                entry.sections = sections
                entry.scores = {
                    a: {
                        "score": facts["areas"][a]["score"],
                        "label": facts["areas"][a].get("label"),
                    }
                    for a in AREAS
                }
                entry.lucky = facts.get("lucky", {})
                entry.facts = facts
                entry.model = model
                entry.prompt_version = PROMPT_VERSION
                entry.status = "pending_review"
                entry.reviewed_by = entry.reviewed_at = entry.review_note = None
                db.add(entry)
                await db.flush()
                audit(
                    db,
                    "worker",
                    "horoscope.generate",
                    "horoscope_entry",
                    str(entry.id),
                    model=model,
                    prompt_version=PROMPT_VERSION,
                    regenerated=existing is not None,
                )
                await db.commit()
                report.stored.append(label)
    return report


def entry_summary(e: HoroscopeEntry) -> dict[str, Any]:
    return {
        "id": str(e.id),
        "period": e.period,
        "sign": e.sign,
        "window": [e.ist_date.isoformat(), e.ist_date_end.isoformat()],
        "locale": e.locale,
        "status": e.status,
        "model": e.model,
    }


async def review_list(
    sessionmaker: async_sessionmaker[AsyncSession], status: str = "pending_review"
) -> list[dict[str, Any]]:
    async with sessionmaker() as db:
        rows = await db.execute(
            select(HoroscopeEntry)
            .where(HoroscopeEntry.status == status)
            .order_by(
                HoroscopeEntry.ist_date,
                HoroscopeEntry.period,
                HoroscopeEntry.sign,
                HoroscopeEntry.locale,
            )
        )
        return [entry_summary(e) for e in rows.scalars()]


async def review_show(
    sessionmaker: async_sessionmaker[AsyncSession], entry_id: uuid.UUID
) -> dict[str, Any] | None:
    async with sessionmaker() as db:
        e = await db.get(HoroscopeEntry, entry_id)
        if e is None:
            return None
        return {**entry_summary(e), "sections": e.sections, "scores": e.scores, "facts": e.facts}


async def review_approve(
    sessionmaker: async_sessionmaker[AsyncSession],
    entry_id: uuid.UUID,
    reviewer: str,
    sections: dict[str, str] | None,
) -> list[str]:
    async with sessionmaker() as db:
        e = await db.get(HoroscopeEntry, entry_id)
        if e is None:
            return ["not found"]
        errors = apply_approval(e, reviewer, sections)
        if errors:
            return errors
        audit(
            db,
            f"cli:{reviewer}",
            "horoscope.approve",
            "horoscope_entry",
            str(e.id),
            edited=sections is not None,
        )
        await db.commit()
        return []


async def review_reject(
    sessionmaker: async_sessionmaker[AsyncSession], entry_id: uuid.UUID, reviewer: str, reason: str
) -> list[str]:
    async with sessionmaker() as db:
        e = await db.get(HoroscopeEntry, entry_id)
        if e is None:
            return ["not found"]
        if e.status == "published":
            return ["published entries cannot be rejected"]
        e.status = "rejected"
        e.reviewed_by = reviewer
        e.reviewed_at = dt.datetime.now(dt.UTC)
        e.review_note = reason
        audit(db, f"cli:{reviewer}", "horoscope.reject", "horoscope_entry", str(e.id))
        await db.commit()
        return []


__all__ = [
    "SIGNS",
    "Report",
    "generate",
    "review_approve",
    "review_list",
    "review_reject",
    "review_show",
]
