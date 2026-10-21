"""Public marketplace reads: taxonomy, directory, profiles, reviews.

Every public read goes through `public_condition` / `is_public` (docs/api/marketplace.md,
"Visibility rule"): only `probation` and `approved` astrologers whose `show_in_directory` flag is
on, and never seed rows in staging/production. Anything else is a 404.
"""

import base64
import binascii
import datetime as dt
import json
import math
import uuid
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from redis.asyncio import Redis
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.config import Settings
from astro_api.db import get_db
from astro_api.errors import ApiError
from astro_api.models import PUBLIC_STATUSES, Astrologer, Review
from astro_api.taxonomy import ids, taxonomy

router = APIRouter(prefix="/v1", tags=["marketplace"])

Sort = Literal["recommended", "price_asc", "price_desc", "experience", "rating"]
PRESENCE_TTL_S = 120
# Bayesian rating used for ordering: (PRIOR_WEIGHT * PRIOR_MEAN + sum) / (PRIOR_WEIGHT + count).
PRIOR_MEAN = 4.0
PRIOR_WEIGHT = 5
PRESENCE_RANK = {"online": 0, "busy": 1, "offline": 2}


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _redis(request: Request) -> Redis:
    redis: Redis = request.app.state.redis
    return redis


# ---------------------------------------------------------------- visibility (the only rule)


def public_condition(settings: Settings) -> ColumnElement[bool]:
    conditions: list[ColumnElement[bool]] = [
        Astrologer.status.in_(PUBLIC_STATUSES),
        Astrologer.flags["show_in_directory"].as_boolean().is_(True),
    ]
    if settings.is_production:
        conditions.append(Astrologer.is_seed.is_(False))
    return and_(*conditions)


def is_public(a: Astrologer, settings: Settings) -> bool:
    return (
        a.status in PUBLIC_STATUSES
        and (a.flags or {}).get("show_in_directory") is True
        and not (settings.is_production and a.is_seed)
    )


def review_visible() -> ColumnElement[bool]:
    """Published reviews, and reported ones until a moderator acts. Reviews held by automatic
    moderation (auto_flag_reason set) and hidden ones are never public."""
    return or_(
        Review.status == "published",
        and_(Review.status == "flagged", Review.auto_flag_reason.is_(None)),
    )


async def public_by_slug(db: AsyncSession, settings: Settings, slug: str) -> Astrologer:
    a = (
        await db.execute(
            select(Astrologer).where(Astrologer.slug == slug, public_condition(settings))
        )
    ).scalar_one_or_none()
    if a is None:
        raise ApiError(404, "not_found", "Astrologer not found.")
    return a


# ---------------------------------------------------------------- presence (Redis)


def presence_key(astrologer_id: uuid.UUID) -> str:
    return f"presence:{astrologer_id}"


def busy_until_key(astrologer_id: uuid.UUID) -> str:
    return f"busy_until:{astrologer_id}"


def _s(v: bytes | str | None) -> str | None:
    return v.decode() if isinstance(v, bytes) else v


async def presence_of(
    redis: Redis, astrologer_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[str, int | None]]:
    """(presence, wait_minutes) per astrologer. wait_minutes is only known when busy with a
    recorded end time; it is never estimated or invented."""
    if not astrologer_ids:
        return {}
    keys = [presence_key(i) for i in astrologer_ids] + [busy_until_key(i) for i in astrologer_ids]
    values = await redis.mget(keys)
    n = len(astrologer_ids)
    now = dt.datetime.now(dt.UTC).timestamp()
    out: dict[uuid.UUID, tuple[str, int | None]] = {}
    for i, aid in enumerate(astrologer_ids):
        state = _s(values[i])
        presence = state if state in ("online", "busy") else "offline"
        wait = None
        until = _s(values[n + i])
        if presence == "busy" and until:
            try:
                wait = max(1, math.ceil((float(until) - now) / 60))
            except ValueError:
                wait = None
        out[aid] = (presence, wait)
    return out


