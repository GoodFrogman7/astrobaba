"""Reconciliation (docs/api/billing.md): test data reconciles with zero drift; a corrupted
projection or a captured payment without its credit is reported as drift and logged at error
level without personal data."""

import asyncio
import datetime as dt
import logging
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from redis.asyncio import Redis
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import cli, payments, wallet
from astro_api.config import Settings, get_settings
from astro_api.db import make_sessionmaker
from astro_api.earnings import ist_today
from astro_api.models import User

pytestmark = pytest.mark.integration

USER = "+919844440001"


class Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def drift_log() -> Any:
    handler = Capture()
    logger = logging.getLogger("astro_api.reconciliation")
    logger.addHandler(handler)
    yield handler
    logger.removeHandler(handler)


def settings_of(client: TestClient) -> Settings:
    s: Settings = client.app.state.settings  # type: ignore[attr-defined]
    return s


def sql(client: TestClient, statement: str, **params: Any) -> Any:
    async def run() -> Any:
        engine = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with engine.begin() as conn:
                result = await conn.execute(text(statement), params)
                return result.scalar() if result.returns_rows else None
        finally:
            await engine.dispose()

    return asyncio.run(run())


def paid_order(client: TestClient, headers: dict[str, str], amount: int) -> dict[str, Any]:
    order: dict[str, Any] = client.post(
        "/v1/wallet/recharge-orders",
        json={"amount_paise": amount},
        headers={**headers, "Idempotency-Key": uuid.uuid4().hex},
    ).json()
    r = client.post(
        f"/v1/dev/payments/{order['id']}/simulate", json={"outcome": "captured"}, headers=headers
    )
    assert r.status_code == 200, r.text
    return order


def spend_and_refund(client: TestClient) -> None:
    async def run() -> None:
        engine = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                uid = (await db.execute(select(User.id).where(User.phone == USER))).scalar_one()
                sid, aid = uuid.uuid4(), uuid.uuid4()
                for n in range(1, 6):
                    await wallet.charge_minute(
                        db,
                        session_id=sid,
                        user_id=uid,
                        astrologer_id=aid,
                        minute=n,
                        price_paise=3000,
                        commission_bps=3500,
                    )
                await wallet.post_refund(
                    db,
                    key=f"refund:test:{sid}",
                    rule="manual",
                    session_id=sid,
                    user_id=uid,
                    astrologer_id=aid,
                    amount_paise=4500,
                )
                await wallet.grant_free_session(
                    db, user_id=uid, session_id=uuid.uuid4(), amount_paise=900
                )
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(run())


def run_recon(client: TestClient, admin: dict[str, str]) -> dict[str, Any]:
    r = client.post(
        "/v1/admin/money/reconciliation/run",
        json={"date": ist_today().isoformat()},
        headers=admin,
    )
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def check(run: dict[str, Any], name: str) -> dict[str, Any]:
    found: dict[str, Any] = next(c for c in run["checks"] if c["name"] == name)
    return found


def test_test_data_reconciles_with_zero_drift(  # type: ignore[no-untyped-def]
    client: TestClient, login, admin_headers, monkeypatch, drift_log
) -> None:
    monkeypatch.setenv("FLAG_RECHARGE_BONUS_TIERS", "true")
    me = login(USER)
    paid_order(client, me, 100000)
    paid_order(client, me, 25000)
    spend_and_refund(client)
    r = client.post("/v1/dev/payments/settle", headers=admin_headers)
    assert r.status_code == 200 and r.json()["status"] == "processed"
    paid_order(client, me, 50000)  # captured after the settlement: still in clearing

    run = run_recon(client, admin_headers)
    assert run["status"] == "ok" and run["drift_paise"] == 0, run
    assert [c["name"] for c in run["checks"]] == [
        "transactions_balanced",
        "projections",
        "gateway_payments",
        "settlements",
        "payouts",
    ]
    assert all(c["status"] == "ok" for c in run["checks"])
    assert check(run, "gateway_payments")["count"] == 3
    assert check(run, "settlements")["count"] == 1
    assert not [r for r in drift_log.records if r.levelno >= logging.ERROR]
    runs = client.get("/v1/admin/money/reconciliation", headers=admin_headers).json()["items"]
    assert len(runs) == 1 and runs[0]["status"] == "ok" and runs[0]["date"] == run["date"]


