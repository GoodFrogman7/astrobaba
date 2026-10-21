"""Admin money endpoints: refunds, free-session overrides and reconciliation reports
(Phase 4, wallet work). Every write is audited with ids and amounts only."""

import base64
import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import free_session, payments, reconciliation, refunds, wallet
from astro_api.audit import audit
from astro_api.db import get_db
from astro_api.errors import ApiError
from astro_api.idempotency import Idempotency, idempotency_key
from astro_api.models import User
from astro_api.models_ledger import (
    FreeSessionClaim,
    FreeSessionOverride,
    ReconciliationRun,
    Refund,
)
from astro_api.roles import AdminUser, actor
from astro_api.wallet_api import wallet_view

router = APIRouter(prefix="/v1/admin/money", tags=["admin-money"])
Db = Annotated[AsyncSession, Depends(get_db)]
Limit = Annotated[int, Query(ge=1, le=100)]


class ManualRefundIn(BaseModel):
    session_id: uuid.UUID
    amount_paise: int = Field(gt=0)
    note: str = Field(default="", max_length=500)


class OverrideIn(BaseModel):
    user_id: uuid.UUID
    action: Literal["allow", "block", "reset"]
    note: str = Field(default="", max_length=500)


class RunIn(BaseModel):
    date: dt.date


def _encode(at: dt.datetime, row_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{at.isoformat()}|{row_id}".encode()).decode()


def _decode(cursor: str | None) -> tuple[dt.datetime, uuid.UUID] | None:
    if not cursor:
        return None
    try:
        at, row_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|")
        return dt.datetime.fromisoformat(at), uuid.UUID(row_id)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(422, "invalid_cursor", "Bad cursor.") from exc


def refund_view(r: Refund) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "rule": r.rule,
        "session_id": str(r.session_id),
        "user_id": str(r.user_id),
        "astrologer_id": str(r.astrologer_id) if r.astrologer_id else None,
        "amount_paise": r.amount_paise,
        "real_paise": r.real_paise,
        "promo_paise": r.promo_paise,
        "commission_paise": r.commission_paise,
        "astrologer_paise": r.astrologer_paise,
        "transaction_id": str(r.transaction_id),
        "actor": r.actor,
        "note": r.note,
        "created_at": r.created_at,
    }


@router.get("/users/{user_id}/wallet")
async def user_wallet(user_id: uuid.UUID, _: AdminUser, db: Db) -> dict[str, Any]:
    if await db.get(User, user_id) is None:
        raise ApiError(404, "not_found", "User not found.")
    view = await wallet_view(db, user_id, await free_session.admin_status(db, user_id))
    items, _next = await wallet.history(db, user_id, before=None, limit=20)
    return {"wallet": view, "transactions": items}


@router.get("/refunds")
async def list_refunds(
    _: AdminUser, db: Db, cursor: str | None = None, limit: Limit = 50
) -> dict[str, Any]:
    q = select(Refund).order_by(Refund.created_at.desc(), Refund.id.desc()).limit(limit + 1)
    if (after := _decode(cursor)) is not None:
        at, row_id = after
        q = q.where(or_(Refund.created_at < at, and_(Refund.created_at == at, Refund.id < row_id)))
    rows = list((await db.execute(q)).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [refund_view(r) for r in rows],
        "next_cursor": _encode(rows[-1].created_at, rows[-1].id) if more and rows else None,
    }


