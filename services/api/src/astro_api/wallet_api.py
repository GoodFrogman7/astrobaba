"""Wallet: balances, transactions, recharge orders (docs/api/billing.md).

Credit only ever comes from the signed webhook. The Checkout result is verified and recorded but
never credits. Bonus is decided when the order is created (flag + tiers at that moment).
"""

import datetime as dt
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config, free_session, payments, wallet
from astro_api.auth import CurrentSession, client_ip
from astro_api.config import Settings
from astro_api.consent import RequireUserConsent
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.flags import flag_enabled
from astro_api.idempotency import Idempotency, idempotency_key
from astro_api.models import User
from astro_api.models_ledger import RechargeOrder

router = APIRouter(prefix="/v1/wallet", tags=["wallet"])


class RechargeIn(BaseModel):
    amount_paise: int


class CheckoutResultIn(BaseModel):
    provider_payment_id: str = Field(min_length=4, max_length=64, pattern=r"^[A-Za-z0-9_]+$")
    provider_signature: str = Field(min_length=16, max_length=256)


def order_view(o: RechargeOrder, settings: Settings) -> dict[str, Any]:
    return {
        "id": str(o.id),
        "status": o.status,
        "amount_paise": o.amount_paise,
        "bonus_paise": o.bonus_paise,
        "currency": o.currency,
        "provider": o.provider,
        "provider_order_id": o.provider_order_id,
        "key_id": payments.key_id(settings),
        "created_at": o.created_at,
        "paid_at": o.paid_at,
    }


def _bonus(amount_paise: int) -> int:
    if not flag_enabled(str(billing_config.bonus_tiers()["flag"])):
        return 0
    return billing_config.bonus_for(amount_paise)


async def wallet_view(
    db: AsyncSession, user_id: uuid.UUID, free: free_session.Eligibility
) -> dict[str, Any]:
    b = await wallet.balances(db, user_id)
    lots = await wallet.usable_lots(db, user_id)
    return {
        "real_paise": b.real_paise,
        "promo_paise": b.promo_paise,
        "total_paise": b.total_paise,
        "promo_lots": [
            {
                "id": str(lot.id),
                "remaining_paise": lot.remaining_paise,
                "expires_at": lot.expires_at,
                "campaign": lot.campaign,
            }
            for lot in lots
        ],
        "free_session": {
            "enabled": flag_enabled(str(billing_config.free_session()["flag"])),
            "eligible": free.eligible,
            "minutes": free.minutes,
            "reason": free.reason,
        },
    }


@router.get("")
async def get_wallet(request: Request, su: CurrentSession, db: Db) -> dict[str, Any]:
    auth_session, user = su
    free = await free_session.check(
        db,
        redis_of(request),
        user_id=user.id,
        device_id=auth_session.device_id or "",
        client_ip=client_ip(request, settings_of(request)),
    )
    return await wallet_view(db, user.id, free)


def parse_cursor(cursor: str | None) -> int | None:
    if cursor is None or cursor == "":
        return None
    if not cursor.isdigit():
        raise ApiError(422, "invalid_cursor", "Bad cursor.")
    return int(cursor)


