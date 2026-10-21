"""Paid reports: every money path (docs/api/revenue.md §2.1, §2.2; ADR-0002, ADR-0009).
Written before the implementation (PLAN.md §0.3).

- wallet: charged once with `report:{order_id}:paid`, the report and its render job are created
  in the same transaction, a retry never charges again, 402 writes nothing;
- Razorpay: only the signed webhook pays; `razorpay:payment:{id}:captured` debits gateway
  clearing and credits `platform:report_revenue`; replays and a second payment never credit;
  the dev simulate endpoint works for report orders;
- final render failure: refunded once (`refund:report:{id}`), to the same buckets for wallet
  orders and as real wallet credit for card-paid orders.
"""

import asyncio
import datetime as dt
import importlib.util
import json
import time
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
import redis as sync_redis
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import payments, reports, wallet
from astro_api.config import Settings
from astro_api.db import make_sessionmaker

pytestmark = pytest.mark.integration

USER = "+919822220001"
OTHER = "+919822220002"
HOOK = "/v1/payments/razorpay/webhook"
FIXTURES = Path(__file__).parent / "fixtures"


def recorder() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "record_report_engine", FIXTURES / "record_report_engine.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    """Serve recorded engine responses; freeze the snapshot date to the recording's."""
    rec = recorder()
    monkeypatch.setattr(reports, "ENGINE_TRANSPORT", rec.replay_transport())
    monkeypatch.setattr(reports, "snapshot_as_of", lambda: rec.AS_OF)
    return rec


@pytest.fixture
def me(login):  # type: ignore[no-untyped-def]
    return login(USER)


def settings_of(client: TestClient) -> Settings:
    s: Settings = client.app.state.settings  # type: ignore[attr-defined]
    return s


def sql(client: TestClient, query: str, **params: Any) -> list[Any]:
    async def run() -> list[Any]:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with eng.begin() as conn:
                return list((await conn.execute(text(query), params)).all())
        finally:
            await eng.dispose()

    return asyncio.run(run())


def scalar(client: TestClient, query: str, **params: Any) -> Any:
    rows = sql(client, query, **params)
    return rows[0][0] if rows else None


def account(client: TestClient, account_id: str) -> int:
    async def run() -> int:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with make_sessionmaker(eng)() as db:
                return await wallet.account_balance(db, account_id)
        finally:
            await eng.dispose()

    return asyncio.run(run())


def user_id(client: TestClient, phone: str) -> uuid.UUID:
    value = scalar(client, "SELECT id FROM users WHERE phone = :p", p=phone)
    assert value is not None
    return uuid.UUID(str(value))


def fund(client: TestClient, headers: dict[str, str], amount: int) -> None:
    r = client.post(
        "/v1/wallet/recharge-orders",
        json={"amount_paise": amount},
        headers={**headers, "Idempotency-Key": uuid.uuid4().hex},
    )
    assert r.status_code == 201, r.text
    r = client.post(
        f"/v1/dev/payments/{r.json()['id']}/simulate", json={"outcome": "captured"}, headers=headers
    )
    assert r.json()["status"] == "processed", r.text


def grant_promo(client: TestClient, uid: uuid.UUID, amount: int) -> None:
    async def run() -> None:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with make_sessionmaker(eng)() as db:
                await wallet.grant_promo(
                    db,
                    user_id=uid,
                    amount_paise=amount,
                    campaign="test",
                    key=f"promo:test:{uuid.uuid4()}",
                    expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=5),
                )
                await db.commit()
        finally:
            await eng.dispose()

    asyncio.run(run())


