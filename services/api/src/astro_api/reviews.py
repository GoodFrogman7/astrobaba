"""Reviews: only after a completed session, one per session; astrologer replies once; anyone
signed in can report. Text that fails automatic moderation is held for a moderator."""

import datetime as dt
import uuid
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import refunds
from astro_api.audit import audit
from astro_api.auth import CurrentUser
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.logs import redact
from astro_api.marketplace import is_public
from astro_api.models import Astrologer, ConsultSession, Review
from astro_api.moderation import moderation_reasons
from astro_api.roles import actor
from astro_api.taxonomy import taxonomy

router = APIRouter(prefix="/v1", tags=["reviews"])

REPORT_DEDUPE_S = 365 * 24 * 3600


def _max_chars() -> int:
    return int(taxonomy()["review"]["max_text_chars"])


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    text: str = Field(default="", max_length=5000)


class ReplyIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class ReportIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


def own_review_view(r: Review) -> dict[str, Any]:
    return {
        "id": r.id,
        "session_id": r.session_id,
        "rating": r.rating,
        "text": r.text,
        "status": "pending_moderation" if r.auto_flag_reason else r.status,
        "created_at": r.created_at,
    }


@router.post("/consult-sessions/{session_id}/review", status_code=201)
async def create_review(
    session_id: uuid.UUID, body: ReviewIn, user: CurrentUser, db: Db
) -> dict[str, Any]:
    text = body.text.strip()
    if len(text) > _max_chars():
        raise ApiError(422, "text_too_long", f"Reviews are limited to {_max_chars()} characters.")
    session = (
        await db.execute(
            select(ConsultSession).where(ConsultSession.id == session_id).with_for_update()
        )
    ).scalar_one_or_none()
    if session is None or session.user_id != user.id:
        raise ApiError(404, "not_found", "Session not found.")
    if session.status != "completed":
        raise ApiError(409, "session_not_completed", "You can review a session once it ends.")
    exists = (
        await db.execute(select(Review.id).where(Review.session_id == session_id))
    ).scalar_one_or_none()
    if exists is not None:
        raise ApiError(409, "already_reviewed", "You have already reviewed this session.")
    reasons = moderation_reasons(text)
    review = Review(
        session_id=session.id,
        astrologer_id=session.astrologer_id,
        user_id=user.id,
        rating=body.rating,
        text=text,
        status="flagged" if reasons else "published",
        auto_flag_reason="; ".join(reasons) or None,
    )
    db.add(review)
    await db.flush()
    audit(db, actor(user), "review.create", "review", str(review.id), held=bool(reasons))
    # Low-rating refund rule (billing.json), in the same transaction as the review.
    await refunds.on_review(
        db, session_id=session.id, rating=body.rating, at=dt.datetime.now(dt.UTC)
    )
    await db.commit()
    return own_review_view(review)


async def review_for_update(db: AsyncSession, review_id: uuid.UUID) -> Review:
    r = (
        await db.execute(select(Review).where(Review.id == review_id).with_for_update())
    ).scalar_one_or_none()
    if r is None:
        raise ApiError(404, "not_found", "Review not found.")
    return r


@router.post("/reviews/{review_id}/reply")
async def reply(
    review_id: uuid.UUID, body: ReplyIn, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    settings = settings_of(request)
    r = await review_for_update(db, review_id)
    a = await db.get(Astrologer, r.astrologer_id)
    if a is None or a.user_id != user.id or not is_public(a, settings):
        raise ApiError(404, "not_found", "Review not found.")
    if r.status == "hidden" or r.auto_flag_reason:
        raise ApiError(404, "not_found", "Review not found.")
    if r.reply_text:
        raise ApiError(409, "already_replied", "You have already replied to this review.")
    text = body.text.strip()
    if len(text) > _max_chars():
        raise ApiError(422, "text_too_long", f"Replies are limited to {_max_chars()} characters.")
    reasons = moderation_reasons(text)
    if reasons:
        raise ApiError(
            422,
            "reply_not_allowed",
            "Replies cannot contain contact details, abuse or outcome claims.",
            reasons=reasons,
        )
    r.reply_text = text
    r.reply_at = dt.datetime.now(dt.UTC)
    audit(db, actor(user), "review.reply", "review", str(r.id))
    await db.commit()
    return {"id": r.id, "reply": {"text": r.reply_text, "at": r.reply_at}}


@router.post("/reviews/{review_id}/report", status_code=202)
async def report(
    review_id: uuid.UUID, body: ReportIn, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    settings = settings_of(request)
    redis = redis_of(request)
    r = await review_for_update(db, review_id)
    a = await db.get(Astrologer, r.astrologer_id)
    visible = r.status == "published" or (r.status == "flagged" and r.auto_flag_reason is None)
    if a is None or not is_public(a, settings) or not visible:
        raise ApiError(404, "not_found", "Review not found.")
    # One report per user per review counts; repeats are accepted but ignored.
    first = await redis.set(f"review_report:{r.id}:{user.id}", "1", nx=True, ex=REPORT_DEDUPE_S)
    if first:
        r.report_count += 1
        r.status = "flagged"
        audit(
            db, actor(user), "review.report", "review", str(r.id), reason=redact(body.reason)[:200]
        )
        await db.commit()
    return {"id": r.id, "reported": True}
