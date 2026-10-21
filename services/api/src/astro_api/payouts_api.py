"""Admin payouts: generate, approve, mark paid, void (Phase 5, portal work).
docs/api/portal.md §3. Every action is audited (astro_api.payouts) with ids and amounts only."""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import payouts
from astro_api.config import Settings
from astro_api.db import get_db
from astro_api.errors import ApiError
from astro_api.models import Astrologer
from astro_api.models_portal import Payout
from astro_api.roles import AdminUser, actor

router = APIRouter(prefix="/v1/admin/payouts", tags=["admin-payouts"])
Db = Annotated[AsyncSession, Depends(get_db)]

BANK_PLACEHOLDER = {
    "account_holder": None,
    "account_number_last4": None,
    "ifsc": None,
    "note": "Bank details are collected and checked outside the platform in v1; "
    "transfers are made by hand.",
}


class GenerateIn(BaseModel):
    period: str = Field(max_length=7)


class MarkPaidIn(BaseModel):
    reference: str = Field(max_length=64)
    paid_on: dt.date


class VoidIn(BaseModel):
    note: str = Field(default="", max_length=500)


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _api_error(exc: payouts.PayoutError) -> ApiError:
    return ApiError(exc.status, exc.code, exc.message, **exc.extra)


def _astrologer(a: Astrologer) -> dict[str, Any]:
    return {"id": str(a.id), "slug": a.slug, "display_name": a.display_name}


async def _admin_item(db: AsyncSession, p: Payout) -> dict[str, Any]:
    a = await db.get(Astrologer, p.astrologer_id)
    assert a is not None  # foreign key
    return {**payouts.payout_view(p), "astrologer": _astrologer(a)}


@router.get("")
async def list_payouts(
    _: AdminUser,
    db: Db,
    period: str | None = None,
    status: Literal["draft", "approved", "paid", "void"] | None = None,
) -> dict[str, Any]:
    query = select(Payout, Astrologer).join(Astrologer, Astrologer.id == Payout.astrologer_id)
    if period:
        query = query.where(Payout.period == period)
    if status:
        query = query.where(Payout.status == status)
    rows = (
        await db.execute(query.order_by(Payout.period.desc(), Astrologer.display_name, Payout.id))
    ).all()
    return {"items": [{**payouts.payout_view(p), "astrologer": _astrologer(a)} for p, a in rows]}


@router.post("/generate")
async def generate(body: GenerateIn, admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        result = await payouts.generate(db, body.period.strip(), actor=actor(admin))
    except payouts.PayoutError as exc:
        raise _api_error(exc) from exc
    await db.commit()
    return {
        "period": result.period,
        "generated": result.generated,
        "updated": result.updated,
        "skipped": result.skipped,
        "carried_forward": result.carried_forward,
    }


@router.get("/{payout_id}")
async def get_payout(
    payout_id: uuid.UUID, request: Request, _: AdminUser, db: Db
) -> dict[str, Any]:
    p = await db.get(Payout, payout_id)
    if p is None:
        raise ApiError(404, "not_found", "Payout not found.")
    a = await db.get(Astrologer, p.astrologer_id)
    assert a is not None  # foreign key
    return {
        **await payouts.detail(db, _settings(request), p),
        "astrologer": _astrologer(a),
        "bank": BANK_PLACEHOLDER,
    }


@router.post("/{payout_id}/approve")
async def approve(payout_id: uuid.UUID, admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        p = await payouts.approve(db, payout_id, actor=actor(admin))
    except payouts.PayoutError as exc:
        raise _api_error(exc) from exc
    await db.commit()
    return await _admin_item(db, p)


@router.post("/{payout_id}/mark-paid")
async def mark_paid(
    payout_id: uuid.UUID, body: MarkPaidIn, admin: AdminUser, db: Db
) -> dict[str, Any]:
    try:
        p = await payouts.mark_paid(
            db, payout_id, reference=body.reference, paid_on=body.paid_on, actor=actor(admin)
        )
    except payouts.PayoutError as exc:
        raise _api_error(exc) from exc
    await db.commit()
    return await _admin_item(db, p)


@router.post("/{payout_id}/void")
async def void(payout_id: uuid.UUID, body: VoidIn, admin: AdminUser, db: Db) -> dict[str, Any]:
    try:
        p = await payouts.void(db, payout_id, note=body.note, actor=actor(admin))
    except payouts.PayoutError as exc:
        raise _api_error(exc) from exc
    await db.commit()
    return await _admin_item(db, p)