def kundli(client: TestClient, headers: dict[str, str], rec: ModuleType, who: str = "a") -> str:
    spec = rec.PERSON_A if who == "a" else rec.PERSON_B
    body = {
        "name": spec["label"],
        "birth": {
            "date": spec["date"],
            "time": spec["time"],
            "place": {
                "lat": spec["lat"],
                "lon": spec["lon"],
                "tz": spec["tz"],
                "label": spec["place_name"],
            },
        },
    }
    r = client.post("/v1/kundlis", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def order(
    client: TestClient,
    headers: dict[str, str],
    kundli_ids: list[str],
    pay_with: str = "wallet",
    key: str | None = None,
    sku: str = "kundli_report",
    **extra: Any,
) -> Any:
    return client.post(
        "/v1/reports/orders",
        json={
            "sku": sku,
            "language": "en",
            "kundli_ids": kundli_ids,
            "pay_with": pay_with,
            **extra,
        },
        headers={**headers, "Idempotency-Key": key or uuid.uuid4().hex},
    )


def webhook(
    client: TestClient, *, order_id: str, payment_id: str, amount: int, event_id: str, kind: str
) -> Any:
    status = "failed" if kind == "payment.failed" else "captured"
    body = {
        "entity": "event",
        "account_id": "acc_test",
        "event": kind,
        "contains": ["payment"],
        "payload": {
            "payment": {
                "entity": {
                    "id": payment_id,
                    "entity": "payment",
                    "amount": amount,
                    "currency": "INR",
                    "status": status,
                    "order_id": order_id,
                    "method": "upi",
                    "created_at": int(time.time()),
                }
            }
        },
        "created_at": int(time.time()),
    }
    raw = json.dumps(body).encode()
    sig = payments.sign(payments.webhook_secret(settings_of(client)), raw)
    return client.post(
        HOOK,
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-Razorpay-Signature": sig,
            "X-Razorpay-Event-Id": event_id,
        },
    )


def fail_and_refund(client: TestClient, report_id: str) -> bool:
    async def run() -> bool:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with make_sessionmaker(eng)() as db:
                created = await reports.fail_and_refund(
                    db, uuid.UUID(report_id), "render_timeout", dt.datetime.now(dt.UTC)
                )
                await db.commit()
                return created
        finally:
            await eng.dispose()

    return asyncio.run(run())


PRICE = 49900  # kundli_report in data/marketplace/products.json


# ------------------------------------------------------------------ wallet


