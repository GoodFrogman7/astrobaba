"""Paid reports: products, orders, reports, downloads, render data, sample, admin
(docs/api/revenue.md §2, ADR-0009).

Money: a wallet order is charged and its report created and queued in one transaction; a
Razorpay order is paid only by the signed webhook (payments_webhooks → reports). Birth details,
names and emails are never logged; errors carry codes only.
"""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

import anyio
from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config, payments, reports, wallet
from astro_api.auth import CurrentUser, current_session
from astro_api.config import Settings
from astro_api.consent import RequireUserConsent
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.idempotency import Idempotency, idempotency_key
from astro_api.models import SavedKundli, User
from astro_api.models_jobs import Job
from astro_api.models_reports import REPORT_STATUSES, Report, ReportOrder
from astro_api.roles import AdminUser, actor
from astro_api.storage import DocumentStorage

router = APIRouter(tags=["reports"])

Sku = Literal["kundli_report", "matching_report"]
Language = Literal["en", "hi"]
EMAIL_PATTERN = r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$"
PRIVATE = {"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex"}
ADMIN_PAGE = 50


class OrderIn(BaseModel):
    sku: Sku
    language: Language
    kundli_ids: list[uuid.UUID] = Field(min_length=1, max_length=2)
    pay_with: Literal["wallet", "razorpay"]
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)


class CheckoutResultIn(BaseModel):
    provider_payment_id: str = Field(min_length=4, max_length=64, pattern=r"^[A-Za-z0-9_]+$")
    provider_signature: str = Field(min_length=16, max_length=256)


class RetryIn(BaseModel):
    # v1: a re-render is always free (docs/api/revenue.md §2.3a).
    charge_again: Literal[False] = False


def order_view(o: ReportOrder, settings: Settings) -> dict[str, Any]:
    return {
        "id": str(o.id),
        "sku": o.sku,
        "language": o.language,
        "status": o.status,
        "price_paise": o.price_paise,
        "currency": o.currency,
        "pay_with": o.pay_with,
        "provider": o.provider,
        "provider_order_id": o.provider_order_id,
        "key_id": payments.key_id(settings) if o.pay_with == "razorpay" else None,
        "report_id": str(o.report_id) if o.report_id else None,
        "created_at": o.created_at,
        "paid_at": o.paid_at,
    }


def report_view(r: Report, settings: Settings) -> dict[str, Any]:
    ready = r.status == "ready" and r.storage_key is not None
    return {
        "id": str(r.id),
        "sku": r.sku,
        "language": r.language,
        "status": r.status,
        "title": reports.title(r),
        "created_at": r.created_at,
        "ready_at": r.ready_at,
        "pages": r.pages,
        "download_url": reports.download_url(settings, r.id) if ready else None,
    }


# ------------------------------------------------------------------ products and buying


@router.get("/v1/reports/products")
async def products() -> dict[str, Any]:
    return {"items": reports.product_list()}