# ---------------------------------------------------------------- ratings and serialisation


@dataclass(frozen=True)
class Rating:
    count: int = 0
    total: int = 0

    @property
    def average(self) -> float | None:
        return round(self.total / self.count, 2) if self.count else None

    @property
    def bayesian(self) -> float:
        return (PRIOR_WEIGHT * PRIOR_MEAN + self.total) / (PRIOR_WEIGHT + self.count)

    def as_dict(self) -> dict[str, Any]:
        return {"average": self.average, "count": self.count}


async def ratings_of(db: AsyncSession, astrologer_ids: list[uuid.UUID]) -> dict[uuid.UUID, Rating]:
    if not astrologer_ids:
        return {}
    rows = await db.execute(
        select(Review.astrologer_id, func.count(), func.coalesce(func.sum(Review.rating), 0))
        .where(Review.astrologer_id.in_(astrologer_ids), review_visible())
        .group_by(Review.astrologer_id)
    )
    return {aid: Rating(int(c), int(t)) for aid, c, t in rows.all()}


def card(
    a: Astrologer, settings: Settings, rating: Rating, presence: tuple[str, int | None]
) -> dict[str, Any]:
    return {
        "id": a.id,
        "slug": a.slug,
        "display_name": a.display_name,
        "photo_url": None,
        "skills": a.skills,
        "languages": a.languages,
        "gender": a.gender,
        "tier": a.tier,
        "price_per_min_paise": a.price_per_min_paise,
        "experience_years": a.experience_years,
        "rating": rating.as_dict(),
        "presence": presence[0],
        "wait_minutes": presence[1],
        "is_demo": a.is_seed,
    }


def profile(
    a: Astrologer, settings: Settings, rating: Rating, presence: tuple[str, int | None]
) -> dict[str, Any]:
    since = a.approved_at or a.created_at
    return {
        **card(a, settings, rating, presence),
        "bio": a.bio,
        "bio_hi": a.bio_hi,
        "verified": {"identity": True, "qualification": True, "interview": True},
        "on_platform_since": since.strftime("%Y-%m"),
        "consult": {
            "chat_enabled": bool((a.flags or {}).get("chat_enabled")),
            "call_enabled": bool((a.flags or {}).get("call_enabled")),
        },
    }


# ---------------------------------------------------------------- cursors


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        offset = int(json.loads(base64.urlsafe_b64decode(padded))["o"])
    except (binascii.Error, ValueError, KeyError, TypeError) as exc:
        raise ApiError(422, "invalid_cursor", "Cursor is not valid.") from exc
    if offset < 0:
        raise ApiError(422, "invalid_cursor", "Cursor is not valid.")
    return offset


# ---------------------------------------------------------------- endpoints


@router.get("/taxonomy")
async def get_taxonomy() -> dict[str, Any]:
    return taxonomy()


def _check_filter(kind: str, values: list[str]) -> None:
    bad = [v for v in values if v not in ids(kind)]
    if bad:
        raise ApiError(422, "invalid_filter", f"Unknown {kind}: {', '.join(bad)}", invalid=bad)


def sort_key(sort: Sort) -> Any:
    """Sort keys over (astrologer, rating, presence). Every key ends with the id as tie-break."""

    def key(item: tuple[Astrologer, Rating, tuple[str, int | None]]) -> tuple[Any, ...]:
        a, r, p = item
        price = a.price_per_min_paise or 0
        tail = str(a.id)
        if sort == "price_asc":
            return (price, tail)
        if sort == "price_desc":
            return (-price, tail)
        if sort == "experience":
            return (-a.experience_years, tail)
        if sort == "rating":
            return (-r.bayesian, -r.count, tail)
        return (PRESENCE_RANK[p[0]], -r.bayesian, -a.experience_years, tail)

    return key


