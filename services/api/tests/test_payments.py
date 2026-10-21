"""Recharge orders, Checkout verification and the Razorpay webhook (docs/api/billing.md).

Hard gates: the same webhook 5x (sequential and concurrent) gives one event row, one credit and
one bonus lot; a wrong signature or a mismatched amount never credits."""

import asyncio
import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import payments
from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.payments_webhooks import process_webhook

pytestmark = pytest.mark.integration

USER = "+919811110001"
HOOK = "/v1/payments/razorpay/webhook"


def sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def event(
    kind: str,
    *,
    order_id: str,
    payment_id: str,
    amount: int,
    currency: str = "INR",
    status: str = "captured",
) -> bytes:
    payment = {
        "id": payment_id,
        "entity": "payment",
        "amount": amount,
        "currency": currency,
        "status": status,
        "order_id": order_id,
        "method": "upi",
        "email": "someone@example.com",
        "contact": "+919876543210",
        "vpa": "someone@okbank",
        "notes": {"phone": "9876543210"},
        "created_at": int(time.time()),
    }
    payload: dict[str, Any] = {"payment": {"entity": payment}}
    if kind == "order.paid":
        payload["order"] = {
            "entity": {"id": order_id, "amount": amount, "amount_paid": amount, "status": "paid"}
        }
    body = {
        "entity": "event",
        "account_id": "acc_test",
        "event": kind,
        "contains": list(payload),
        "payload": payload,
        "created_at": int(time.time()),
    }
    return json.dumps(body).encode()


def deliver(client: TestClient, raw: bytes, event_id: str, secret: str | None = None) -> Any:
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    sig = sign(secret or payments.webhook_secret(settings), raw)
    return client.post(
        HOOK,
        content=raw,
        headers={
            "Content-Type": "application/json",
            "X-Razorpay-Signature": sig,
            "X-Razorpay-Event-Id": event_id,
        },
    )


def create_order(
    client: TestClient, headers: dict[str, str], amount: int, key: str | None = None
) -> Any:
    return client.post(
        "/v1/wallet/recharge-orders",
        json={"amount_paise": amount},
        headers={**headers, "Idempotency-Key": key or uuid.uuid4().hex},
    )


def db_scalar(client: TestClient, sql: str, **params: Any) -> Any:
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]

    async def run() -> Any:
        engine = create_async_engine(settings.database_url.get_secret_value())
        try:
            async with engine.connect() as conn:
                return (await conn.execute(text(sql), params)).scalar()
        finally:
            await engine.dispose()

    return asyncio.run(run())


@pytest.fixture
def me(login):  # type: ignore[no-untyped-def]
    return login(USER)


def test_recharge_options_and_bonus_flag(client: TestClient, me, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    body = client.get("/v1/wallet/recharge-options", headers=me).json()
    assert body["currency"] == "INR" and body["provider"] == "fake"
    assert (body["min_paise"], body["max_paise"]) == (10000, 5000000)
    assert body["bonus_enabled"] is False
    assert all(p["bonus_paise"] == 0 for p in body["packs"])
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    packs = {
        p["amount_paise"]: p["bonus_paise"]
        for p in client.get("/v1/wallet/recharge-options", headers=me).json()["packs"]
    }
    assert packs[20000] == 0 and packs[50000] == 2500 and packs[100000] == 10000
    assert packs[200000] == 30000
    assert client.get("/v1/wallet/recharge-options").status_code == 401


def test_create_order_bounds_idempotency_and_ownership(  # type: ignore[no-untyped-def]
    client: TestClient, me, login, monkeypatch
) -> None:
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    for amount in (9999, 5000001):
        r = create_order(client, me, amount)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "amount_out_of_range"
    r = client.post("/v1/wallet/recharge-orders", json={"amount_paise": 50000}, headers=me)
    assert r.status_code == 400  # Idempotency-Key required

    r = create_order(client, me, 100000, key="order-key-0001")
    assert r.status_code == 201, r.text
    order = r.json()
    assert order["status"] == "created" and order["bonus_paise"] == 10000
    assert order["provider"] == "fake" and order["provider_order_id"].startswith("order_")
    assert order["currency"] == "INR" and order["paid_at"] is None
    again = create_order(client, me, 100000, key="order-key-0001")
    assert again.status_code == 201 and again.json() == order
    clash = create_order(client, me, 50000, key="order-key-0001")
    assert clash.status_code == 409 and clash.json()["detail"]["code"] == "idempotency_conflict"
    # Bonus is fixed at creation: switching the flag off later does not change the order.
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "false")
    got = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me)
    assert got.status_code == 200 and got.json()["bonus_paise"] == 10000
    other = login("+919811110002")
    assert client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=other).status_code == 404


