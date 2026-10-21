"""Razorpay webhooks: signature-verified, idempotent.

1. Verify X-Razorpay-Signature = HMAC-SHA256(webhook secret, raw body), constant time. Bad or
   missing → 400, nothing stored.
2. Store the event by X-Razorpay-Event-Id (UNIQUE). A replay → 200 {"status": "duplicate"}.
   The insert, the credit and the order update commit together, so a crash mid-way stores
   nothing and Razorpay's retry processes it again.
3. Credit only when the paid amount and currency equal the order's (else `mismatch`, alert).
   Keys: `razorpay:payment:{payment_id}:captured`, bonus `recharge_bonus:{order_id}`.

Stored payloads keep ids, amounts and statuses only (allow-list): no email, phone, VPA or card.
Dev-only routes (`/v1/dev/payments/...`) drive the Fake gateway through the same code path and
are 404 outside development/test or with a real provider.
"""

import datetime as dt
import hashlib
import json
import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config, payments, wallet
from astro_api.auth import CurrentUser
from astro_api.config import Settings
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.models_ledger import PaymentEvent, RechargeOrder
from astro_api.roles import AdminUser

log = logging.getLogger(__name__)
router = APIRouter(tags=["payments"])

KEEP = {
    "event": {"entity", "account_id", "event", "contains", "created_at"},
    "payment": {
        "id", "entity", "amount", "currency", "status", "order_id", "method", "captured",
        "amount_refunded", "refund_status", "fee", "tax", "error_code", "error_reason",
        "created_at",
    },
    "order": {"id", "entity", "amount", "amount_paid", "amount_due", "currency", "status",
              "attempts", "created_at"},
    "settlement": {"id", "entity", "amount", "fees", "tax", "status", "created_at"},
    "refund": {"id", "entity", "amount", "currency", "payment_id", "status", "created_at"},
}  # fmt: skip


def sanitize(body: dict[str, Any]) -> dict[str, Any]:
    """Allow-list copy of a webhook body: ids, amounts and statuses only."""
    out: dict[str, Any] = {k: body[k] for k in KEEP["event"] if k in body}
    payload = body.get("payload")
    if isinstance(payload, dict):
        kept: dict[str, Any] = {}
        for name, wrapper in payload.items():
            if (
                name in KEEP
                and isinstance(wrapper, dict)
                and isinstance(wrapper.get("entity"), dict)
            ):
                entity = wrapper["entity"]
                kept[name] = {"entity": {k: entity[k] for k in KEEP[name] if k in entity}}
        out["payload"] = kept
    return out


def _entity(body: dict[str, Any], name: str) -> dict[str, Any] | None:
    payload = body.get("payload")
    if not isinstance(payload, dict):
        return None
    wrapper = payload.get(name)
    if not isinstance(wrapper, dict) or not isinstance(wrapper.get("entity"), dict):
        return None
    entity: dict[str, Any] = wrapper["entity"]
    return entity