@router.post("/refunds", status_code=201)
async def create_refund(
    body: ManualRefundIn,
    request: Request,
    admin: AdminUser,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    redis: Redis = request.app.state.redis
    idem = Idempotency(
        redis, scope=f"admin_refund:{admin.id}", key=key, payload=body.model_dump(mode="json")
    )
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        try:
            row = await refunds.manual_refund(
                db,
                session_id=body.session_id,
                amount_paise=body.amount_paise,
                key=key,
                actor=actor(admin),
                note=body.note.strip() or None,
            )
        except refunds.RefundNotAllowed as exc:
            if exc.code == "not_found":
                raise ApiError(404, "not_found", exc.message) from exc
            raise ApiError(
                422, exc.code, exc.message, refundable_paise=exc.refundable_paise
            ) from exc
        except wallet.IdempotencyConflict as exc:
            raise ApiError(
                409, "idempotency_conflict", "This Idempotency-Key was used for another request."
            ) from exc
        out = jsonable_encoder(refund_view(row))
        await db.commit()
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    return JSONResponse(out, status_code=201)


@router.get("/free-sessions")
async def list_free_sessions(
    _: AdminUser,
    db: Db,
    flagged: bool = False,
    cursor: str | None = None,
    limit: Limit = 50,
) -> dict[str, Any]:
    q = (
        select(FreeSessionClaim, FreeSessionOverride)
        .outerjoin(FreeSessionOverride, FreeSessionOverride.user_id == FreeSessionClaim.user_id)
        .order_by(FreeSessionClaim.claimed_at.desc(), FreeSessionClaim.id.desc())
        .limit(limit + 1)
    )
    if flagged:
        q = q.where(FreeSessionClaim.abuse_score > 0)
    if (after := _decode(cursor)) is not None:
        at, row_id = after
        q = q.where(
            or_(
                FreeSessionClaim.claimed_at < at,
                and_(FreeSessionClaim.claimed_at == at, FreeSessionClaim.id < row_id),
            )
        )
    rows = (await db.execute(q)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    items = [
        {
            "id": str(c.id),
            "user_id": str(c.user_id),
            "session_id": str(c.session_id),
            "abuse_score": c.abuse_score,
            "reasons": list(c.reasons or []),
            "claimed_at": c.claimed_at,
            "override": {"action": o.action, "resets": o.resets, "note": o.note} if o else None,
        }
        for c, o in rows
    ]
    last = rows[-1][0] if rows else None
    return {
        "items": items,
        "next_cursor": _encode(last.claimed_at, last.id) if more and last else None,
    }


@router.post("/free-sessions/override")
async def override_free_session(body: OverrideIn, admin: AdminUser, db: Db) -> dict[str, Any]:
    if await db.get(User, body.user_id) is None:
        raise ApiError(404, "not_found", "User not found.")
    await free_session.override(
        db, user_id=body.user_id, action=body.action, note=body.note.strip() or None,
        actor=actor(admin),
    )  # fmt: skip
    await db.commit()
    status = await free_session.admin_status(db, body.user_id)
    return {
        "user_id": str(body.user_id),
        "action": body.action,
        "free_session": {"eligible": status.eligible, "reason": status.reason},
    }


@router.get("/reconciliation")
async def list_runs(
    _: AdminUser, db: Db, cursor: str | None = None, limit: Limit = 30
) -> dict[str, Any]:
    q = (
        select(ReconciliationRun)
        .order_by(ReconciliationRun.started_at.desc(), ReconciliationRun.id.desc())
        .limit(limit + 1)
    )
    if (after := _decode(cursor)) is not None:
        at, row_id = after
        q = q.where(
            or_(
                ReconciliationRun.started_at < at,
                and_(ReconciliationRun.started_at == at, ReconciliationRun.id < row_id),
            )
        )
    rows = list((await db.execute(q)).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [reconciliation.run_view(r) for r in rows],
        "next_cursor": _encode(rows[-1].started_at, rows[-1].id) if more and rows else None,
    }


@router.post("/reconciliation/run")
async def run_now(body: RunIn, request: Request, admin: AdminUser, db: Db) -> dict[str, Any]:
    gateway = payments.make_gateway(request.app.state.settings, request.app.state.redis)
    record = await reconciliation.run(db, gateway, body.date, trigger=actor(admin))
    audit(
        db, actor(admin), "reconciliation.run", "reconciliation_run", str(record.id),
        date=body.date.isoformat(), status=record.status, drift_paise=record.drift_paise,
    )  # fmt: skip
    await db.commit()
    return reconciliation.run_view(record)
