"""Paid reports service (docs/api/revenue.md §2, ADR-0009).

- Products and the sample birth come from data/marketplace/products.json.
- Snapshot: the astro engine's raw JSON for every section of the report, fetched over HTTP when
  the order is created and frozen on the report when it is paid. Values are never computed,
  rounded or altered here (PLAN.md §0.4).
- Signatures: short-lived HMAC links for the renderer (`render`) and downloads (`file`).
- Money: wallet orders through `wallet.charge_purchase`; Razorpay orders credit
  `platform:report_revenue` from the webhook; a final render failure refunds once.

Never logs birth details, names or emails: ids and codes only.
"""

import asyncio
import datetime as dt
import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import jobs, payments, wallet
from astro_api.audit import audit
from astro_api.chat_crypto import Sealed, cipher_from_settings
from astro_api.config import Settings
from astro_api.models import SavedKundli
from astro_api.models_ledger import LedgerTransaction
from astro_api.models_reports import Report, ReportOrder
from astro_api.shared_files import data_dir, marketplace_dir

log = logging.getLogger("astro_api.reports")


ENGINE_TIMEOUT_S = 20.0
# Tests replace this with an httpx.MockTransport that serves recorded engine responses.
ENGINE_TRANSPORT: httpx.AsyncBaseTransport | None = None
_LATIN_NAME = re.compile(r"^[A-Za-z][A-Za-z\s\-'.]*$")

TITLES = {
    ("kundli_report", "en"): "Kundli report",
    ("kundli_report", "hi"): "कुंडली रिपोर्ट",
    ("matching_report", "en"): "Kundli matching report",
    ("matching_report", "hi"): "कुंडली मिलान रिपोर्ट",
}


# ------------------------------------------------------------------ products


@cache
def products() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (marketplace_dir() / "products.json").read_text(encoding="utf-8")
    )
    return data


def report_product(sku: str) -> dict[str, Any] | None:
    found: dict[str, Any] | None = products()["reports"].get(sku)
    return found


def product_list() -> list[dict[str, Any]]:
    return [
        {
            "sku": sku,
            "price_paise": int(p["price_paise"]),
            "languages": list(p["languages"]),
            "pages_estimate": int(p["pages_estimate"]),
        }
        for sku, p in products()["reports"].items()
    ]


def download_ttl_s() -> int:
    return int(products()["report_download_ttl_s"])


def render_ttl_s() -> int:
    return int(products()["report_render_ttl_s"])


# ------------------------------------------------------------------ signatures


def _sig_key(settings: Settings) -> bytes:
    secret = settings.secret_key.get_secret_value().encode()
    return hmac.new(secret, b"report-links", hashlib.sha256).digest()


def sign(settings: Settings, purpose: str, report_id: uuid.UUID, ttl_s: int) -> str:
    """`{expiry}.{hex HMAC(purpose:id:expiry)}`; purpose is `render` or `file`."""
    expires = int(time.time()) + ttl_s
    mac = hmac.new(
        _sig_key(settings), f"{purpose}:{report_id}:{expires}".encode(), hashlib.sha256
    ).hexdigest()
    return f"{expires}.{mac}"


def check(
    settings: Settings, purpose: str, report_id: uuid.UUID, sig: str | None
) -> Literal["ok", "invalid", "expired"]:
    """`expired` only for a genuine signature past its expiry; anything else wrong is `invalid`."""
    if not sig or "." not in sig:
        return "invalid"
    raw_exp, _, mac = sig.partition(".")
    if not raw_exp.isdigit():
        return "invalid"
    expected = hmac.new(
        _sig_key(settings), f"{purpose}:{report_id}:{raw_exp}".encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, mac):
        return "invalid"
    return "expired" if int(raw_exp) < time.time() else "ok"


def verify(settings: Settings, purpose: str, report_id: uuid.UUID, sig: str | None) -> bool:
    return check(settings, purpose, report_id, sig) == "ok"


def download_url(settings: Settings, report_id: uuid.UUID) -> str:
    return f"/v1/reports/{report_id}/file?sig={sign(settings, 'file', report_id, download_ttl_s())}"


def print_url(settings: Settings, report_id: uuid.UUID) -> str:
    """The web app's private print page the worker turns into a PDF."""
    sig = sign(settings, "render", report_id, render_ttl_s())
    return f"{settings.web_internal_url.rstrip('/')}/print/reports/{report_id}?sig={sig}"


# ------------------------------------------------------------------ email at rest


def email_aad(order_id: uuid.UUID) -> bytes:
    return f"report_order:{order_id}:email".encode()