async def _order_for_update(db: AsyncSession, provider_order_id: Any) -> RechargeOrder | None:
    if not isinstance(provider_order_id, str):
        return None
    order: RechargeOrder | None = (
        await db.execute(
            select(RechargeOrder)
            .where(RechargeOrder.provider_order_id == provider_order_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    return order


async def _captured(db: AsyncSession, event_id: str, payment: dict[str, Any]) -> str:
    order = await _order_for_update(db, payment.get("order_id"))
    if order is None:
        log.warning("payment_unknown_order", extra={"event_id": event_id})
        return "unknown_order"
    if payment.get("status") != "captured":
        return "ignored"
    amount, currency = payment.get("amount"), payment.get("currency")
    if not isinstance(amount, int) or amount != order.amount_paise or currency != order.currency:
        log.error(
            "payment_mismatch",
            extra={
                "event_id": event_id,
                "order_id": str(order.id),
                "expected_paise": order.amount_paise,
                "paid_paise": amount if isinstance(amount, int) else None,
                "expected_currency": order.currency,
                "paid_currency": str(currency)[:8],
            },
        )
        return "mismatch"
    payment_id = str(payment["id"])
    if order.status == "paid" and order.provider_payment_id not in (None, payment_id):
        # The same order paid twice (a customer can do this). Credit the order once; the extra
        # payment is refunded to the card by support. Reconciliation shows it as a captured
        # payment without a credit until then.
        log.error(
            "duplicate_payment",
            extra={"event_id": event_id, "order_id": str(order.id), "payment_id": payment_id},
        )
        return "duplicate_payment"
    now = dt.datetime.now(dt.UTC)
    await wallet.credit_recharge(
        db,
        user_id=order.user_id,
        payment_id=payment_id,
        amount_paise=amount,
        occurred_at=payments.epoch_to_dt(payment.get("created_at")) or now,
    )
    if order.bonus_paise > 0:
        await wallet.grant_promo(
            db,
            user_id=order.user_id,
            amount_paise=order.bonus_paise,
            campaign="recharge_bonus",
            key=f"recharge_bonus:{order.id}",
            expires_at=now + dt.timedelta(days=billing_config.promo_expiry_days()),
            kind="recharge_bonus",
        )
    order.status = "paid"
    order.paid_at = order.paid_at or now
    order.provider_payment_id = order.provider_payment_id or payment_id
    return "processed"


async def _failed(db: AsyncSession, event_id: str, payment: dict[str, Any]) -> str:
    order = await _order_for_update(db, payment.get("order_id"))
    if order is None:
        log.warning("payment_unknown_order", extra={"event_id": event_id})
        return "unknown_order"
    if order.status != "paid":
        order.status = "failed"
        order.failed_at = dt.datetime.now(dt.UTC)
    return "processed"


async def _settled(db: AsyncSession, settlement: dict[str, Any]) -> str:
    amount, fees = settlement.get("amount"), settlement.get("fees", 0)
    if not isinstance(amount, int) or not isinstance(fees, int) or "id" not in settlement:
        return "ignored"
    await wallet.post_settlement(
        db,
        settlement_id=str(settlement["id"]),
        amount_paise=amount,
        fees_paise=fees,
        occurred_at=payments.epoch_to_dt(settlement.get("created_at")),
    )
    return "processed"


async def _handle(db: AsyncSession, event_id: str, kind: str, body: dict[str, Any]) -> str:
    payment = _entity(body, "payment")
    if kind in ("payment.captured", "order.paid") and payment is not None:
        return await _captured(db, event_id, payment)
    if kind == "payment.failed" and payment is not None:
        return await _failed(db, event_id, payment)
    settlement = _entity(body, "settlement")
    if kind == "settlement.processed" and settlement is not None:
        return await _settled(db, settlement)
    return "ignored"


async def process_webhook(
    db: AsyncSession, settings: Settings, raw: bytes, signature: str | None, event_id: str | None
) -> str:
    """Verify, store and apply one webhook; commits. Returns the event status:
    processed | duplicate | mismatch | unknown_order | ignored | conflict."""
    if not payments.verify(payments.webhook_secret(settings), raw, signature):
        raise ApiError(400, "invalid_signature", "Webhook signature is missing or wrong.")
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise ApiError(400, "invalid_payload", "Webhook body is not JSON.") from exc
    if not isinstance(body, dict):
        raise ApiError(400, "invalid_payload", "Webhook body is not a JSON object.")
    event_id = (event_id or "").strip()[:128] or "sha256:" + hashlib.sha256(raw).hexdigest()
    kind = str(body.get("event", ""))[:64]
    payment = _entity(body, "payment") or {}
    amount = payment.get("amount")
    row_id = (
        await db.execute(
            pg_insert(PaymentEvent)
            .values(
                provider=settings.payments_provider,
                event_id=event_id,
                event_type=kind,
                status="received",
                provider_order_id=str(payment["order_id"]) if payment.get("order_id") else None,
                provider_payment_id=str(payment["id"]) if payment.get("id") else None,
                amount_paise=amount if isinstance(amount, int) else None,
                currency=str(payment["currency"])[:8] if payment.get("currency") else None,
                payload=sanitize(body),
            )
            .on_conflict_do_nothing(index_elements=["event_id"])
            .returning(PaymentEvent.id)
        )
    ).scalar_one_or_none()
    if row_id is None:
        await db.rollback()
        return "duplicate"
    try:
        async with db.begin_nested():
            status = await _handle(db, event_id, kind, body)
    except wallet.IdempotencyConflict:
        log.error("payment_idempotency_conflict", extra={"event_id": event_id})
        status = "conflict"
    await db.execute(update(PaymentEvent).where(PaymentEvent.id == row_id).values(status=status))
    await db.commit()
    return status


@router.post("/v1/payments/razorpay/webhook")
async def razorpay_webhook(request: Request, db: Db) -> dict[str, str]:
    raw = await request.body()
    status = await process_webhook(
        db,
        settings_of(request),
        raw,
        request.headers.get("x-razorpay-signature"),
        request.headers.get("x-razorpay-event-id"),
    )
    return {"status": status}


# ------------------------------------------------------------------ development only


class SimulateIn(BaseModel):
    outcome: Literal["captured", "failed"]


def _fake_gateway(request: Request) -> payments.FakeGateway:
    settings = settings_of(request)
    if settings.app_env not in ("development", "test") or settings.payments_provider != "fake":
        raise ApiError(404, "not_found", "Not found.")
    return payments.FakeGateway(settings, redis_of(request))


@router.post("/v1/dev/payments/{order_id}/simulate", tags=["dev"])
async def simulate_payment(
    order_id: uuid.UUID, body: SimulateIn, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    """Fake provider only: pay (or fail) one of your orders, through the real webhook path."""
    gateway = _fake_gateway(request)
    order = await db.get(RechargeOrder, order_id)
    if order is None or order.user_id != user.id or order.provider_order_id is None:
        raise ApiError(404, "not_found", "Order not found.")
    if order.status == "paid":
        raise ApiError(409, "order_already_paid", "This order is already paid.")
    signed = await gateway.simulate(order.provider_order_id, body.outcome)
    status = await process_webhook(
        db, settings_of(request), signed.raw, signed.signature, signed.event_id
    )
    return {"status": status, "provider_payment_id": signed.payment_id}


@router.post("/v1/dev/payments/settle", tags=["dev"])
async def simulate_settlement(request: Request, _: AdminUser, db: Db) -> dict[str, Any]:
    """Fake provider only: settle every captured, unsettled payment (for reconciliation)."""
    gateway = _fake_gateway(request)
    signed = await gateway.settle()
    if signed is None:
        return {"status": "nothing_to_settle"}
    status = await process_webhook(
        db, settings_of(request), signed.raw, signed.signature, signed.event_id
    )
    return {"status": status}