def test_checkout_result_is_verified_and_never_credits(client: TestClient, me) -> None:  # type: ignore[no-untyped-def]
    order = create_order(client, me, 50000).json()
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    secret = payments.checkout_secret(settings)
    good = sign(secret, f"{order['provider_order_id']}|pay_CHK1".encode())
    url = f"/v1/wallet/recharge-orders/{order['id']}/checkout-result"
    bad = client.post(
        url, json={"provider_payment_id": "pay_CHK1", "provider_signature": "0" * 64}, headers=me
    )
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "invalid_signature"
    ok = client.post(
        url, json={"provider_payment_id": "pay_CHK1", "provider_signature": good}, headers=me
    )
    assert ok.status_code == 200 and ok.json()["status"] == "created"
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 0
    assert db_scalar(client, "SELECT checkout_verified FROM recharge_orders") is True


def test_simulated_payment_credits_once_with_bonus(client: TestClient, me, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    order = create_order(client, me, 50000).json()
    r = client.post(
        f"/v1/dev/payments/{order['id']}/simulate", json={"outcome": "captured"}, headers=me
    )
    assert r.status_code == 200, r.text
    got = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me).json()
    assert got["status"] == "paid" and got["paid_at"] is not None
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["real_paise"], w["promo_paise"], w["total_paise"]) == (50000, 2500, 52500)
    assert [lot["campaign"] for lot in w["promo_lots"]] == ["recharge_bonus"]
    # Payment payloads are stored without contact details.
    stored = db_scalar(client, "SELECT payload::text FROM payment_events")
    for secret in ("example.com", "9876543210", "okbank", "email", "contact", "vpa", "notes"):
        assert secret not in stored
    txns = client.get("/v1/wallet/transactions", headers=me).json()["items"]
    assert [(t["kind"], t["amount_paise"]) for t in txns] == [
        ("recharge_bonus", 2500),
        ("recharge", 50000),
    ]


def test_same_webhook_five_times_sequentially(client: TestClient, me, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    order = create_order(client, me, 100000).json()
    raw = event(
        "payment.captured", order_id=order["provider_order_id"], payment_id="pay_R1", amount=100000
    )
    statuses = [deliver(client, raw, "evt_R1").json()["status"] for _ in range(5)]
    assert statuses == ["processed"] + ["duplicate"] * 4
    # order.paid for the same payment is another event, but the credit key is the payment.
    raw2 = event(
        "order.paid", order_id=order["provider_order_id"], payment_id="pay_R1", amount=100000
    )
    assert deliver(client, raw2, "evt_R2").json()["status"] == "processed"
    assert db_scalar(client, "SELECT count(*) FROM payment_events") == 2
    assert db_scalar(client, "SELECT count(*) FROM ledger_transactions WHERE kind='recharge'") == 1
    assert db_scalar(client, "SELECT count(*) FROM promo_lots") == 1
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["real_paise"], w["promo_paise"]) == (100000, 10000)


def test_same_webhook_five_times_concurrently(client: TestClient, me, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    order = create_order(client, me, 200000).json()
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    raw = event(
        "payment.captured", order_id=order["provider_order_id"], payment_id="pay_C1", amount=200000
    )
    sig = sign(payments.webhook_secret(settings), raw)

    async def run() -> list[str]:
        engine = create_async_engine(settings.database_url.get_secret_value(), pool_size=5)
        maker = make_sessionmaker(engine)

        async def one() -> str:
            async with maker() as db:
                return await process_webhook(db, settings, raw, sig, "evt_C1")

        try:
            return await asyncio.gather(*(one() for _ in range(5)))
        finally:
            await engine.dispose()

    results = asyncio.run(run())
    assert sorted(results) == ["duplicate"] * 4 + ["processed"]
    assert db_scalar(client, "SELECT count(*) FROM payment_events") == 1
    assert db_scalar(client, "SELECT count(*) FROM ledger_transactions WHERE kind='recharge'") == 1
    assert db_scalar(client, "SELECT count(*) FROM promo_lots") == 1
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["real_paise"], w["promo_paise"]) == (200000, 30000)


