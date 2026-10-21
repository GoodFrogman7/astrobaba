"""Astrologer invites, supply readiness, content calendar, almanac dates and launch readiness
(docs/api/growth.md §2, §4, §5).

Invites: a 12-character code from an unambiguous alphabet, made with `secrets`, stored only as
HMAC-SHA256 keyed with SECRET_KEY and shown once. Status is derived (revoked > used > expired >
open). Applying with a code locks the invite row (`SELECT ... FOR UPDATE`) and marks it used in
the application's transaction; `astrologers.invite_id` is UNIQUE as the backstop.

Almanac dates come from the engine only (`/v1/panchang`, New Delhi, one call per IST day), never
from this service; each day's extracted facts are cached in Redis for 7 days.

Launch readiness computes every check live and stores nothing; details never hold secrets.
"""

import asyncio
import datetime as dt
import json
import re
import secrets
import uuid
from typing import Annotated, Any, Literal, get_args
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from redis.asyncio import Redis
from sqlalchemy import ColumnElement, and_, case, func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.audit import audit
from astro_api.config import Settings, legal_version
from astro_api.consent import hmac_hex
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.flags import flag_enabled
from astro_api.horoscopes import SIGNS
from astro_api.marketplace import is_public
from astro_api.models import (
    ASTROLOGER_STATUSES,
    VERIFICATION_STEPS,
    Astrologer,
    AstrologerVerification,
    HoroscopeEntry,
)
from astro_api.models_growth import (
    CONTENT_KINDS,
    CONTENT_LOCALES,
    CONTENT_NOTES_MAX,
    CONTENT_STATUSES,
    CONTENT_TITLE_MAX,
    CONTENT_URL_MAX,
    INVITE_NOTE_MAX,
    INVITE_STATUSES,
    AstrologerInvite,
    ContentItem,
)
from astro_api.models_jobs import Job
from astro_api.models_ledger import ReconciliationRun
from astro_api.models_portal import AstrologerAvailability
from astro_api.roles import AdminUser, actor
from astro_api.shared_files import growth_dir, safety_dir

router = APIRouter(tags=["growth"])

IST = ZoneInfo("Asia/Kolkata")


def ist_today() -> dt.date:
    return dt.datetime.now(IST).date()


def targets() -> dict[str, Any]:
    """data/growth/targets.json, read on every call (assumptions the founder edits)."""
    data: dict[str, Any] = json.loads((growth_dir() / "targets.json").read_text("utf-8"))
    return data


# ================================================================ §2.1 invites

INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # [A-HJ-NP-Z2-9]: no 0/O, 1/I
INVITE_LENGTH = 12
INVITE_FLAG = "astrologer_invite_only"
INVITE_DEFAULT_DAYS = 14
_CODE = re.compile(rf"^[{INVITE_ALPHABET}]{{{INVITE_LENGTH}}}$")
_SEPARATORS = re.compile(r"[\s\-]+")


def new_invite_code() -> str:
    return "".join(secrets.choice(INVITE_ALPHABET) for _ in range(INVITE_LENGTH))


def normalize_code(raw: str) -> str:
    """People type codes by hand: ignore case, spaces and hyphens."""
    return _SEPARATORS.sub("", raw).upper()


def invite_hash(settings: Settings, code: str) -> str:
    return hmac_hex(settings, "astrologer_invite", code)


def invite_url(settings: Settings, code: str) -> str:
    return f"{settings.public_site_url.rstrip('/')}/astrologers/apply?invite={code}"


def _invalid_invite() -> ApiError:
    return ApiError(422, "invite_invalid", "This invite code is not valid. Ask us for a new one.")


