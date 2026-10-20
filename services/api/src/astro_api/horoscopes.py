"""Horoscope QA pipeline. Generated text is never public until a person approves it
(PLAN.md §6: no LLM output published without the QA queue)."""

import datetime as dt
import hmac
import uuid
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.audit import audit
from astro_api.config import Settings
from astro_api.db import get_db
from astro_api.errors import ApiError
from astro_api.horoscope_rules import AREAS, text_errors
from astro_api.models import HoroscopeEntry

SIGNS = (
    "aries",
    "taurus",
    "gemini",
    "cancer",
    "leo",
    "virgo",
    "libra",
    "scorpio",
    "sagittarius",
    "capricorn",
    "aquarius",
    "pisces",
)
Period = Literal["daily", "weekly", "monthly"]
SignId = Literal[
    "aries",
    "taurus",
    "gemini",
    "cancer",
    "leo",
    "virgo",
    "libra",
    "scorpio",
    "sagittarius",
    "capricorn",
    "aquarius",
    "pisces",
]
Locale = Literal["en", "hi"]

public = APIRouter(prefix="/v1/horoscopes", tags=["horoscopes"])
admin = APIRouter(prefix="/v1/admin/horoscopes", tags=["admin"])


def ist_today() -> dt.date:
    return dt.datetime.now(ZoneInfo("Asia/Kolkata")).date()


class PublicHoroscope(BaseModel):
    id: uuid.UUID
    period: str
    sign: str
    locale: str
    window: dict[str, dt.date]
    sections: dict[str, str]
    scores: dict[str, Any]
    lucky: dict[str, Any]
    ai_generated: bool = True  # every AI text is labelled (PLAN.md §6)
    reviewed_at: dt.datetime | None
    prompt_version: str


class AdminHoroscope(PublicHoroscope):
    status: str
    facts: dict[str, Any]
    model: str
    reviewed_by: str | None
    review_note: str | None
    created_at: dt.datetime


def _public(e: HoroscopeEntry) -> dict[str, Any]:
    return {
        "id": e.id,
        "period": e.period,
        "sign": e.sign,
        "locale": e.locale,
        "window": {"start_ist_date": e.ist_date, "end_ist_date": e.ist_date_end},
        "sections": e.sections,
        "scores": e.scores,
        "lucky": e.lucky,
        "reviewed_at": e.reviewed_at,
        "prompt_version": e.prompt_version,
    }


def _admin(e: HoroscopeEntry) -> dict[str, Any]:
    return {
        **_public(e),
        "status": e.status,
        "facts": e.facts,
        "model": e.model,
        "reviewed_by": e.reviewed_by,
        "review_note": e.review_note,
        "created_at": e.created_at,
    }


@public.get("/{period}/{sign}", response_model=PublicHoroscope)
async def published(
    period: Period,
    sign: SignId,
    db: Annotated[AsyncSession, Depends(get_db)],
    date: dt.date | None = None,
    locale: Locale = "en",
) -> dict[str, Any]:
    day = date or ist_today()
    entry = (
        await db.execute(
            select(HoroscopeEntry).where(
                HoroscopeEntry.period == period,
                HoroscopeEntry.sign == sign,
                HoroscopeEntry.locale == locale,
                HoroscopeEntry.status == "published",
                HoroscopeEntry.ist_date <= day,
                HoroscopeEntry.ist_date_end >= day,
            )
        )
    ).scalar_one_or_none()
    if entry is None:
        raise ApiError(404, "not_published", "No reviewed horoscope for this period yet.")
    return _public(entry)


def require_admin(request: Request, authorization: Annotated[str | None, Header()] = None) -> str:
    """Bearer ADMIN_TOKEN. Without a configured token the admin API does not exist (404)."""
    settings: Settings = request.app.state.settings
    if settings.admin_token is None or not settings.admin_token.get_secret_value():
        raise ApiError(404, "not_found", "Not found.")
    scheme, _, token = (authorization or "").partition(" ")
    expected = settings.admin_token.get_secret_value().encode()
    if scheme.lower() != "bearer" or not hmac.compare_digest(token.strip().encode(), expected):
        raise ApiError(401, "unauthenticated", "Admin token required.")
    return "admin-token"