def test_bad_signature_or_mismatched_amount_never_credits(client: TestClient, me) -> None:  # type: ignore[no-untyped-def]
    order = create_order(client, me, 50000).json()
    oid = order["provider_order_id"]
    raw = event("payment.captured", order_id=oid, payment_id="pay_B1", amount=50000)
    assert deliver(client, raw, "evt_B1", secret="wrong-secret").status_code == 400
    r = client.post(HOOK, content=raw, headers={"X-Razorpay-Event-Id": "evt_B1"})
    assert r.status_code == 400
    # Body tampered after signing.
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    sig = sign(payments.webhook_secret(settings), raw)
    tampered = raw.replace(b"50000", b"5000000")
    r = client.post(
        HOOK,
        content=tampered,
        headers={"X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": "evt_B1"},
    )
    assert r.status_code == 400
    assert db_scalar(client, "SELECT count(*) FROM payment_events") == 0

    short = event("payment.captured", order_id=oid, payment_id="pay_B2", amount=40000)
    r = deliver(client, short, "evt_B2")
    assert r.status_code == 200 and r.json()["status"] == "mismatch"
    usd = event("payment.captured", order_id=oid, payment_id="pay_B3", amount=50000, currency="USD")
    assert deliver(client, usd, "evt_B3").json()["status"] == "mismatch"
    unknown = event("payment.captured", order_id="order_nope", payment_id="pay_B4", amount=50000)
    assert deliver(client, unknown, "evt_B4").json()["status"] == "unknown_order"
    assert db_scalar(client, "SELECT count(*) FROM ledger_transactions") == 0
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 0
    got = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me).json()
    assert got["status"] == "created"
    assert db_scalar(client, "SELECT count(*) FROM payment_events WHERE status='mismatch'") == 2


def test_failed_payments_and_unknown_events(client: TestClient, me) -> None:  # type: ignore[no-untyped-def]
    order = create_order(client, me, 50000).json()
    oid = order["provider_order_id"]
    failed = event(
        "payment.failed", order_id=oid, payment_id="pay_F1", amount=50000, status="failed"
    )
    assert deliver(client, failed, "evt_F1").json()["status"] == "processed"
    got = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me).json()
    assert got["status"] == "failed"
    # A later capture (user retried in Checkout) still credits: the money arrived.
    paid = event("payment.captured", order_id=oid, payment_id="pay_F2", amount=50000)
    assert deliver(client, paid, "evt_F2").json()["status"] == "processed"
    late_fail = event(
        "payment.failed", order_id=oid, payment_id="pay_F3", amount=50000, status="failed"
    )
    deliver(client, late_fail, "evt_F3")
    got = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me).json()
    assert got["status"] == "paid"
    other = json.dumps({"event": "refund.created", "payload": {}}).encode()
    r = deliver(client, other, "evt_X1")
    assert r.status_code == 200 and r.json()["status"] == "ignored"
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 50000


def test_simulate_failed_and_dev_endpoint_refused_outside_dev(  # type: ignore[no-untyped-def]
    client: TestClient, me, login
) -> None:
    order = create_order(client, me, 50000).json()
    url = f"/v1/dev/payments/{order['id']}/simulate"
    assert client.post(url, json={"outcome": "failed"}, headers=me).status_code == 200
    got = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me).json()
    assert got["status"] == "failed"
    other = login("+919811110003")
    assert client.post(url, json={"outcome": "captured"}, headers=other).status_code == 404
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    for update in ({"app_env": "production"}, {"app_env": "staging"}):
        client.app.state.settings = settings.model_copy(update=update)  # type: ignore[attr-defined]
        r = client.post(url, json={"outcome": "captured"}, headers=me)
        assert r.status_code == 404
    client.app.state.settings = settings  # type: ignore[attr-defined]
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 0