def seal_email(settings: Settings, order: ReportOrder, address: str) -> None:
    sealed = cipher_from_settings(settings).encrypt(address, email_aad(order.id))
    order.email_ciphertext, order.email_nonce, order.email_key_id = (
        sealed.ciphertext,
        sealed.nonce,
        sealed.key_id,
    )


def open_email(settings: Settings, order: ReportOrder) -> str | None:
    if order.email_ciphertext is None or order.email_nonce is None or not order.email_key_id:
        return None
    sealed = Sealed(order.email_ciphertext, order.email_nonce, order.email_key_id)
    return cipher_from_settings(settings).decrypt(sealed, email_aad(order.id))


def erase_email(order: ReportOrder) -> None:
    order.email_ciphertext = order.email_nonce = order.email_key_id = None


# ------------------------------------------------------------------ snapshot (engine outputs)


class EngineUnavailable(Exception):
    """The engine could not be reached or refused a request. Message holds a path/status only."""


@dataclass(frozen=True)
class BirthInput:
    label: str
    date: dt.date
    time: dt.time | None
    place_name: str | None
    lat: float
    lon: float
    tz: str
    utc_offset: str | None = None


def birth_from_kundli(k: SavedKundli) -> BirthInput:
    # The saved offset pins the instant exactly as it was resolved when the kundli was saved
    # (it also settles DST-ambiguous times), so the engine computes the same chart.
    return BirthInput(
        label=k.name,
        date=k.birth_date,
        time=k.birth_time,
        # The print page needs a place name; without a saved label, show the coordinates.
        place_name=(k.place_label or "").strip() or f"{k.lat:.4f}, {k.lon:.4f}",
        lat=k.lat,
        lon=k.lon,
        tz=k.tz,
        utc_offset=k.utc_offset,
    )


def engine_url(settings: Settings) -> str:
    return settings.astro_url


def engine_client(settings: Settings) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=engine_url(settings), timeout=ENGINE_TIMEOUT_S, transport=ENGINE_TRANSPORT
    )


def _engine_birth(b: BirthInput) -> dict[str, Any]:
    body: dict[str, Any] = {
        "date": b.date.isoformat(),
        "time": b.time.isoformat() if b.time is not None else None,
        "place": {"lat": b.lat, "lon": b.lon, "tz": b.tz},
    }
    if b.utc_offset:
        body["utc_offset"] = b.utc_offset
    return body