async def lock_open_invite(
    db: AsyncSession, settings: Settings, raw_code: str, now: dt.datetime | None = None
) -> AstrologerInvite:
    """The open invite for this code, locked until the caller's transaction ends. A concurrent
    claim waits here and then sees the invite used. Unknown, used, expired or revoked → 422."""
    code = normalize_code(raw_code)
    if not _CODE.fullmatch(code):
        raise _invalid_invite()
    invite = (
        await db.execute(
            select(AstrologerInvite)
            .where(AstrologerInvite.code_hash == invite_hash(settings, code))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if invite is None or invite.status_at(now or dt.datetime.now(dt.UTC)) != "open":
        raise _invalid_invite()
    return invite


def require_invite_if_flagged(code: str | None) -> None:
    if not code and flag_enabled(INVITE_FLAG):
        raise ApiError(403, "invite_required", "Applications are by invitation only right now.")


def mark_invite_used(invite: AstrologerInvite, astrologer_id: uuid.UUID) -> None:
    invite.used_at = dt.datetime.now(dt.UTC)
    invite.used_by_astrologer_id = astrologer_id


def _status_expr(now: dt.datetime) -> ColumnElement[str]:
    return case(
        (AstrologerInvite.revoked_at.is_not(None), "revoked"),
        (AstrologerInvite.used_at.is_not(None), "used"),
        (AstrologerInvite.expires_at <= now, "expired"),
        else_="open",
    )


def _invite_view(i: AstrologerInvite, now: dt.datetime) -> dict[str, Any]:
    return {
        "id": i.id,
        "note": i.note,
        "status": i.status_at(now),
        "created_at": i.created_at,
        "expires_at": i.expires_at,
        "used_at": i.used_at,
        "astrologer_id": i.used_by_astrologer_id,
    }


class InviteIn(BaseModel):
    note: str | None = Field(default=None, max_length=INVITE_NOTE_MAX)
    expires_days: int = Field(default=INVITE_DEFAULT_DAYS, ge=1, le=60)


@router.post("/v1/admin/astrologer-invites", status_code=201)
async def create_invite(
    body: InviteIn, admin: AdminUser, db: Db, request: Request
) -> dict[str, Any]:
    settings = settings_of(request)
    code = new_invite_code()
    now = dt.datetime.now(dt.UTC)
    invite = AstrologerInvite(
        code_hash=invite_hash(settings, code),
        note=(body.note or "").strip() or None,
        created_by=admin.id,
        created_at=now,
        expires_at=now + dt.timedelta(days=body.expires_days),
    )
    db.add(invite)
    await db.flush()
    # Neither the code nor the note goes in the audit row.
    audit(
        db,
        actor(admin),
        "astrologer_invite.create",
        "astrologer_invite",
        str(invite.id),
        expires_days=body.expires_days,
    )
    await db.commit()
    return {
        "id": invite.id,
        "code": code,
        "url": invite_url(settings, code),
        "expires_at": invite.expires_at,
    }


@router.get("/v1/admin/astrologer-invites")
async def list_invites(
    admin: AdminUser,
    db: Db,
    status: Literal["open", "used", "expired", "revoked"] | None = None,
) -> dict[str, Any]:
    now = dt.datetime.now(dt.UTC)
    query = select(AstrologerInvite).order_by(
        AstrologerInvite.created_at.desc(), AstrologerInvite.id
    )
    if status is not None:
        query = query.where(_status_expr(now) == status)
    rows = (await db.execute(query)).scalars()
    return {"items": [_invite_view(i, now) for i in rows]}


@router.post("/v1/admin/astrologer-invites/{invite_id}/revoke")
async def revoke_invite(invite_id: uuid.UUID, admin: AdminUser, db: Db) -> dict[str, Any]:
    invite = (
        await db.execute(
            select(AstrologerInvite).where(AstrologerInvite.id == invite_id).with_for_update()
        )
    ).scalar_one_or_none()
    if invite is None:
        raise ApiError(404, "not_found", "Invite not found.")
    if invite.used_at is not None:
        raise ApiError(409, "invite_used", "This invite has already been used.")
    if invite.revoked_at is None:
        invite.revoked_at = dt.datetime.now(dt.UTC)
        audit(db, actor(admin), "astrologer_invite.revoke", "astrologer_invite", str(invite.id))
        await db.commit()
    return _invite_view(invite, dt.datetime.now(dt.UTC))


# ================================================================ §2.2 supply readiness

PIPELINE_STATUSES = ASTROLOGER_STATUSES


async def invite_counts(db: AsyncSession) -> dict[str, int]:
    status = _status_expr(dt.datetime.now(dt.UTC))
    rows = (await db.execute(select(status, func.count()).group_by(status))).all()
    counts = {s: 0 for s in INVITE_STATUSES}
    counts.update({str(s): int(n) for s, n in rows})
    return counts


def schedule_hours(slots: list[tuple[uuid.UUID, int, int, int]]) -> list[list[int]]:
    """7 rows (Monday first) x 24 IST hours: distinct astrologers with a slot overlapping that
    hour. Slots are (astrologer, weekday, start_minute, end_minute)."""
    cells: list[list[set[uuid.UUID]]] = [[set() for _ in range(24)] for _ in range(7)]
    for astrologer_id, weekday, start, end in slots:
        for hour in range(start // 60, min(24, -(-end // 60))):
            if start < (hour + 1) * 60 and end > hour * 60:
                cells[weekday][hour].add(astrologer_id)
    return [[len(c) for c in row] for row in cells]


def uncovered_hours(hours: list[list[int]], core: dict[str, Any]) -> int:
    """Core-hours cells with nobody scheduled. `to_hour` is exclusive (9-23 = 09:00-23:00)."""
    return sum(
        1
        for weekday in core["weekdays"]
        for hour in range(int(core["from_hour"]), int(core["to_hour"]))
        if hours[int(weekday)][hour] == 0
    )


def _coverage(rows: list[dict[str, Any]], live: list[Astrologer], attr: str) -> list[Any]:
    return [
        {
            "id": row["id"],
            "live": sum(1 for a in live if row["id"] in (getattr(a, attr) or [])),
            "target_min": int(row["min"]),
        }
        for row in rows
    ]


async def supply_readiness(db: AsyncSession, settings: Settings) -> dict[str, Any]:
    goals = targets()["supply"]
    # Demo (seed) astrologers are never counted anywhere here.
    everyone = list(
        (await db.execute(select(Astrologer).where(Astrologer.is_seed.is_(False)))).scalars()
    )
    live = [a for a in everyone if a.status == "approved" and is_public(a, settings)]
    pipeline = {s: 0 for s in PIPELINE_STATUSES}
    for a in everyone:
        pipeline[a.status] += 1
    passed = dict.fromkeys(VERIFICATION_STEPS, 0)
    step_rows = (
        await db.execute(
            select(AstrologerVerification.step, func.count())
            .join(Astrologer, Astrologer.id == AstrologerVerification.astrologer_id)
            .where(Astrologer.is_seed.is_(False), AstrologerVerification.status == "passed")
            .group_by(AstrologerVerification.step)
        )
    ).all()
    passed.update({str(step): int(n) for step, n in step_rows})
    slots: list[tuple[uuid.UUID, int, int, int]] = []
    if live:
        slots = [
            (r[0], int(r[1]), int(r[2]), int(r[3]))
            for r in (
                await db.execute(
                    select(
                        AstrologerAvailability.astrologer_id,
                        AstrologerAvailability.weekday,
                        AstrologerAvailability.start_minute,
                        AstrologerAvailability.end_minute,
                    ).where(AstrologerAvailability.astrologer_id.in_([a.id for a in live]))
                )
            ).all()
        ]
    hours = schedule_hours(slots)
    return {
        "target": {
            "min": int(goals["astrologers"]["min"]),
            "max": int(goals["astrologers"]["max"]),
        },
        "live": len(live),
        "pipeline": pipeline,
        "steps_passed": passed,
        "languages": _coverage(goals["languages"], live, "languages"),
        "skills": _coverage(goals["skills"], live, "skills"),
        "schedule": {
            "hours": hours,
            "uncovered_hours": uncovered_hours(hours, goals["core_hours"]),
        },
        "invites": await invite_counts(db),
    }


@router.get("/v1/admin/growth/supply")
async def get_supply(admin: AdminUser, db: Db, request: Request) -> dict[str, Any]:
    return await supply_readiness(db, settings_of(request))


# ================================================================ §4.1 content calendar

ContentKind = Literal["article", "horoscope", "tool_page", "social", "video", "other"]
ContentLocale = Literal["en", "hi", "both"]
ContentStatus = Literal["idea", "drafting", "review", "scheduled", "published"]
assert get_args(ContentKind) == CONTENT_KINDS
assert get_args(ContentLocale) == CONTENT_LOCALES
assert get_args(ContentStatus) == CONTENT_STATUSES


class ContentIn(BaseModel):
    title: str = Field(min_length=1, max_length=CONTENT_TITLE_MAX)
    kind: ContentKind
    locale: ContentLocale
    status: ContentStatus = "idea"
    due_date: dt.date | None = None
    url: str | None = Field(default=None, max_length=CONTENT_URL_MAX)
    notes: str | None = Field(default=None, max_length=CONTENT_NOTES_MAX)


class ContentPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=CONTENT_TITLE_MAX)
    kind: ContentKind | None = None
    locale: ContentLocale | None = None
    status: ContentStatus | None = None
    due_date: dt.date | None = None
    url: str | None = Field(default=None, max_length=CONTENT_URL_MAX)
    notes: str | None = Field(default=None, max_length=CONTENT_NOTES_MAX)


def clean_url(raw: str | None) -> str | None:
    """A site path (`/learn/x`) or an https URL with a host; anything else → 422."""
    url = (raw or "").strip()
    if not url:
        return None
    bad = ApiError(
        422, "invalid_url", "Use a site path starting with / or an https:// link.", field="url"
    )
    if any(c.isspace() or ord(c) < 32 for c in url):
        raise bad
    if url.startswith("/"):
        if url.startswith("//") or url.startswith("/\\"):
            raise bad
        return url
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise bad from exc
    if parts.scheme != "https" or not parts.hostname:
        raise bad
    return url


def _clean_title(title: str) -> str:
    clean = title.strip()
    if not clean:
        raise ApiError(422, "invalid_value", "Title is required.", field="title")
    return clean


def _check_published(item: ContentItem) -> None:
    if item.status == "published" and not item.url:
        raise ApiError(422, "url_required", "A published item needs its URL.", field="url")


def content_view(c: ContentItem) -> dict[str, Any]:
    return {
        "id": c.id,
        "title": c.title,
        "kind": c.kind,
        "locale": c.locale,
        "status": c.status,
        "due_date": c.due_date,
        "url": c.url,
        "notes": c.notes,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


@router.get("/v1/admin/content-items")
async def list_content(
    admin: AdminUser,
    db: Db,
    from_: Annotated[dt.date | None, Query(alias="from")] = None,
    to: dt.date | None = None,
    status: ContentStatus | None = None,
    kind: ContentKind | None = None,
) -> dict[str, Any]:
    query = select(ContentItem).order_by(
        ContentItem.due_date.asc().nulls_last(), ContentItem.created_at, ContentItem.id
    )
    if from_ is not None:
        query = query.where(ContentItem.due_date >= from_)
    if to is not None:
        query = query.where(ContentItem.due_date <= to)
    if status is not None:
        query = query.where(ContentItem.status == status)
    if kind is not None:
        query = query.where(ContentItem.kind == kind)
    return {"items": [content_view(c) for c in (await db.execute(query)).scalars()]}


@router.post("/v1/admin/content-items", status_code=201)
async def create_content(body: ContentIn, admin: AdminUser, db: Db) -> dict[str, Any]:
    item = ContentItem(
        title=_clean_title(body.title),
        kind=body.kind,
        locale=body.locale,
        status=body.status,
        due_date=body.due_date,
        url=clean_url(body.url),
        notes=(body.notes or "").strip() or None,
        created_by=admin.id,
    )
    _check_published(item)
    db.add(item)
    await db.flush()
    audit(db, actor(admin), "content_item.create", "content_item", str(item.id), status=item.status)
    await db.commit()
    await db.refresh(item)
    return content_view(item)


async def _content(db: AsyncSession, item_id: uuid.UUID) -> ContentItem:
    item = (
        await db.execute(select(ContentItem).where(ContentItem.id == item_id).with_for_update())
    ).scalar_one_or_none()
    if item is None:
        raise ApiError(404, "not_found", "Content item not found.")
    return item


@router.patch("/v1/admin/content-items/{item_id}")
async def patch_content(
    item_id: uuid.UUID, body: ContentPatch, admin: AdminUser, db: Db
) -> dict[str, Any]:
    item = await _content(db, item_id)
    changes = body.model_dump(exclude_unset=True)
    for field in ("title", "kind", "locale", "status"):
        if field in changes and changes[field] is None:
            raise ApiError(422, "invalid_value", f"{field} cannot be empty.", field=field)
    if "title" in changes:
        item.title = _clean_title(changes["title"])
    for field in ("kind", "locale", "status", "due_date"):
        if field in changes:
            setattr(item, field, changes[field])
    if "url" in changes:
        item.url = clean_url(changes["url"])
    if "notes" in changes:
        item.notes = (changes["notes"] or "").strip() or None
    _check_published(item)
    if changes:
        item.updated_at = dt.datetime.now(dt.UTC)
        audit(
            db,
            actor(admin),
            "content_item.update",
            "content_item",
            str(item.id),
            fields=sorted(changes),
            status=item.status,
        )
    await db.commit()
    return content_view(item)


@router.delete("/v1/admin/content-items/{item_id}", status_code=204)
async def delete_content(item_id: uuid.UUID, admin: AdminUser, db: Db) -> Response:
    item = await _content(db, item_id)
    await db.delete(item)
    audit(db, actor(admin), "content_item.delete", "content_item", str(item_id))
    await db.commit()
    return Response(status_code=204)


# ================================================================ §4.2 almanac dates

# New Delhi, as in docs/api/growth.md §4.2 (labels say "tithi at sunrise, New Delhi").
ALMANAC_PLACE: dict[str, str | float] = {"lat": 28.6139, "lon": 77.209, "tz": "Asia/Kolkata"}
ALMANAC_CACHE_TTL_S = 7 * 24 * 3600
ALMANAC_CONCURRENCY = 8
ALMANAC_TITHIS = {15: "purnima", 30: "amavasya", 11: "ekadashi", 26: "ekadashi"}
ENGINE_TIMEOUT_S = 20.0
# Tests replace this with a transport serving the in-process engine (or a failing one).
ENGINE_TRANSPORT: httpx.AsyncBaseTransport | None = None


class EngineUnavailable(Exception):
    """The engine could not be reached or answered something unusable. Message: path/status."""


def engine_client(settings: Settings) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=settings.astro_url, timeout=ENGINE_TIMEOUT_S, transport=ENGINE_TRANSPORT
    )


async def _engine_get(
    http: httpx.AsyncClient, path: str, params: dict[str, Any] | None = None
) -> dict[str, Any]:
    try:
        r = await http.get(path, params=params)
    except httpx.HTTPError as exc:
        raise EngineUnavailable(f"{path}: {type(exc).__name__}") from exc
    if r.status_code != 200:
        raise EngineUnavailable(f"{path}: HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError as exc:
        raise EngineUnavailable(f"{path}: not JSON") from exc
    if not isinstance(data, dict):
        raise EngineUnavailable(f"{path}: not an object")
    return data


def day_facts(panchang: dict[str, Any]) -> dict[str, Any]:
    """The few engine values the almanac list needs, copied as returned."""
    try:
        tithi = panchang["tithi_at_sunrise"]
        sun = panchang["sun_at_sunrise"]
        return {
            "tithi_number": int(tithi["number"]),
            "tithi_id": str(tithi["id"]),
            "sun_sign_index": int(sun["sign_index"]),
            "sun_sign": str(sun["sign"]),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise EngineUnavailable("/v1/panchang: unexpected shape") from exc


def _cache_key(day: dt.date) -> str:
    return f"growth:almanac:new-delhi:{day.isoformat()}"


async def _facts_for(
    http: httpx.AsyncClient, redis: Redis, gate: asyncio.Semaphore, day: dt.date
) -> dict[str, Any]:
    cached = await redis.get(_cache_key(day))
    if cached is not None:
        data: dict[str, Any] = json.loads(cached)
        return data
    async with gate:
        panchang = await _engine_get(
            http, "/v1/panchang", {**ALMANAC_PLACE, "date": day.isoformat()}
        )
    facts = day_facts(panchang)
    await redis.set(_cache_key(day), json.dumps(facts), ex=ALMANAC_CACHE_TTL_S)
    return facts


def almanac_items(days: list[dt.date], facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`days[0]` is the day before the range (only for the sign comparison)."""
    items: list[dict[str, Any]] = []
    for i in range(1, len(days)):
        today, before = facts[i], facts[i - 1]
        kind = ALMANAC_TITHIS.get(today["tithi_number"])
        if kind is not None:
            items.append({"date": days[i], "kind": kind, "tithi": today["tithi_id"]})
        if today["sun_sign_index"] != before["sun_sign_index"]:
            items.append({"date": days[i], "kind": "sun_sign_change", "sign": today["sun_sign"]})
    return items


async def almanac_dates(
    settings: Settings, redis: Redis, start: dt.date, days: int
) -> list[dict[str, Any]]:
    span = [start + dt.timedelta(days=n) for n in range(-1, days)]
    gate = asyncio.Semaphore(ALMANAC_CONCURRENCY)
    async with engine_client(settings) as http:
        facts = await asyncio.gather(*(_facts_for(http, redis, gate, d) for d in span))
    return almanac_items(span, list(facts))


@router.get("/v1/admin/growth/almanac-dates")
async def get_almanac_dates(
    admin: AdminUser,
    request: Request,
    days: Annotated[int, Query(ge=7, le=120)] = 60,
) -> dict[str, Any]:
    try:
        items = await almanac_dates(settings_of(request), redis_of(request), ist_today(), days)
    except EngineUnavailable as exc:
        raise ApiError(
            503, "engine_unavailable", "Almanac dates cannot be computed right now."
        ) from exc
    return {"items": items}


# ================================================================ §5 launch readiness

READINESS_CHECKS = (
    "legal_approved",
    "helplines_verified",
    "jyotish_tables_reviewed",
    "supply_live",
    "supply_languages",
    "horoscopes_today",
    "payments_live",
    "sms_live",
    "email_live",
    "document_storage",
    "reconciliation_recent",
    "jobs_healthy",
    "analytics_flowing",
    "voice_ready",
    "ai_ready",
)
Status = Literal["pass", "warn", "fail"]
RECONCILIATION_MAX_AGE = dt.timedelta(hours=36)
JOBS_WINDOW = dt.timedelta(hours=24)
ANALYTICS_WINDOW = dt.timedelta(hours=24)


def _check(check_id: str, status: Status, detail: str) -> dict[str, str]:
    assert check_id in READINESS_CHECKS
    return {"id": check_id, "status": status, "detail": detail}


class LlmKeys(BaseSettings):
    """The LLM settings the worker uses (LLM_PROVIDER and its key), read from the API's own
    environment. Only presence is checked; values are never returned."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    llm_provider: str = "gemini"
    gemini_api_key: SecretStr | None = None
    anthropic_api_key: SecretStr | None = None

    def configured(self) -> bool:
        key = {"gemini": self.gemini_api_key, "anthropic": self.anthropic_api_key}.get(
            self.llm_provider
        )
        return key is not None and bool(key.get_secret_value().strip())


def legal_check(approved: str, current: str) -> dict[str, str]:
    if approved and approved == current:
        return _check("legal_approved", "pass", f"Policies version {current} is approved.")
    if not approved:
        return _check(
            "legal_approved", "fail", f"LEGAL_APPROVED_VERSION is not set (policies: {current})."
        )
    return _check(
        "legal_approved",
        "fail",
        f"Approved version {approved} differs from policies version {current}.",
    )


def helplines_check(data: dict[str, Any]) -> dict[str, str]:
    lines = data.get("helplines") or []
    default = data.get("verified_by_founder") is True
    pending = [str(h.get("id")) for h in lines if h.get("verified_by_founder", default) is not True]
    if not lines:
        return _check("helplines_verified", "fail", "No helplines in helplines.json.")
    if pending:
        return _check(
            "helplines_verified",
            "fail",
            "Not verified by the founder: " + ", ".join(pending) + ".",
        )
    return _check("helplines_verified", "pass", f"All {len(lines)} helplines verified.")


def tables_check(meta: dict[str, Any] | None) -> dict[str, str]:
    if meta is None:
        return _check("jyotish_tables_reviewed", "warn", "The astro engine is unreachable.")
    statuses = meta.get("tables_review_status") or {}
    if not isinstance(statuses, dict) or not statuses:
        return _check("jyotish_tables_reviewed", "fail", "The engine reports no table status.")
    pending = sorted(str(k) for k, v in statuses.items() if v != "verified")
    if pending:
        return _check(
            "jyotish_tables_reviewed", "fail", "Awaiting astrologer review: " + ", ".join(pending)
        )
    return _check("jyotish_tables_reviewed", "pass", "All Jyotish tables reviewed.")


def supply_live_check(live: int, minimum: int) -> dict[str, str]:
    detail = f"{live} live astrologers (target at least {minimum})."
    if live >= minimum:
        return _check("supply_live", "pass", detail)
    return _check("supply_live", "warn" if live > 0 else "fail", detail)


def supply_languages_check(rows: list[dict[str, Any]]) -> dict[str, str]:
    short = [
        f"{r['id']} {r['live']}/{r['target_min']}" for r in rows if r["live"] < r["target_min"]
    ]
    if short:
        return _check("supply_languages", "fail", "Below target: " + ", ".join(short) + ".")
    return _check("supply_languages", "pass", "Every target language meets its minimum.")


def horoscopes_check(published: set[tuple[str, str]], locales: tuple[str, ...]) -> dict[str, str]:
    parts = []
    complete = True
    for locale in locales:
        n = sum(1 for s in SIGNS if (s, locale) in published)
        complete = complete and n == len(SIGNS)
        parts.append(f"{locale} {n}/{len(SIGNS)}")
    detail = "Published daily horoscopes today: " + ", ".join(parts) + "."
    return _check("horoscopes_today", "pass" if complete else "fail", detail)


def payments_check(settings: Settings) -> dict[str, str]:
    if settings.payments_provider != "razorpay":
        return _check(
            "payments_live", "fail", f"Payments provider is {settings.payments_provider}."
        )
    if not (
        settings.razorpay_key_id
        and settings.razorpay_key_secret.get_secret_value()
        and settings.razorpay_webhook_secret.get_secret_value()
    ):
        return _check("payments_live", "fail", "Razorpay is selected but its keys are missing.")
    return _check("payments_live", "pass", "Payments provider is razorpay.")


def sms_check(settings: Settings) -> dict[str, str]:
    ok = settings.sms_provider != "console"
    return _check("sms_live", "pass" if ok else "fail", f"SMS provider is {settings.sms_provider}.")


def email_check(settings: Settings) -> dict[str, str]:
    ok = settings.email_provider != "console"
    detail = f"Email provider is {settings.email_provider}."
    return _check("email_live", "pass" if ok else "fail", detail)


def storage_check(settings: Settings) -> dict[str, str]:
    ok = settings.documents_backend == "s3"
    detail = f"KYC document storage is {settings.documents_backend}."
    return _check("document_storage", "pass" if ok else "fail", detail)


def reconciliation_check(
    run: tuple[str, int, dt.datetime] | None, now: dt.datetime
) -> dict[str, str]:
    """`run` is the latest finished run: (status, drift_paise, started_at)."""
    if run is None or now - run[2] > RECONCILIATION_MAX_AGE:
        return _check("reconciliation_recent", "fail", "No reconciliation run in the last 36 h.")
    status, drift, started = run
    when = started.astimezone(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")
    if status == "ok" and drift == 0:
        return _check("reconciliation_recent", "pass", f"Last run {when}: no drift.")
    return _check(
        "reconciliation_recent", "fail", f"Last run {when}: {status}, drift {drift} paise."
    )


def jobs_check(failed: int) -> dict[str, str]:
    if failed == 0:
        return _check("jobs_healthy", "pass", "No failed jobs in the last 24 h.")
    return _check("jobs_healthy", "warn", f"{failed} failed jobs in the last 24 h.")


def analytics_check(count: int | None) -> dict[str, str]:
    if count is None:
        return _check("analytics_flowing", "warn", "The analytics table is not available yet.")
    if count == 0:
        return _check("analytics_flowing", "warn", "No analytics events in the last 24 h.")
    return _check("analytics_flowing", "pass", "Analytics events received in the last 24 h.")


def voice_check(flag_on: bool, settings: Settings) -> dict[str, str]:
    if not flag_on:
        return _check("voice_ready", "pass", "Voice calls are off (flag voice_calls).")
    configured = (
        bool(settings.livekit_api_key)
        and len(settings.livekit_api_secret.get_secret_value()) >= 32
        and settings.livekit_public_url.startswith("wss://")
    )
    if configured:
        return _check("voice_ready", "pass", "Voice calls are on and LiveKit is configured.")
    return _check(
        "voice_ready",
        "fail",
        "Voice calls are on but LiveKit needs an API key, a secret of 32+ characters and a "
        "wss:// public URL.",
    )


def ai_check(flag_on: bool, llm: LlmKeys) -> dict[str, str]:
    if not flag_on:
        return _check("ai_ready", "pass", "The AI assistant is off (flag ai_assistant).")
    if llm.configured():
        return _check("ai_ready", "pass", f"The AI assistant is on; {llm.llm_provider} key set.")
    return _check(
        "ai_ready",
        "fail",
        f"The AI assistant is on but no key is set for LLM_PROVIDER={llm.llm_provider}.",
    )


async def _engine_meta(settings: Settings) -> dict[str, Any] | None:
    try:
        async with engine_client(settings) as http:
            return await _engine_get(http, "/v1/meta")
    except EngineUnavailable:
        return None


async def _analytics_count(db: AsyncSession, since: dt.datetime) -> int | None:
    """Events received since `since`, or None while the table does not exist (migration 0014)."""
    exists = (
        await db.execute(text("SELECT to_regclass('public.analytics_events') IS NOT NULL"))
    ).scalar_one()
    if not exists:
        return None
    try:
        async with db.begin_nested():
            n = (
                await db.execute(
                    text(
                        "SELECT count(*) FROM (SELECT 1 FROM analytics_events "
                        "WHERE received_at >= :since LIMIT 1000) recent"
                    ),
                    {"since": since},
                )
            ).scalar_one()
    except DBAPIError:
        return None
    return int(n)


async def launch_readiness(db: AsyncSession, settings: Settings) -> dict[str, Any]:
    now = dt.datetime.now(dt.UTC)
    today = ist_today()
    meta = await _engine_meta(settings)
    supply = await supply_readiness(db, settings)
    helplines = json.loads((safety_dir() / "helplines.json").read_text("utf-8"))
    locales = ("en", "hi") if flag_enabled("hindi_locale") else ("en",)
    published = {
        (str(s), str(loc))
        for s, loc in (
            await db.execute(
                select(HoroscopeEntry.sign, HoroscopeEntry.locale).where(
                    HoroscopeEntry.period == "daily",
                    HoroscopeEntry.ist_date == today,
                    HoroscopeEntry.status == "published",
                )
            )
        ).all()
    }
    run_row = (
        await db.execute(
            select(
                ReconciliationRun.status,
                ReconciliationRun.drift_paise,
                ReconciliationRun.started_at,
            )
            .where(
                ReconciliationRun.status != "running",
                ReconciliationRun.started_at >= now - RECONCILIATION_MAX_AGE,
            )
            .order_by(ReconciliationRun.started_at.desc())
            .limit(1)
        )
    ).first()
    run = (str(run_row[0]), int(run_row[1]), run_row[2]) if run_row else None
    failed_jobs = (
        await db.execute(
            select(func.count()).where(
                and_(
                    Job.status == "failed",
                    func.coalesce(Job.finished_at, Job.created_at) >= now - JOBS_WINDOW,
                )
            )
        )
    ).scalar_one()
    analytics = await _analytics_count(db, now - ANALYTICS_WINDOW)
    checks = [
        legal_check(settings.legal_approved_version, legal_version()),
        helplines_check(helplines),
        tables_check(meta),
        supply_live_check(supply["live"], supply["target"]["min"]),
        supply_languages_check(supply["languages"]),
        horoscopes_check(published, locales),
        payments_check(settings),
        sms_check(settings),
        email_check(settings),
        storage_check(settings),
        reconciliation_check(run, now),
        jobs_check(int(failed_jobs)),
        analytics_check(analytics),
        voice_check(flag_enabled("voice_calls"), settings),
        ai_check(flag_enabled("ai_assistant"), LlmKeys()),
    ]
    assert [c["id"] for c in checks] == list(READINESS_CHECKS)
    return {"generated_at": now, "checks": checks}


@router.get("/v1/admin/launch-readiness")
async def get_launch_readiness(admin: AdminUser, db: Db, request: Request) -> dict[str, Any]:
    return await launch_readiness(db, settings_of(request))