async def test_razorpay_gateway_calls_orders_api_without_personal_data() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/orders":
            return httpx.Response(200, json={"id": "order_Live123", "status": "created"})
        if request.url.path == "/v1/payments":
            items = [
                {"id": "pay_1", "order_id": "order_1", "amount": 100, "currency": "INR",
                 "status": "captured", "created_at": 1700000000, "email": "x@example.com"},
                {"id": "pay_2", "order_id": "order_2", "amount": 200, "currency": "INR",
                 "status": "failed", "created_at": 1700000001},
            ]  # fmt: skip
            skip = int(request.url.params.get("skip", "0"))
            return httpx.Response(200, json={"items": items if skip == 0 else []})
        return httpx.Response(404)

    from pydantic import SecretStr

    settings = Settings(
        app_env="test",
        payments_provider="razorpay",
        razorpay_key_id="rzp_test_key",
        razorpay_key_secret=SecretStr("key-secret"),
        razorpay_webhook_secret=SecretStr("hook-secret"),
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        gw = payments.RazorpayGateway(settings, http)
        oid = await gw.create_order(
            amount_paise=50000, currency="INR", receipt=str(uuid.uuid4()), notes={"o": "1"}
        )
        assert oid == "order_Live123"
        req = seen[0]
        assert req.method == "POST" and str(req.url) == "https://api.razorpay.com/v1/orders"
        assert (
            req.headers["authorization"]
            == "Basic " + base64.b64encode(b"rzp_test_key:key-secret").decode()
        )
        sent = json.loads(req.content)
        assert sent["amount"] == 50000 and sent["currency"] == "INR" and len(sent["receipt"]) <= 40
        good = sign("key-secret", b"order_Live123|pay_9")
        assert gw.verify_checkout("order_Live123", "pay_9", good)
        assert not gw.verify_checkout(
            "order_Live123", "pay_9", good[:-1] + ("1" if good[-1] != "1" else "2")
        )
        captured = await gw.captured_payments(1699990000, 1700010000)
        assert [(p.payment_id, p.amount_paise) for p in captured] == [("pay_1", 100)]
    assert payments.webhook_secret(settings) == "hook-secret"


def test_second_payment_on_a_paid_order_is_not_credited(
    client: TestClient, me: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A customer can pay one Razorpay order twice. The order is credited once; the extra
    payment is recorded as `duplicate_payment` for a refund to the card, never credited."""
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    order = create_order(client, me, 100000).json()
    first = event(
        "payment.captured", order_id=order["provider_order_id"], payment_id="pay_D1", amount=100000
    )
    second = event(
        "payment.captured", order_id=order["provider_order_id"], payment_id="pay_D2", amount=100000
    )
    assert deliver(client, first, "evt_D1").json()["status"] == "processed"
    assert deliver(client, second, "evt_D2").json()["status"] == "duplicate_payment"
    assert deliver(client, second, "evt_D2").json()["status"] == "duplicate"
    assert db_scalar(client, "SELECT count(*) FROM ledger_transactions WHERE kind='recharge'") == 1
    assert db_scalar(client, "SELECT count(*) FROM promo_lots") == 1
    w = client.get("/v1/wallet", headers=me).json()
    assert (w["real_paise"], w["promo_paise"]) == (100000, 10000)
    paid = client.get(f"/v1/wallet/recharge-orders/{order['id']}", headers=me).json()
    assert paid["status"] == "paid"


def test_simulating_an_already_paid_order_is_refused(
    client: TestClient, me: dict[str, str]
) -> None:
    order = create_order(client, me, 50000).json()
    url = f"/v1/dev/payments/{order['id']}/simulate"
    assert (
        client.post(url, json={"outcome": "captured"}, headers=me).json()["status"] == "processed"
    )
    for _ in range(3):
        r = client.post(url, json={"outcome": "captured"}, headers=me)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "order_already_paid"
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 50000