def test_wallet_order_charges_once_and_queues_the_render(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    fund(client, me, 100000)
    kid = kundli(client, me, engine)
    r = order(client, me, [kid], key="wallet-order-0001")
    assert r.status_code == 201, r.text
    o = r.json()
    assert (o["status"], o["pay_with"], o["price_paise"]) == ("paid", "wallet", PRICE)
    assert o["provider_order_id"] is None and o["report_id"] and o["paid_at"]
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 100000 - PRICE
    assert account(client, wallet.REPORT_REVENUE) == PRICE
    key = f"report:{o['id']}:paid"
    assert (
        scalar(client, "SELECT count(*) FROM ledger_transactions WHERE idempotency_key=:k", k=key)
        == 1
    )
    job = sql(
        client,
        "SELECT kind, payload, status FROM jobs WHERE key = :k",
        k=f"report:{o['report_id']}:render",
    )
    assert job == [("report_render", {"report_id": o["report_id"]}, "queued")]
    # The order keeps no snapshot once the report holds it.
    assert scalar(client, "SELECT snapshot FROM report_orders WHERE id = :i", i=o["id"]) is None

    again = order(client, me, [kid], key="wallet-order-0001")
    assert (again.status_code, again.json()) == (201, o)
    # Redis forgot the key: Postgres still returns the same order and never charges twice.
    r = sync_redis.Redis.from_url(settings_of(client).redis_url.get_secret_value())
    r.flushdb()
    r.close()
    again = order(client, me, [kid], key="wallet-order-0001")
    assert again.status_code == 201 and again.json()["id"] == o["id"]
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 100000 - PRICE
    assert scalar(client, "SELECT count(*) FROM reports") == 1
    conflict = order(client, me, [kid], key="wallet-order-0001", pay_with="razorpay")
    assert conflict.status_code == 409


def test_wallet_order_without_funds_is_402_and_writes_nothing(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    fund(client, me, 10000)
    kid = kundli(client, me, engine)
    r = order(client, me, [kid])
    assert r.status_code == 402, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "insufficient_funds"
    assert (detail["required_paise"], detail["available_paise"]) == (PRICE, 10000)
    for table in ("report_orders", "reports", "jobs"):
        assert scalar(client, f"SELECT count(*) FROM {table}") == 0  # noqa: S608
    assert scalar(client, "SELECT count(*) FROM ledger_transactions WHERE kind='purchase'") == 0
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 10000


# ------------------------------------------------------------------ Razorpay


def test_razorpay_order_is_paid_only_by_the_webhook_once(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    kid = kundli(client, me, engine)
    r = order(client, me, [kid], pay_with="razorpay")
    assert r.status_code == 201, r.text
    o = r.json()
    assert o["status"] == "created" and o["report_id"] is None
    assert o["provider_order_id"].startswith("order_") and o["key_id"] == payments.FAKE_KEY_ID
    assert scalar(client, "SELECT count(*) FROM reports") == 0
    assert scalar(client, "SELECT count(*) FROM jobs") == 0

    sim = client.post(
        f"/v1/dev/payments/{o['id']}/simulate", json={"outcome": "captured"}, headers=me
    )
    assert sim.status_code == 200 and sim.json()["status"] == "processed", sim.text
    pid = sim.json()["provider_payment_id"]
    paid = client.get(f"/v1/reports/orders/{o['id']}", headers=me).json()
    assert paid["status"] == "paid" and paid["report_id"]
    key = f"razorpay:payment:{pid}:captured"
    rows = sql(
        client,
        "SELECT e.account_id, e.direction, e.amount_paise FROM ledger_entries e"
        " JOIN ledger_transactions t ON t.id = e.transaction_id"
        " WHERE t.idempotency_key = :k ORDER BY e.direction",
        k=key,
    )
    assert sorted(rows) == sorted(
        [(wallet.REPORT_REVENUE, "credit", PRICE), (wallet.CLEARING, "debit", PRICE)]
    )
    assert client.get("/v1/wallet", headers=me).json()["total_paise"] == 0
    assert (
        scalar(
            client,
            "SELECT count(*) FROM jobs WHERE key = :k",
            k=f"report:{paid['report_id']}:render",
        )
        == 1
    )

    again = client.post(
        f"/v1/dev/payments/{o['id']}/simulate", json={"outcome": "captured"}, headers=me
    )
    assert again.status_code == 409 and again.json()["detail"]["code"] == "order_already_paid"
    # The same webhook delivered five more times: one credit.
    for _ in range(5):
        w = webhook(
            client,
            order_id=o["provider_order_id"],
            payment_id=pid,
            amount=PRICE,
            event_id="evt_report_replay",
            kind="payment.captured",
        )
        assert w.status_code == 200
    assert account(client, wallet.REPORT_REVENUE) == PRICE
    assert scalar(client, "SELECT count(*) FROM reports") == 1


def test_second_payment_on_a_paid_report_order_is_never_credited(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    kid = kundli(client, me, engine)
    o = order(client, me, [kid], pay_with="razorpay").json()
    first = webhook(
        client,
        order_id=o["provider_order_id"],
        payment_id="pay_first0000001",
        amount=PRICE,
        event_id="evt_r1",
        kind="payment.captured",
    )
    assert first.json()["status"] == "processed"
    second = webhook(
        client,
        order_id=o["provider_order_id"],
        payment_id="pay_second000002",
        amount=PRICE,
        event_id="evt_r2",
        kind="payment.captured",
    )
    assert second.json()["status"] == "duplicate_payment"
    assert account(client, wallet.REPORT_REVENUE) == PRICE
    assert scalar(client, "SELECT count(*) FROM reports") == 1
    assert (
        scalar(
            client,
            "SELECT count(*) FROM ledger_transactions"
            " WHERE idempotency_key LIKE 'razorpay:payment:%'",
        )
        == 1
    )


def test_report_payment_mismatch_and_failure(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    kid = kundli(client, me, engine)
    o = order(client, me, [kid], pay_with="razorpay").json()
    bad = webhook(
        client,
        order_id=o["provider_order_id"],
        payment_id="pay_wrongamount1",
        amount=PRICE - 1,
        event_id="evt_m1",
        kind="payment.captured",
    )
    assert bad.json()["status"] == "mismatch"
    failed = webhook(
        client,
        order_id=o["provider_order_id"],
        payment_id="pay_failed000001",
        amount=PRICE,
        event_id="evt_f1",
        kind="payment.failed",
    )
    assert failed.json()["status"] == "processed"
    assert client.get(f"/v1/reports/orders/{o['id']}", headers=me).json()["status"] == "failed"
    assert account(client, wallet.REPORT_REVENUE) == 0
    # The customer retries on the same Razorpay order and pays: now it is paid.
    ok = webhook(
        client,
        order_id=o["provider_order_id"],
        payment_id="pay_retryok00001",
        amount=PRICE,
        event_id="evt_ok",
        kind="payment.captured",
    )
    assert ok.json()["status"] == "processed"
    assert client.get(f"/v1/reports/orders/{o['id']}", headers=me).json()["status"] == "paid"
    assert account(client, wallet.REPORT_REVENUE) == PRICE


def test_simulate_is_refused_for_someone_elses_report_order(  # type: ignore[no-untyped-def]
    client: TestClient, me, login, engine
) -> None:
    kid = kundli(client, me, engine)
    o = order(client, me, [kid], pay_with="razorpay").json()
    r = client.post(
        f"/v1/dev/payments/{o['id']}/simulate", json={"outcome": "captured"}, headers=login(OTHER)
    )
    assert r.status_code == 404


# ------------------------------------------------------------------ refunds on final failure


def test_final_failure_refunds_a_wallet_order_once_to_the_same_buckets(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine, admin_headers
) -> None:
    fund(client, me, 30000)
    uid = user_id(client, USER)
    grant_promo(client, uid, 30000)
    o = order(client, me, [kundli(client, me, engine)]).json()
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["promo_paise"], w["real_paise"]) == (0, 30000 + 30000 - PRICE)

    assert fail_and_refund(client, o["report_id"]) is True
    assert fail_and_refund(client, o["report_id"]) is False
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["real_paise"], w["promo_paise"]) == (30000, 30000)
    assert account(client, wallet.REPORT_REVENUE) == 0
    rep = client.get(f"/v1/reports/{o['report_id']}", headers=me).json()
    assert rep["status"] == "failed" and rep["download_url"] is None
    key = f"refund:report:{o['report_id']}"
    assert (
        scalar(client, "SELECT count(*) FROM ledger_transactions WHERE idempotency_key=:k", k=key)
        == 1
    )
    detail = scalar(
        client,
        "SELECT detail FROM audit_log WHERE action = 'report_refunded' AND entity_id = :i",
        i=o["report_id"],
    )
    assert detail == {"order_id": o["id"], "amount_paise": PRICE, "pay_with": "wallet"}

    # An admin re-render after the refund is free; failing again never refunds twice.
    retry = client.post(
        f"/v1/admin/reports/{o['report_id']}/retry",
        json={"charge_again": False},
        headers=admin_headers,
    )
    assert retry.status_code == 200, retry.text
    assert fail_and_refund(client, o["report_id"]) is False
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 30000


def test_final_failure_refunds_a_card_paid_order_as_wallet_credit_once(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    o = order(client, me, [kundli(client, me, engine)], pay_with="razorpay").json()
    client.post(f"/v1/dev/payments/{o['id']}/simulate", json={"outcome": "captured"}, headers=me)
    report_id = client.get(f"/v1/reports/orders/{o['id']}", headers=me).json()["report_id"]

    async def twice_concurrently() -> list[bool]:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        maker = make_sessionmaker(eng)

        async def one() -> bool:
            async with maker() as db:
                created = await reports.fail_and_refund(
                    db, uuid.UUID(report_id), "render_failed", dt.datetime.now(dt.UTC)
                )
                await db.commit()
                return created

        try:
            return list(await asyncio.gather(one(), one()))
        finally:
            await eng.dispose()

    assert sorted(asyncio.run(twice_concurrently())) == [False, True]
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["real_paise"], w["promo_paise"]) == (PRICE, 0)
    assert account(client, wallet.REPORT_REVENUE) == 0
    kinds = sql(
        client,
        "SELECT kind FROM ledger_transactions WHERE idempotency_key = :k",
        k=f"refund:report:{report_id}",
    )
    assert kinds == [("purchase_refund",)]
    txns = client.get("/v1/wallet/transactions", headers=me).json()["items"]
    assert [(t["kind"], t["amount_paise"]) for t in txns] == [("refund", PRICE)]


def test_a_ready_report_is_never_refunded(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine
) -> None:
    fund(client, me, PRICE)
    o = order(client, me, [kundli(client, me, engine)]).json()
    sql(
        client,
        "UPDATE reports SET status = 'ready', ready_at = now() WHERE id = :i RETURNING id",
        i=o["report_id"],
    )
    assert fail_and_refund(client, o["report_id"]) is False
    assert client.get("/v1/wallet", headers=me).json()["total_paise"] == 0
    assert client.get(f"/v1/reports/{o['report_id']}", headers=me).json()["status"] == "ready"


# ------------------------------------------------------------------ Checkout result (never credits)


def test_checkout_result_is_verified_recorded_and_never_credits(  # type: ignore[no-untyped-def]
    client: TestClient, me, login, engine
) -> None:
    kid = kundli(client, me, engine)
    o = order(client, me, [kid], pay_with="razorpay").json()
    assert (o["provider"], o["currency"]) == ("fake", "INR")
    url = f"/v1/reports/orders/{o['id']}/checkout-result"
    bad = client.post(
        url,
        json={"provider_payment_id": "pay_abc12345", "provider_signature": "0" * 64},
        headers=me,
    )
    assert (bad.status_code, bad.json()["detail"]["code"]) == (400, "invalid_signature")
    good_sig = payments.sign(
        payments.checkout_secret(settings_of(client)),
        f"{o['provider_order_id']}|pay_abc12345".encode(),
    )
    body = {"provider_payment_id": "pay_abc12345", "provider_signature": good_sig}
    assert client.post(url, json=body, headers=login(OTHER)).status_code == 404
    ok = client.post(url, json=body, headers=me)
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "created" and ok.json()["report_id"] is None
    recorded = sql(
        client,
        "SELECT checkout_payment_id, checkout_verified FROM report_orders WHERE id = :i",
        i=o["id"],
    )
    assert recorded == [("pay_abc12345", True)]
    assert account(client, wallet.REPORT_REVENUE) == 0
    assert scalar(client, "SELECT count(*) FROM reports") == 0
    # A wallet order has nothing to check out.
    fund(client, me, PRICE)
    w = order(client, me, [kid]).json()
    assert (w["provider"], w["currency"]) == (None, "INR")
    r = client.post(f"/v1/reports/orders/{w['id']}/checkout-result", json=body, headers=me)
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "not_a_card_order")


def test_get_order_is_owner_only(client: TestClient, me, login, engine) -> None:  # type: ignore[no-untyped-def]
    o = order(client, me, [kundli(client, me, engine)], pay_with="razorpay").json()
    assert client.get(f"/v1/reports/orders/{o['id']}", headers=me).json() == o
    assert client.get(f"/v1/reports/orders/{o['id']}", headers=login(OTHER)).status_code == 404
    assert client.get(f"/v1/reports/orders/{uuid.uuid4()}", headers=me).status_code == 404


def test_card_paid_and_wallet_paid_reports_reconcile_with_zero_drift(  # type: ignore[no-untyped-def]
    client: TestClient, me, admin_headers, engine
) -> None:
    """A card-paid report is a gateway payment like a recharge: reconciliation must match it
    to its purchase posting, not report it as a missing credit."""
    from astro_api.earnings import ist_today

    kid = kundli(client, me, engine)
    card = order(client, me, [kid], pay_with="razorpay").json()
    r = client.post(
        f"/v1/dev/payments/{card['id']}/simulate", json={"outcome": "captured"}, headers=me
    )
    assert r.status_code == 200, r.text
    fund(client, me, 60000)
    assert order(client, me, [kid]).status_code == 201
    run = client.post(
        "/v1/admin/money/reconciliation/run",
        json={"date": ist_today().isoformat()},
        headers=admin_headers,
    ).json()
    assert run["status"] == "ok" and run["drift_paise"] == 0, run
    payments = next(c for c in run["checks"] if c["name"] == "gateway_payments")
    assert payments["count"] == 2  # the card payment and the wallet recharge
