"""Astrologer portal: availability, consult settings, earnings, reviews, payout statements
(docs/api/portal.md §2).

Every endpoint is for the signed-in user's own astrologer record (`404 not_applied` otherwise).
Money figures come from the ledger (astro_api.earnings, astro_api.payouts). The client is shown
only as `client_label`; held review text is withheld (it may hold contact details).
"""

import datetime as dt
import re
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, StrictBool
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import earnings, payouts, wallet
from astro_api.applicant import own_astrologer
from astro_api.audit import audit
from astro_api.auth import CurrentUser
from astro_api.db import Db, settings_of
from astro_api.errors import ApiError
from astro_api.flags import flag_enabled
from astro_api.marketplace import decode_cursor, encode_cursor
from astro_api.models import Astrologer, Review
from astro_api.models_portal import (
    MAX_SLOTS,
    SLOT_STEP_MINUTES,
    AstrologerAvailability,
    Payout,
    availability_view,
)
from astro_api.roles import actor

router = APIRouter(prefix="/v1/astrologer/me", tags=["portal"])
Limit = Annotated[int, Query(ge=1, le=50)]

_HHMM = re.compile(r"^(\d{2}):(\d{2})$")


# ---------------------------------------------------------------- availability


class AvailabilityIn(BaseModel):
    # Items are checked by hand so a bad slot is reported with its index.
    slots: list[Any]


def _invalid(index: int, message: str) -> ApiError:
    return ApiError(422, "invalid_slots", message, index=index)


def _minute_of(value: Any, index: int, *, field: str) -> int:
    m = _HHMM.match(value) if isinstance(value, str) else None
    if m is None:
        raise _invalid(index, f"Slot {index}: {field} must be HH:MM.")
    hours, minutes = int(m.group(1)), int(m.group(2))
    total = hours * 60 + minutes
    if minutes > 59 or total > 24 * 60:
        raise _invalid(index, f"Slot {index}: {field} is not a time of day.")
    if total % SLOT_STEP_MINUTES:
        raise _invalid(index, f"Slot {index}: times must be in {SLOT_STEP_MINUTES}-minute steps.")
    return total


def parse_slots(raw: list[Any]) -> list[tuple[int, int, int]]:
    """(weekday, start minute, end minute) per slot; 422 invalid_slots with the first bad index."""
    if len(raw) > MAX_SLOTS:
        raise _invalid(MAX_SLOTS, f"At most {MAX_SLOTS} slots.")
    out: list[tuple[int, int, int]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict) or set(item) != {"weekday", "start", "end"}:
            raise _invalid(i, f"Slot {i}: needs weekday, start and end.")
        weekday = item["weekday"]
        if isinstance(weekday, bool) or not isinstance(weekday, int) or not 0 <= weekday <= 6:
            raise _invalid(i, f"Slot {i}: weekday must be 0 (Monday) to 6 (Sunday).")
        start = _minute_of(item["start"], i, field="start")
        end = _minute_of(item["end"], i, field="end")
        if start >= end:
            raise _invalid(i, f"Slot {i}: start must be before end.")
        for other_day, other_start, other_end in out:
            if other_day == weekday and start < other_end and other_start < end:
                raise _invalid(i, f"Slot {i} overlaps another slot on the same day.")
        out.append((weekday, start, end))
    return out


@router.get("/availability")
async def get_availability(user: CurrentUser, db: Db) -> dict[str, Any]:
    a = await own_astrologer(db, user)
    return await availability_view(db, a.id)


@router.put("/availability")
async def put_availability(body: AvailabilityIn, user: CurrentUser, db: Db) -> dict[str, Any]:
    a = await own_astrologer(db, user, lock=True)
    slots = parse_slots(body.slots)
    await db.execute(
        delete(AstrologerAvailability).where(AstrologerAvailability.astrologer_id == a.id)
    )
    if slots:
        await db.execute(
            insert(AstrologerAvailability),
            [
                {"astrologer_id": a.id, "weekday": w, "start_minute": s, "end_minute": e}
                for w, s, e in slots
            ],
        )
    audit(db, actor(user), "astrologer.availability", "astrologer", str(a.id), slots=len(slots))
    await db.commit()
    return await availability_view(db, a.id)


# ---------------------------------------------------------------- consultation settings


class ConsultIn(BaseModel):
    chat_enabled: StrictBool | None = None
    call_enabled: StrictBool | None = None


def consult_view(a: Astrologer) -> dict[str, bool]:
    flags = a.flags or {}
    return {
        "chat_enabled": bool(flags.get("chat_enabled")),
        "call_enabled": bool(flags.get("call_enabled")),
        "voice_calls_available": flag_enabled("voice_calls"),
    }


@router.get("/consult")
async def get_consult(user: CurrentUser, db: Db) -> dict[str, bool]:
    return consult_view(await own_astrologer(db, user))


@router.patch("/consult")
async def patch_consult(body: ConsultIn, user: CurrentUser, db: Db) -> dict[str, bool]:
    a = await own_astrologer(db, user, lock=True)
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if changes.get("call_enabled") and not flag_enabled("voice_calls"):
        raise ApiError(409, "call_unavailable", "Voice calls are not available yet.")
    if changes:
        a.flags = {**(a.flags or {}), **changes}  # a new dict, so the JSONB change is saved
        audit(db, actor(user), "astrologer.consult", "astrologer", str(a.id), **changes)
        await db.commit()
    return consult_view(a)