async def _own_kundlis(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> list[SavedKundli]:
    rows = {
        k.id: k
        for k in (
            await db.execute(
                select(SavedKundli).where(SavedKundli.id.in_(ids), SavedKundli.user_id == user.id)
            )
        ).scalars()
    }
    if any(i not in rows for i in ids):  # other users' kundlis look exactly like missing ones
        raise ApiError(404, "kundli_not_found", "Kundli not found.")
    return [rows[i] for i in ids]


def _same_order(o: ReportOrder, body: OrderIn) -> bool:
    return (o.sku, o.language, list(o.kundli_ids), o.pay_with) == (
        body.sku,
        body.language,
        body.kundli_ids,
        body.pay_with,
    )


async def _create_order(
    db: AsyncSession, request: Request, user: User, body: OrderIn, key: str
) -> ReportOrder:
    settings = settings_of(request)
    product = reports.report_product(body.sku)
    if product is None:
        raise ApiError(404, "product_not_found", "Unknown report.")
    if body.language not in product["languages"]:
        raise ApiError(
            422, "language_unavailable", "This report is not available in that language."
        )
    needed = int(product["kundlis"])
    if len(body.kundli_ids) != needed or len(set(body.kundli_ids)) != needed:
        raise ApiError(
            422,
            "wrong_kundli_count",
            f"This report needs {needed} different saved kundli(s).",
            kundlis=needed,
        )
    kundlis = await _own_kundlis(db, user, body.kundli_ids)
    try:
        async with reports.engine_client(settings) as http:
            snapshot = await reports.build_snapshot(
                http,
                body.sku,
                [reports.birth_from_kundli(k) for k in kundlis],
                reports.snapshot_as_of(),
            )
    except reports.EngineUnavailable as exc:
        raise ApiError(
            503, "engine_unavailable", "Charts cannot be computed right now. Try again soon."
        ) from exc
    now = dt.datetime.now(dt.UTC)
    order = ReportOrder(
        id=uuid.uuid4(),
        user_id=user.id,
        idempotency_key=key,
        sku=body.sku,
        language=body.language,
        kundli_ids=body.kundli_ids,
        pay_with=body.pay_with,
        price_paise=int(product["price_paise"]),
        currency=billing_config.currency(),
        status="created",
        provider=settings.payments_provider if body.pay_with == "razorpay" else None,
        snapshot=snapshot,
        engine_version=reports.engine_version(snapshot),
        created_at=now,
    )
    if body.email:
        reports.seal_email(settings, order, body.email.strip())
    db.add(order)
    try:
        await db.flush()
    except IntegrityError as exc:
        raise ApiError(
            409, "idempotency_in_progress", "The same request is still running."
        ) from exc
    if body.pay_with == "wallet":
        try:
            await wallet.charge_purchase(
                db,
                user_id=user.id,
                key=reports.paid_key(order.id),
                product="report",
                ref_id=str(order.id),
                amount_paise=order.price_paise,
            )
        except wallet.InsufficientFunds as exc:
            user_id = user.id
            await db.rollback()  # nothing of this order is kept
            available = (await wallet.balances(db, user_id)).total_paise
            raise ApiError(
                402,
                "insufficient_funds",
                "Your wallet balance is too low for this report.",
                required_paise=int(product["price_paise"]),
                available_paise=available,
            ) from exc
        # Same transaction as the charge: the report row and its render job.
        await reports.mark_paid(db, order, now)
    else:
        gateway = payments.make_gateway(settings, redis_of(request))
        try:
            order.provider_order_id = await gateway.create_order(
                amount_paise=order.price_paise,
                currency=order.currency,
                receipt=str(order.id),
                notes={"report_order_id": str(order.id)},
            )
        except payments.PaymentProviderError as exc:
            raise ApiError(
                502, "payment_provider_error", "The payment provider is unavailable."
            ) from exc
    await db.commit()
    return order


@router.post("/v1/reports/orders", status_code=201, dependencies=[RequireUserConsent])
async def create_order(
    body: OrderIn,
    request: Request,
    user: CurrentUser,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    settings = settings_of(request)
    idem = Idempotency(
        redis_of(request),
        scope=f"report_order:{user.id}",
        key=key,
        payload=body.model_dump(mode="json"),
    )
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        existing = (
            await db.execute(
                select(ReportOrder).where(
                    ReportOrder.user_id == user.id, ReportOrder.idempotency_key == key
                )
            )
        ).scalar_one_or_none()
        if existing is not None:  # Redis forgot the key; Postgres did not
            if not _same_order(existing, body):
                raise ApiError(
                    409,
                    "idempotency_conflict",
                    "This Idempotency-Key was used for another request.",
                )
            order = existing
        else:
            order = await _create_order(db, request, user, body, key)
        out = jsonable_encoder(order_view(order, settings))
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    return JSONResponse(out, status_code=201)


async def _own_order(db: AsyncSession, order_id: uuid.UUID, user: User) -> ReportOrder:
    order = await db.get(ReportOrder, order_id)
    if order is None or order.user_id != user.id:
        raise ApiError(404, "not_found", "Order not found.")
    return order


@router.get("/v1/reports/orders/{order_id}")
async def get_order(
    order_id: uuid.UUID, request: Request, user: CurrentUser, db: Db
) -> JSONResponse:
    order = await _own_order(db, order_id, user)
    return JSONResponse(jsonable_encoder(order_view(order, settings_of(request))))


@router.post("/v1/reports/orders/{order_id}/checkout-result")
async def checkout_result(
    order_id: uuid.UUID, body: CheckoutResultIn, request: Request, user: CurrentUser, db: Db
) -> JSONResponse:
    """Verify Razorpay Checkout's signature HMAC-SHA256(key_secret, order_id|payment_id) and
    record it. Never pays the order: only the webhook does (as for recharges)."""
    settings = settings_of(request)
    order = await _own_order(db, order_id, user)
    if order.pay_with != "razorpay":
        raise ApiError(409, "not_a_card_order", "This order was paid from the wallet.")
    gateway = payments.make_gateway(settings, redis_of(request))
    if order.provider_order_id is None or not gateway.verify_checkout(
        order.provider_order_id, body.provider_payment_id, body.provider_signature
    ):
        raise ApiError(400, "invalid_signature", "Payment signature could not be verified.")
    order.checkout_payment_id = body.provider_payment_id
    order.checkout_verified = True
    order.checkout_at = dt.datetime.now(dt.UTC)
    await db.commit()
    return JSONResponse(jsonable_encoder(order_view(order, settings)))


# ------------------------------------------------------------------ reports


@router.get("/v1/reports")
async def list_reports(request: Request, user: CurrentUser, db: Db) -> dict[str, Any]:
    rows = (
        await db.execute(
            select(Report)
            .where(Report.user_id == user.id)
            .order_by(Report.created_at.desc(), Report.id)
        )
    ).scalars()
    settings = settings_of(request)
    return {"items": [report_view(r, settings) for r in rows]}


@router.get("/v1/reports/sample")
async def sample(sku: Sku, language: Language, request: Request, db: Db) -> JSONResponse:
    """The public sample (fictional birth input, same pipeline), cached per sku+language."""
    try:
        report = await reports.get_or_create_sample(db, settings_of(request), sku, language)
    except reports.EngineUnavailable as exc:
        raise ApiError(503, "engine_unavailable", "The sample is not available right now.") from exc
    if report is None:
        raise ApiError(404, "sample_unavailable", "There is no sample for this report yet.")
    if report.status == "failed":
        raise ApiError(503, "sample_unavailable", "The sample is not available right now.")
    ready = report.status == "ready" and report.storage_key is not None
    body = {
        "status": report.status,
        "pages": report.pages,
        "download_url": reports.download_url(settings_of(request), report.id) if ready else None,
    }
    return JSONResponse(body, status_code=200 if ready else 202, headers=PRIVATE)


@router.get("/v1/reports/render/{report_id}")
async def render_data(
    report_id: uuid.UUID, request: Request, db: Db, sig: str | None = None
) -> JSONResponse:
    """RenderData for the private print page (signed, 5 minutes; no session).
    Bad signature 403, expired 410, unknown report 404."""
    _require_sig(settings_of(request), "render", report_id, sig)
    report = await db.get(Report, report_id)
    if report is None:
        raise ApiError(404, "not_found", "Report not found.")
    return JSONResponse(jsonable_encoder(reports.render_data(report)), headers=PRIVATE)


def _require_sig(settings: Settings, purpose: str, report_id: uuid.UUID, sig: str | None) -> None:
    status = reports.check(settings, purpose, report_id, sig)
    if status == "expired":
        raise ApiError(410, "link_expired", "This link has expired.")
    if status != "ok":
        raise ApiError(403, "invalid_signature", "This link is invalid.")


async def _own_report(db: AsyncSession, report_id: uuid.UUID, user: User) -> Report:
    report = await db.get(Report, report_id)
    if report is None or report.user_id != user.id:
        raise ApiError(404, "not_found", "Report not found.")
    return report


@router.get("/v1/reports/{report_id}")
async def get_report(
    report_id: uuid.UUID, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    return report_view(await _own_report(db, report_id, user), settings_of(request))


@router.get("/v1/reports/{report_id}/file")
async def download(
    report_id: uuid.UUID,
    request: Request,
    db: Db,
    sig: str | None = None,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    """The PDF: with a valid signed link, or with the owner's session."""
    settings = settings_of(request)
    report = await db.get(Report, report_id)
    allowed = reports.verify(settings, "file", report_id, sig)
    if not allowed and authorization:
        _, user = await current_session(db, authorization)
        allowed = report is not None and report.user_id == user.id
    if not allowed:
        if sig:
            _require_sig(settings, "file", report_id, sig)
        raise ApiError(401, "unauthenticated", "Sign in to continue.")
    if report is None or report.status != "ready" or report.storage_key is None:
        raise ApiError(404, "not_found", "Report not found.")
    storage: DocumentStorage = request.app.state.storage
    data = await anyio.to_thread.run_sync(storage.get, report.storage_key)
    name = f"{report.sku.replace('_', '-')}-{str(report.id)[:8]}.pdf"
    return Response(
        data,
        media_type="application/pdf",
        headers={**PRIVATE, "Content-Disposition": f'attachment; filename="{name}"'},
    )


# ------------------------------------------------------------------ admin (§2.3a)


def _cursor(created_at: dt.datetime, report_id: uuid.UUID) -> str:
    return f"{int(created_at.timestamp() * 1_000_000)}_{report_id}"


def _parse_cursor(raw: str) -> tuple[dt.datetime, uuid.UUID]:
    micros, _, rid = raw.partition("_")
    try:
        return dt.datetime.fromtimestamp(int(micros) / 1_000_000, dt.UTC), uuid.UUID(rid)
    except ValueError as exc:
        raise ApiError(422, "invalid_cursor", "Bad cursor.") from exc


def _admin_item(
    r: Report, attempts: int | None, job_error: str | None, pay_with: str | None
) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "owner_id": str(r.user_id) if r.user_id else None,
        "order_id": str(r.order_id) if r.order_id else None,
        "sample": r.sample_key is not None,
        "sku": r.sku,
        "language": r.language,
        "status": r.status,
        "pay_with": pay_with,
        "attempts": attempts or 0,
        "last_error_code": job_error or r.last_error_code,
        "render_n": r.render_n,
        "pages": r.pages,
        "refunded": r.refunded_at is not None,
        "created_at": r.created_at,
        "ready_at": r.ready_at,
        "failed_at": r.failed_at,
    }


@router.get("/v1/admin/reports", tags=["admin"])
async def admin_reports(
    _: AdminUser,
    db: Db,
    status: Annotated[str | None, Query(pattern="^(" + "|".join(REPORT_STATUSES) + ")$")] = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    """Reports with owner id, status, attempts and last error code. Never names or births."""
    q = (
        select(Report, Job.attempts, Job.last_error_code, ReportOrder.pay_with)
        .outerjoin(Job, Job.key == Report.render_job_key)
        .outerjoin(ReportOrder, ReportOrder.id == Report.order_id)
        .order_by(Report.created_at.desc(), Report.id.desc())
        .limit(ADMIN_PAGE + 1)
    )
    if status:
        q = q.where(Report.status == status)
    if cursor:
        at, rid = _parse_cursor(cursor)
        q = q.where(or_(Report.created_at < at, and_(Report.created_at == at, Report.id < rid)))
    rows = (await db.execute(q)).all()
    items = [
        _admin_item(r, attempts, job_error, pay_with)
        for r, attempts, job_error, pay_with in rows[:ADMIN_PAGE]
    ]
    last = rows[ADMIN_PAGE - 1][0] if len(rows) > ADMIN_PAGE else None
    return {"items": items, "next_cursor": _cursor(last.created_at, last.id) if last else None}


@router.post("/v1/admin/reports/{report_id}/retry", tags=["admin"])
async def admin_retry(
    report_id: uuid.UUID, body: RetryIn, admin: AdminUser, db: Db
) -> dict[str, Any]:
    report = (
        await db.execute(select(Report).where(Report.id == report_id).with_for_update())
    ).scalar_one_or_none()
    if report is None:
        raise ApiError(404, "not_found", "Report not found.")
    if report.status != "failed":
        raise ApiError(409, "not_failed", "Only a failed report can be re-rendered.")
    job_key = await reports.retry(db, report, actor(admin))
    await db.commit()
    order = await db.get(ReportOrder, report.order_id) if report.order_id else None
    item = _admin_item(report, 0, None, order.pay_with if order else None)
    return {**item, "job_key": job_key}