Admin = Annotated[str, Depends(require_admin)]


@admin.get("", response_model=list[AdminHoroscope])
async def list_entries(
    _: Admin,
    db: Annotated[AsyncSession, Depends(get_db)],
    status: Literal["pending_review", "published", "rejected"] = "pending_review",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[dict[str, Any]]:
    rows = await db.execute(
        select(HoroscopeEntry)
        .where(HoroscopeEntry.status == status)
        .order_by(
            HoroscopeEntry.ist_date,
            HoroscopeEntry.period,
            HoroscopeEntry.sign,
            HoroscopeEntry.locale,
        )
        .limit(limit)
    )
    return [_admin(e) for e in rows.scalars()]


async def _entry(db: AsyncSession, entry_id: uuid.UUID) -> HoroscopeEntry:
    entry = await db.get(HoroscopeEntry, entry_id)
    if entry is None:
        raise ApiError(404, "not_found", "Horoscope entry not found.")
    return entry


@admin.get("/{entry_id}", response_model=AdminHoroscope)
async def get_entry(
    _: Admin, entry_id: uuid.UUID, db: Annotated[AsyncSession, Depends(get_db)]
) -> dict[str, Any]:
    return _admin(await _entry(db, entry_id))


class Approve(BaseModel):
    reviewer: str = Field(min_length=2, max_length=80)
    sections: dict[str, str] | None = None  # edited text replaces the generated text


class Reject(BaseModel):
    reviewer: str = Field(min_length=2, max_length=80)
    reason: str = Field(min_length=3, max_length=500)


def apply_approval(
    entry: HoroscopeEntry, reviewer: str, sections: dict[str, str] | None
) -> list[str]:
    """Shared by the API and the worker CLI. Returns validation errors (nothing changes if any)."""
    if entry.status == "published":
        return ["already published"]
    new_sections = sections if sections is not None else entry.sections
    errors = text_errors(new_sections, entry.facts)
    if errors:
        return errors
    entry.sections = {a: new_sections[a] for a in AREAS}
    entry.status = "published"
    entry.reviewed_by = reviewer
    entry.reviewed_at = dt.datetime.now(dt.UTC)
    entry.review_note = "edited" if sections is not None else None
    return []


@admin.post("/{entry_id}/approve", response_model=AdminHoroscope)
async def approve(
    actor: Admin, entry_id: uuid.UUID, body: Approve, db: Annotated[AsyncSession, Depends(get_db)]
) -> dict[str, Any]:
    entry = await _entry(db, entry_id)
    errors = apply_approval(entry, body.reviewer, body.sections)
    if errors:
        raise ApiError(422, "invalid_sections", "; ".join(errors), errors=errors)
    audit(
        db,
        f"{actor}:{body.reviewer}",
        "horoscope.approve",
        "horoscope_entry",
        str(entry.id),
        edited=body.sections is not None,
    )
    await db.commit()
    return _admin(entry)


@admin.post("/{entry_id}/reject", response_model=AdminHoroscope)
async def reject(
    actor: Admin, entry_id: uuid.UUID, body: Reject, db: Annotated[AsyncSession, Depends(get_db)]
) -> dict[str, Any]:
    entry = await _entry(db, entry_id)
    if entry.status == "published":
        raise ApiError(409, "already_published", "Published entries cannot be rejected.")
    entry.status = "rejected"
    entry.reviewed_by = body.reviewer
    entry.reviewed_at = dt.datetime.now(dt.UTC)
    entry.review_note = body.reason
    audit(db, f"{actor}:{body.reviewer}", "horoscope.reject", "horoscope_entry", str(entry.id))
    await db.commit()
    return _admin(entry)