def test_corrupted_projection_is_drift(  # type: ignore[no-untyped-def]
    client: TestClient, login, admin_headers, drift_log
) -> None:
    me = login(USER)
    paid_order(client, me, 30000)
    uid = sql(client, "SELECT id FROM users WHERE phone = :p", p=USER)
    sql(
        client,
        "UPDATE account_balances SET balance_paise = balance_paise + 100 WHERE account_id = :a",
        a=wallet.real_account(uid),
    )
    run = run_recon(client, admin_headers)
    assert run["status"] == "drift" and run["drift_paise"] == 100
    proj = check(run, "projections")
    assert proj["status"] == "drift"
    assert proj["issues"][0]["account_id"] == wallet.real_account(uid)
    errors = [r for r in drift_log.records if r.levelno >= logging.ERROR]
    assert [r.getMessage() for r in errors] == ["reconciliation_drift"]
    assert USER not in str(errors[0].__dict__) and "9844440001" not in str(errors[0].__dict__)


def test_captured_payment_without_credit_is_drift(  # type: ignore[no-untyped-def]
    client: TestClient, login, admin_headers
) -> None:
    me = login(USER)
    paid_order(client, me, 20000)
    order = client.post(
        "/v1/wallet/recharge-orders",
        json={"amount_paise": 40000},
        headers={**me, "Idempotency-Key": uuid.uuid4().hex},
    ).json()
    settings = settings_of(client)

    async def capture_only() -> payments.SignedEvent:
        redis = Redis.from_url(settings.redis_url.get_secret_value())
        try:
            gw = payments.FakeGateway(settings, redis)
            return await gw.simulate(order["provider_order_id"], "captured")
        finally:
            await redis.aclose()

    signed = asyncio.run(capture_only())  # the gateway has it; our webhook never arrived
    run = run_recon(client, admin_headers)
    assert run["status"] == "drift" and run["drift_paise"] == 40000
    issues = check(run, "gateway_payments")["issues"]
    assert issues == [
        {
            "problem": "missing_credit",
            "payment_id": signed.payment_id,
            "gateway_paise": 40000,
            "ledger_paise": 0,
        }
    ]
    # The webhook finally arrives: the next run is clean.
    r = client.post(
        "/v1/payments/razorpay/webhook",
        content=signed.raw,
        headers={"X-Razorpay-Signature": signed.signature, "X-Razorpay-Event-Id": signed.event_id},
    )
    assert r.json()["status"] == "processed"
    assert run_recon(client, admin_headers)["status"] == "ok"


def test_cli_reconcile(client: TestClient, login, monkeypatch, capsys) -> None:  # type: ignore[no-untyped-def]
    me = login(USER)
    paid_order(client, me, 20000)
    settings = settings_of(client)
    monkeypatch.setenv("DATABASE_URL", settings.database_url.get_secret_value())
    monkeypatch.setenv("REDIS_URL", settings.redis_url.get_secret_value())
    monkeypatch.setenv("SECRET_KEY", settings.secret_key.get_secret_value())
    get_settings.cache_clear()
    try:
        assert cli.main(["reconcile", "--date", ist_today().isoformat()]) == 0
        assert "status=ok" in capsys.readouterr().out
        yesterday = (ist_today() - dt.timedelta(days=1)).isoformat()
        assert cli.main(["reconcile", "--date", yesterday]) == 0
        uid = sql(client, "SELECT id FROM users WHERE phone = :p", p=USER)
        sql(
            client,
            "UPDATE account_balances SET balance_paise = 0 WHERE account_id = :a",
            a=wallet.real_account(uid),
        )
        assert cli.main(["reconcile"]) == 1
        assert cli.main(["expire-promo"]) == 0
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------- payouts