async def _call(
    http: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        r = await http.request(method, path, json=json_body, params=params)
    except httpx.HTTPError as exc:
        raise EngineUnavailable(f"{path}: {type(exc).__name__}") from exc
    if r.status_code != 200:
        raise EngineUnavailable(f"{path}: HTTP {r.status_code}")
    data = r.json()
    if not isinstance(data, dict):
        raise EngineUnavailable(f"{path}: not an object")
    return data


def latin_name(name: str) -> bool:
    return bool(_LATIN_NAME.fullmatch(name.strip()))


async def _kundli_section(http: httpx.AsyncClient, b: BirthInput, as_of: dt.date) -> dict[str, Any]:
    birth = _engine_birth(b)
    numerology: Any = None
    calls: list[Any] = [
        _call(http, "POST", "/v1/kundli", json_body={"birth": birth}),
        _call(http, "POST", "/v1/dasha", json_body={"birth": birth, "as_of": as_of.isoformat()}),
        _call(http, "POST", "/v1/doshas", json_body={"birth": birth, "as_of": as_of.isoformat()}),
        _call(
            http,
            "GET",
            "/v1/panchang",
            params={"lat": b.lat, "lon": b.lon, "tz": b.tz, "date": b.date.isoformat()},
        ),
    ]
    if latin_name(b.label):
        calls.append(
            _call(
                http,
                "POST",
                "/v1/numerology",
                json_body={"name": b.label.strip(), "date_of_birth": b.date.isoformat()},
            )
        )
    results = await asyncio.gather(*calls)
    kundli, dasha, doshas, panchang = results[:4]
    if len(results) > 4:
        numerology = results[4]
    return {
        "label": b.label,
        "birth": {
            "date": b.date.isoformat(),
            "time": b.time.isoformat(timespec="minutes") if b.time is not None else None,
            "place": {"name": b.place_name, "lat": b.lat, "lon": b.lon, "tz": b.tz},
        },
        "kundli": kundli,
        "dasha": dasha,
        "doshas": doshas,
        "numerology": numerology,
        "panchang": panchang,
    }


async def build_snapshot(
    http: httpx.AsyncClient, sku: str, births: list[BirthInput], as_of: dt.date
) -> dict[str, Any]:
    """Every engine output the report shows. `as_of` fixes the "current" dasha and Sade Sati.
    For matching, births[0] is sent as the engine's `groom` and births[1] as `bride`."""
    needed = 2 if sku == "matching_report" else 1
    if len(births) != needed:
        raise ValueError(f"{sku} needs {needed} birth(s)")
    tasks: list[Any] = [_kundli_section(http, b, as_of) for b in births]
    tasks.append(_call(http, "GET", "/v1/meta"))
    if sku == "matching_report":
        tasks.append(
            _call(
                http,
                "POST",
                "/v1/match",
                json_body={"groom": _engine_birth(births[0]), "bride": _engine_birth(births[1])},
            )
        )
    results = await asyncio.gather(*tasks)
    kundlis = results[: len(births)]
    meta = results[len(births)]
    match = results[len(births) + 1] if sku == "matching_report" else None
    return {"kundlis": kundlis, "match": match, "meta": meta}


def snapshot_as_of() -> dt.date:
    """The date the snapshot's "current" dasha and Sade Sati are computed for (UTC today)."""
    return dt.datetime.now(dt.UTC).date()


def engine_version(snapshot: dict[str, Any]) -> str:
    return str(snapshot["meta"].get("version", "unknown"))


def title(report: Report) -> str:
    base = TITLES[(report.sku, report.language)]
    labels = [str(k.get("label", "")) for k in report.snapshot.get("kundlis", [])]
    joiner = " & " if report.language == "en" else " और "
    return f"{base}: {joiner.join(labels)}" if labels else base


def render_data(report: Report) -> dict[str, Any]:
    return {
        "report": {
            "id": str(report.id),
            "sku": report.sku,
            "language": report.language,
            "created_at": report.created_at.isoformat(),
            "engine_version": report.engine_version,
        },
        "snapshot": report.snapshot,
    }


# ------------------------------------------------------------------ sample report


@cache
def _cities() -> dict[str, dict[str, Any]]:
    path = data_dir().parent / "seo" / "cities.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {str(c["slug"]): c for c in raw["cities"]}


def _sample_birth(spec: dict[str, Any], language: str) -> BirthInput:
    city = _cities()[str(spec["city_slug"])]
    return BirthInput(
        label=str(spec["label"]),
        date=dt.date.fromisoformat(str(spec["date"])),
        time=dt.time.fromisoformat(str(spec["time"])) if spec.get("time") else None,
        place_name=str(city["name_hi" if language == "hi" else "name_en"]),
        lat=float(city["lat"]),
        lon=float(city["lon"]),
        tz=str(city["tz"]),
    )


def sample_births(sku: str, language: str) -> list[BirthInput] | None:
    """The fictional sample input(s) from products.json, or None when the product has none.
    A matching sample needs a second fictional birth (`sample_partner_birth`)."""
    p = products()
    births = [p["sample_birth"]]
    if sku == "matching_report":
        if "sample_partner_birth" not in p:
            return None
        births.append(p["sample_partner_birth"])
    return [_sample_birth(spec, language) for spec in births]


def sample_key(sku: str, language: str) -> str:
    p = products()
    spec = {"a": p["sample_birth"], "b": p.get("sample_partner_birth")}
    digest = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()[:16]
    return f"{sku}:{language}:{digest}"


# ------------------------------------------------------------------ state changes (money)


def render_job_key(report_id: uuid.UUID, n: int) -> str:
    return f"report:{report_id}:render" if n == 0 else f"report:{report_id}:render:{n}"


def paid_key(order_id: uuid.UUID) -> str:
    return f"report:{order_id}:paid"


def refund_key(report_id: uuid.UUID) -> str:
    return f"refund:report:{report_id}"


async def mark_paid(db: AsyncSession, order: ReportOrder, now: dt.datetime) -> Report:
    """Create the report from the order's snapshot and queue its render, in the caller's
    transaction (the same one that took the money). Idempotent: a paid order returns its report."""
    if order.report_id is not None:
        existing = await db.get(Report, order.report_id)
        assert existing is not None
        return existing
    assert order.snapshot is not None
    report_id = uuid.uuid4()
    report = Report(
        id=report_id,
        user_id=order.user_id,
        order_id=order.id,
        sku=order.sku,
        language=order.language,
        status="queued",
        snapshot=order.snapshot,
        engine_version=order.engine_version,
        render_n=0,
        render_job_key=render_job_key(report_id, 0),
        created_at=now,
    )
    db.add(report)
    await db.flush()
    order.status = "paid"
    order.paid_at = order.paid_at or now
    order.report_id = report_id
    order.snapshot = None  # the report holds the only copy from now on
    await jobs.enqueue(
        db, "report_render", {"report_id": str(report_id)}, render_job_key(report_id, 0)
    )
    return report


async def order_for_provider_id(db: AsyncSession, provider_order_id: Any) -> ReportOrder | None:
    if not isinstance(provider_order_id, str):
        return None
    order: ReportOrder | None = (
        await db.execute(
            select(ReportOrder)
            .where(ReportOrder.provider_order_id == provider_order_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    return order


async def credit_razorpay_payment(
    db: AsyncSession,
    *,
    order: ReportOrder,
    payment_id: str,
    amount_paise: int,
    occurred_at: dt.datetime,
) -> wallet.Posted:
    """A captured card/UPI payment for a report: debit gateway clearing, credit
    `platform:report_revenue`. Key `razorpay:payment:{payment_id}:captured` (one credit per
    payment, ever). The user's wallet is not touched."""
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    key = f"razorpay:payment:{payment_id}:captured"
    payload_hash = wallet._hash(
        {"order_id": order.id, "payment_id": payment_id, "amount": amount_paise}
    )
    if (tx := await wallet._existing(db, key, payload_hash)) is not None:
        return wallet.Posted(tx.id, False)
    tid = await wallet._insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="purchase",
        user_id=order.user_id,
        external_ref=payment_id,
        occurred_at=occurred_at,
    )
    if tid is None:
        tx = await wallet._existing(db, key, payload_hash)
        assert tx is not None
        return wallet.Posted(tx.id, False)
    await wallet._write(
        db,
        tid,
        [
            wallet._Posting(wallet.CLEARING, "debit", amount_paise),
            wallet._Posting(wallet.REPORT_REVENUE, "credit", amount_paise),
        ],
    )
    return wallet.Posted(tid, True)


async def refund_razorpay_to_wallet(
    db: AsyncSession, *, order: ReportOrder, report_id: uuid.UUID
) -> wallet.Posted:
    """Refund a card-paid report as wallet credit: debit `platform:report_revenue`, credit
    `user:{id}:real` by the order's price. Key `refund:report:{report_id}`; once only."""
    assert order.provider_payment_id is not None
    original = (
        await db.execute(
            select(LedgerTransaction).where(
                LedgerTransaction.idempotency_key
                == f"razorpay:payment:{order.provider_payment_id}:captured"
            )
        )
    ).scalar_one_or_none()
    if original is None:
        raise LookupError(f"payment for order {order.id}")
    key = refund_key(report_id)
    payload_hash = wallet._hash({"refunds": original.id, "amount": order.price_paise})
    if (tx := await wallet._existing(db, key, payload_hash)) is not None:
        return wallet.Posted(tx.id, False)
    await wallet.lock_user(db, order.user_id)
    if (tx := await wallet._existing(db, key, payload_hash)) is not None:
        return wallet.Posted(tx.id, False)
    tid = await wallet._insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="purchase_refund",
        user_id=order.user_id,
        external_ref=f"report:{report_id}",
        reverses_id=original.id,
    )
    assert tid is not None  # we hold the user's lock and checked the key under it
    await wallet._write(
        db,
        tid,
        [
            wallet._Posting(wallet.REPORT_REVENUE, "debit", order.price_paise),
            wallet._Posting(wallet.real_account(order.user_id), "credit", order.price_paise),
        ],
    )
    return wallet.Posted(tid, True)


async def fail_and_refund(
    db: AsyncSession, report_id: uuid.UUID, error_code: str | None, now: dt.datetime
) -> bool:
    """A render is out of attempts: mark the report failed and refund the buyer once (same
    buckets for wallet orders, wallet real credit for Razorpay orders). Samples are not
    refunded. Returns True when a refund was posted now. Caller commits."""
    report = (
        await db.execute(select(Report).where(Report.id == report_id).with_for_update())
    ).scalar_one_or_none()
    if report is None or report.status == "ready":
        return False
    if report.status != "failed":
        report.status = "failed"
        report.failed_at = now
        report.last_error_code = (error_code or report.last_error_code or "render_failed")[:64]
        # Alert (error level, ids only): an admin can retry it from /v1/admin/reports.
        log.error(
            "report_failed",
            extra={"report_id": str(report.id), "code": report.last_error_code, "sku": report.sku},
        )
    if report.order_id is None or report.user_id is None:
        return False
    order = await db.get(ReportOrder, report.order_id)
    assert order is not None
    if order.email_ciphertext is not None:
        erase_email(order)  # never sent; not kept
    if order.pay_with == "wallet":
        posted: wallet.Purchase | wallet.Posted = await wallet.refund_purchase(
            db, user_id=order.user_id, key=refund_key(report.id), original_key=paid_key(order.id)
        )
    else:
        posted = await refund_razorpay_to_wallet(db, order=order, report_id=report.id)
    report.refunded_at = report.refunded_at or now
    if posted.created:
        audit(
            db,
            "system",
            "report_refunded",
            "report",
            str(report.id),
            order_id=str(order.id),
            amount_paise=order.price_paise,
            pay_with=order.pay_with,
        )
    return posted.created


# ------------------------------------------------------------------ Razorpay webhook glue


async def razorpay_captured(
    db: AsyncSession, event_id: str, order: ReportOrder, payment: dict[str, Any]
) -> str:
    """`payment.captured` / `order.paid` for a report order (billing.md webhook rules)."""
    if payment.get("status") != "captured":
        return "ignored"
    amount, currency = payment.get("amount"), payment.get("currency")
    if not isinstance(amount, int) or amount != order.price_paise or currency != order.currency:
        log.error(
            "payment_mismatch",
            extra={
                "event_id": event_id,
                "report_order_id": str(order.id),
                "expected_paise": order.price_paise,
                "paid_paise": amount if isinstance(amount, int) else None,
                "expected_currency": order.currency,
                "paid_currency": str(currency)[:8],
            },
        )
        return "mismatch"
    payment_id = str(payment["id"])
    if order.status == "paid" and order.provider_payment_id not in (None, payment_id):
        # Paid twice: the order is credited once; support refunds the extra payment to the card.
        log.error(
            "duplicate_payment",
            extra={
                "event_id": event_id,
                "report_order_id": str(order.id),
                "payment_id": payment_id,
            },
        )
        return "duplicate_payment"
    now = dt.datetime.now(dt.UTC)
    await credit_razorpay_payment(
        db,
        order=order,
        payment_id=payment_id,
        amount_paise=amount,
        occurred_at=payments.epoch_to_dt(payment.get("created_at")) or now,
    )
    order.provider_payment_id = order.provider_payment_id or payment_id
    await mark_paid(db, order, now)
    return "processed"


def razorpay_failed(order: ReportOrder) -> str:
    if order.status != "paid":
        order.status = "failed"
        order.failed_at = dt.datetime.now(dt.UTC)
    return "processed"


# ------------------------------------------------------------------ sample and admin retry


async def get_or_create_sample(
    db: AsyncSession, settings: Settings, sku: str, language: str
) -> Report | None:
    """The cached public sample for sku+language (created and queued on first use). None when
    the product has no sample input. Commits when it creates one."""
    births = sample_births(sku, language)
    if births is None:
        return None
    key = sample_key(sku, language)
    found = (await db.execute(select(Report).where(Report.sample_key == key))).scalar_one_or_none()
    if found is not None:
        return found
    async with engine_client(settings) as http:
        snapshot = await build_snapshot(http, sku, births, snapshot_as_of())
    report_id = uuid.uuid4()
    inserted = (
        await db.execute(
            pg_insert(Report)
            .values(
                id=report_id,
                user_id=None,
                order_id=None,
                sample_key=key,
                sku=sku,
                language=language,
                status="queued",
                snapshot=snapshot,
                engine_version=engine_version(snapshot),
                render_n=0,
                render_job_key=render_job_key(report_id, 0),
            )
            .on_conflict_do_nothing(index_elements=["sample_key"])
            .returning(Report.id)
        )
    ).scalar_one_or_none()
    if inserted is not None:
        await jobs.enqueue(
            db, "report_render", {"report_id": str(report_id)}, render_job_key(report_id, 0)
        )
    await db.commit()
    sample: Report | None = (
        await db.execute(select(Report).where(Report.sample_key == key))
    ).scalar_one_or_none()
    return sample


async def retry(db: AsyncSession, report: Report, actor: str) -> str:
    """Re-queue a failed render under a new job key (`report:{id}:render:{n}`). Free of charge
    (a refunded report stays refunded). Audited with ids only. Caller commits."""
    report.render_n += 1
    key = render_job_key(report.id, report.render_n)
    report.render_job_key = key
    report.status = "queued"
    report.failed_at = None
    report.last_error_code = None
    await jobs.enqueue(db, "report_render", {"report_id": str(report.id)}, key)
    audit(
        db,
        actor,
        "report_retry",
        "report",
        str(report.id),
        render_n=report.render_n,
        refunded=report.refunded_at is not None,
        charge_again=False,
    )
    return key