@router.get("/astrologers")
async def list_astrologers(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    skill: Annotated[list[str] | None, Query()] = None,
    language: Annotated[list[str] | None, Query()] = None,
    gender: str | None = None,
    tier: str | None = None,
    min_price: Annotated[int | None, Query(ge=0)] = None,
    max_price: Annotated[int | None, Query(ge=0)] = None,
    online: bool = False,
    sort: Sort = "recommended",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    settings = _settings(request)
    skills, languages = skill or [], language or []
    _check_filter("skills", skills)
    _check_filter("languages", languages)
    if gender:
        _check_filter("genders", [gender])
    if tier:
        _check_filter("tiers", [tier])
    if min_price is not None and max_price is not None and min_price > max_price:
        raise ApiError(422, "invalid_filter", "min_price is above max_price.")
    offset = decode_cursor(cursor)

    query = select(Astrologer).where(public_condition(settings))
    if skills:
        query = query.where(Astrologer.skills.overlap(skills))
    if languages:
        query = query.where(Astrologer.languages.overlap(languages))
    if gender:
        query = query.where(Astrologer.gender == gender)
    if tier:
        query = query.where(Astrologer.tier == tier)
    if min_price is not None:
        query = query.where(Astrologer.price_per_min_paise >= min_price)
    if max_price is not None:
        query = query.where(Astrologer.price_per_min_paise <= max_price)
    rows = list((await db.execute(query)).scalars())

    # Presence lives in Redis and drives the default order, so ordering and the online filter
    # happen here. The public set is small (vetted supply, PLAN.md §1); revisit past ~10k rows.
    aids = [a.id for a in rows]
    ratings = await ratings_of(db, aids)
    presence = await presence_of(_redis(request), aids)
    items = [(a, ratings.get(a.id, Rating()), presence[a.id]) for a in rows]
    if online:
        items = [i for i in items if i[2][0] == "online"]
    items.sort(key=sort_key(sort))
    page = items[offset : offset + limit]
    next_offset = offset + limit
    return {
        "items": [card(a, settings, r, p) for a, r, p in page],
        "next_cursor": encode_cursor(next_offset) if next_offset < len(items) else None,
        "total": len(items),
    }


@router.get("/astrologers/slugs")
async def slugs(
    request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> list[dict[str, Any]]:
    rows = await db.execute(
        select(Astrologer.slug, Astrologer.updated_at)
        .where(public_condition(_settings(request)))
        .order_by(Astrologer.slug)
    )
    return [{"slug": s, "updated_at": u} for s, u in rows.all()]


@router.get("/astrologers/{slug}")
async def get_profile(
    slug: str, request: Request, db: Annotated[AsyncSession, Depends(get_db)]
) -> dict[str, Any]:
    settings = _settings(request)
    a = await public_by_slug(db, settings, slug)
    rating = (await ratings_of(db, [a.id])).get(a.id, Rating())
    presence = (await presence_of(_redis(request), [a.id]))[a.id]
    return profile(a, settings, rating, presence)


def public_review(r: Review) -> dict[str, Any]:
    return {
        "id": r.id,
        "rating": r.rating,
        "text": r.text,
        "created_at": r.created_at,
        # Never the reviewer's name or phone.
        "author_label": "Verified client",
        "reply": {"text": r.reply_text, "at": r.reply_at} if r.reply_text else None,
    }


@router.get("/astrologers/{slug}/reviews")
async def list_reviews(
    slug: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    a = await public_by_slug(db, _settings(request), slug)
    offset = decode_cursor(cursor)
    base = select(Review).where(Review.astrologer_id == a.id, review_visible())
    rows = list(
        (
            await db.execute(
                base.order_by(Review.created_at.desc(), Review.id).offset(offset).limit(limit + 1)
            )
        ).scalars()
    )
    rating = (await ratings_of(db, [a.id])).get(a.id, Rating())
    return {
        "items": [public_review(r) for r in rows[:limit]],
        "next_cursor": encode_cursor(offset + limit) if len(rows) > limit else None,
        "rating": rating.as_dict(),
    }