@router.get("/transactions")
async def transactions(
    su: CurrentSession,
    db: Db,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    items, next_seq = await wallet.history(db, su[1].id, before=parse_cursor(cursor), limit=limit)
    return {"items": items, "next_cursor": str(next_seq) if next_seq is not None else None}


@router.get("/recharge-options")
async def recharge_options(request: Request, su: CurrentSession) -> dict[str, Any]:
    cfg = billing_config.recharge()
    settings = settings_of(request)
    return {
        "currency": billing_config.currency(),
        "min_paise": int(cfg["min_paise"]),
        "max_paise": int(cfg["max_paise"]),
        "packs": [
            {"amount_paise": int(p), "bonus_paise": _bonus(int(p))} for p in cfg["packs_paise"]
        ],
        "bonus_enabled": flag_enabled(str(billing_config.bonus_tiers()["flag"])),
        "provider": settings.payments_provider,
        "key_id": payments.key_id(settings),
    }


@router.post("/recharge-orders", status_code=201, dependencies=[RequireUserConsent])
async def create_recharge_order(
    body: RechargeIn,
    request: Request,
    su: CurrentSession,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    user = su[1]
    settings = settings_of(request)
    redis = redis_of(request)
    idem = Idempotency(redis, scope=f"recharge:{user.id}", key=key, payload=body.model_dump())
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        cfg = billing_config.recharge()
        if not int(cfg["min_paise"]) <= body.amount_paise <= int(cfg["max_paise"]):
            raise ApiError(
                422,
                "amount_out_of_range",
                "Recharge amount is outside the allowed range.",
                min_paise=int(cfg["min_paise"]),
                max_paise=int(cfg["max_paise"]),
            )
        existing = (
            await db.execute(
                select(RechargeOrder).where(
                    RechargeOrder.user_id == user.id, RechargeOrder.idempotency_key == key
                )
            )
        ).scalar_one_or_none()
        if existing is not None:  # Redis forgot the key; Postgres did not
            if existing.amount_paise != body.amount_paise:
                raise ApiError(
                    409,
                    "idempotency_conflict",
                    "This Idempotency-Key was used for another request.",
                )
            order = existing
        else:
            order = RechargeOrder(
                id=uuid.uuid4(),
                user_id=user.id,
                idempotency_key=key,
                amount_paise=body.amount_paise,
                bonus_paise=_bonus(body.amount_paise),
                currency=billing_config.currency(),
                status="created",
                provider=settings.payments_provider,
                created_at=dt.datetime.now(dt.UTC),
            )
            db.add(order)
            try:
                await db.flush()
            except IntegrityError as exc:
                raise ApiError(
                    409, "idempotency_in_progress", "The same request is still running."
                ) from exc
            gateway = payments.make_gateway(settings, redis)
            try:
                order.provider_order_id = await gateway.create_order(
                    amount_paise=order.amount_paise,
                    currency=order.currency,
                    receipt=str(order.id),
                    notes={"order_id": str(order.id)},
                )
            except payments.PaymentProviderError as exc:
                raise ApiError(
                    502, "payment_provider_error", "The payment provider is unavailable."
                ) from exc
            await db.commit()
        out = jsonable_encoder(order_view(order, settings))
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    return JSONResponse(out, status_code=201)


async def _own_order(db: AsyncSession, order_id: uuid.UUID, user: User) -> RechargeOrder:
    order = await db.get(RechargeOrder, order_id)
    if order is None or order.user_id != user.id:
        raise ApiError(404, "not_found", "Order not found.")
    return order


@router.get("/recharge-orders/{order_id}")
async def get_recharge_order(
    order_id: uuid.UUID, request: Request, su: CurrentSession, db: Db
) -> dict[str, Any]:
    return order_view(await _own_order(db, order_id, su[1]), settings_of(request))


@router.post("/recharge-orders/{order_id}/checkout-result")
async def checkout_result(
    order_id: uuid.UUID, body: CheckoutResultIn, request: Request, su: CurrentSession, db: Db
) -> dict[str, Any]:
    """Verify Razorpay Checkout's signature HMAC-SHA256(key_secret, order_id|payment_id) and
    record it. Never credits: only the webhook does."""
    settings = settings_of(request)
    order = await _own_order(db, order_id, su[1])
    gateway = payments.make_gateway(settings, redis_of(request))
    if order.provider_order_id is None or not gateway.verify_checkout(
        order.provider_order_id, body.provider_payment_id, body.provider_signature
    ):
        raise ApiError(400, "invalid_signature", "Payment signature could not be verified.")
    order.checkout_payment_id = body.provider_payment_id
    order.checkout_verified = True
    order.checkout_at = dt.datetime.now(dt.UTC)
    await db.commit()
    return order_view(order, settings)