def test_payouts_check(  # type: ignore[no-untyped-def]
    client: TestClient, make_live, login, admin_headers, drift_log
) -> None:
    """Every paid payout has exactly one `payout:` ledger transaction of its net amount, and
    every payout posting belongs to a paid payout."""
    from astro_api import earnings, payouts

    _, aid, _ = make_live("+919844440100")
    astrologer_id = uuid.UUID(aid)
    settings = settings_of(client)
    paid_order(client, login(USER), 200000)
    uid = sql(client, "SELECT id FROM users WHERE phone = :p", p=USER)

    async def earn_and_pay() -> str:
        engine = create_async_engine(settings.database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                start, _ = earnings.month_bounds("2026-08")
                for n in range(1, 51):  # 50 minutes in August: 60000 payable
                    tid = await wallet._insert_txn(
                        db,
                        key=f"session:recon:minute:{n}",
                        payload_hash="test-backdated",
                        kind="consultation",
                        user_id=uid,
                        astrologer_id=astrologer_id,
                        occurred_at=start + dt.timedelta(days=3, minutes=n),
                    )
                    assert tid is not None
                    await wallet._write(
                        db,
                        tid,
                        [
                            wallet._Posting(wallet.real_account(uid), "debit", 2000),
                            wallet._Posting(wallet.payable_account(astrologer_id), "credit", 1200),
                            wallet._Posting(wallet.COMMISSION, "credit", 800),
                        ],
                    )
                await db.commit()
                await payouts.generate(db, "2026-08", actor="test")
                p = await payouts.get_payout(db, astrologer_id=astrologer_id, period="2026-08")
                await payouts.approve(db, p.id, actor="test")
                await payouts.mark_paid(
                    db, p.id, reference="UTR000111222333", paid_on=ist_today(), actor="test"
                )
                await db.commit()
                return str(p.id)
        finally:
            await engine.dispose()

    pid = asyncio.run(earn_and_pay())
    run = run_recon(client, admin_headers)
    assert run["status"] == "ok", run
    assert check(run, "payouts") | {"issues": []} == {
        "name": "payouts",
        "status": "ok",
        "drift_paise": 0,
        "issues": [],
        "issue_count": 0,
        "count": 1,
    }

    # A payout row whose amount no longer matches its posting.
    sql(
        client,
        "UPDATE payouts SET gross_paise = gross_paise + 100, net_paise = net_paise + 100"
        " WHERE id = :p",
        p=pid,
    )
    # A payout posting with no paid payout behind it.
    orphan = uuid.uuid4()

    async def orphan_posting() -> None:
        engine = create_async_engine(settings.database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                await wallet.charge_minute(  # 1200 payable today
                    db,
                    session_id=uuid.uuid4(),
                    user_id=uid,
                    astrologer_id=astrologer_id,
                    minute=1,
                    price_paise=2000,
                    commission_bps=4000,
                )
                await wallet.post_payout(
                    db, payout_id=orphan, astrologer_id=astrologer_id, amount_paise=500
                )
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(orphan_posting())
    run = run_recon(client, admin_headers)
    assert run["status"] == "drift" and run["drift_paise"] == 600
    issues = sorted(check(run, "payouts")["issues"], key=lambda i: i["problem"])
    assert issues == [
        {
            "problem": "amount_mismatch",
            "payout_id": pid,
            "payout_paise": 60100,
            "ledger_paise": 60000,
        },
        {
            "problem": "posting_without_paid_payout",
            "payout_id": str(orphan),
            "payout_paise": 0,
            "ledger_paise": 500,
        },
    ]
    errors = [r for r in drift_log.records if r.levelno >= logging.ERROR]
    assert errors and "payouts" in errors[-1].__dict__["failed_checks"]