# ---------------------------------------------------------------- earnings and balance


def _date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ApiError(422, "invalid_range", "Dates must be YYYY-MM-DD.") from exc


@router.get("/earnings")
async def get_earnings(
    request: Request,
    user: CurrentUser,
    db: Db,
    from_: Annotated[str | None, Query(alias="from")] = None,
    to: str | None = None,
    cursor: str | None = None,
    limit: Limit = 20,
) -> dict[str, Any]:
    a = await own_astrologer(db, user)
    if from_ is None and to is None:
        first, last = earnings.period_dates(earnings.period_of(earnings.ist_today()))
    elif from_ is None or to is None:
        raise ApiError(422, "invalid_range", "Give both from and to, or neither.")
    else:
        first, last = _date(from_), _date(to)
    if first > last:
        raise ApiError(422, "invalid_range", "from must not be after to.")
    if (last - first).days + 1 > earnings.MAX_RANGE_DAYS:
        raise ApiError(
            422,
            "invalid_range",
            f"At most {earnings.MAX_RANGE_DAYS} days.",
            max_days=earnings.MAX_RANGE_DAYS,
        )
    offset = decode_cursor(cursor)
    start, end = earnings.range_bounds(first, last)
    lines = await earnings.session_lines(db, a.id, start, end, offset=offset, limit=limit + 1)
    settings = settings_of(request)
    return {
        "from": first.isoformat(),
        "to": last.isoformat(),
        "totals": (await earnings.totals(db, a.id, start, end)).as_dict(),
        "by_day": await earnings.by_day(db, a.id, first, last),
        "sessions": {
            "items": [payouts.earning_row(line, settings) for line in lines[:limit]],
            "next_cursor": encode_cursor(offset + limit) if len(lines) > limit else None,
        },
    }


@router.get("/balance")
async def get_balance(user: CurrentUser, db: Db) -> dict[str, Any]:
    a = await own_astrologer(db, user)
    last = (
        await db.execute(
            select(Payout)
            .where(Payout.astrologer_id == a.id, Payout.status == "paid")
            .order_by(Payout.paid_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return {
        "payable_paise": await wallet.account_balance(db, wallet.payable_account(a.id)),
        "last_payout": (
            {
                "period": last.period,
                "net_paise": last.net_paise,
                "paid_at": payouts.payout_view(last)["paid_at"],
            }
            if last
            else None
        ),
    }


# ---------------------------------------------------------------- reviews


def own_review(r: Review) -> dict[str, Any]:
    held = r.status == "flagged" and r.auto_flag_reason is not None
    return {
        "id": str(r.id),
        "session_id": str(r.session_id),
        "rating": r.rating,
        "text": None if held else r.text,
        "created_at": r.created_at,
        "author_label": "Verified client",
        "reply": {"text": r.reply_text, "at": r.reply_at} if r.reply_text else None,
        "status": "held" if held else "published",
    }


@router.get("/reviews")
async def get_reviews(
    user: CurrentUser,
    db: Db,
    cursor: str | None = None,
    limit: Limit = 20,
    filter: Literal["all", "unreplied"] = "all",
) -> dict[str, Any]:
    a = await own_astrologer(db, user)
    offset = decode_cursor(cursor)
    query = select(Review).where(Review.astrologer_id == a.id, Review.status != "hidden")
    if filter == "unreplied":
        query = query.where(Review.reply_text.is_(None))
    rows = list(
        (
            await db.execute(
                query.order_by(Review.created_at.desc(), Review.id).offset(offset).limit(limit + 1)
            )
        ).scalars()
    )
    return {
        "items": [own_review(r) for r in rows[:limit]],
        "next_cursor": encode_cursor(offset + limit) if len(rows) > limit else None,
    }


# ---------------------------------------------------------------- payout statements


async def _own_payout(db: AsyncSession, a: Astrologer, payout_id: uuid.UUID) -> Payout:
    p = await db.get(Payout, payout_id)
    if p is None or p.astrologer_id != a.id:
        raise ApiError(404, "not_found", "Payout not found.")
    return p


@router.get("/payouts")
async def list_payouts(user: CurrentUser, db: Db) -> dict[str, Any]:
    a = await own_astrologer(db, user)
    rows = (
        await db.execute(
            select(Payout).where(Payout.astrologer_id == a.id).order_by(Payout.period.desc())
        )
    ).scalars()
    return {"items": [payouts.payout_view(p) for p in rows]}


@router.get("/payouts/{payout_id}")
async def get_payout(
    payout_id: uuid.UUID, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    a = await own_astrologer(db, user)
    return await payouts.detail(db, settings_of(request), await _own_payout(db, a, payout_id))


@router.get("/payouts/{payout_id}/statement.csv")
async def statement(payout_id: uuid.UUID, request: Request, user: CurrentUser, db: Db) -> Response:
    a = await own_astrologer(db, user)
    p = await _own_payout(db, a, payout_id)
    body = await payouts.statement_csv(db, settings_of(request), p)
    return Response(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="statement-{p.period}.csv"',
            "Cache-Control": "no-store",
        },
    )
