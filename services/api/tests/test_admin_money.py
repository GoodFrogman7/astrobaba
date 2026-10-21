"""Admin money endpoints: user wallet view, manual refunds (idempotent, audited), free-session
claims and overrides, reconciliation runs."""

import asyncio
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import free_session, wallet
from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.models import AuditLog, User

pytestmark = pytest.mark.integration

CLIENT = "+919855550001"


def settings_of(client: TestClient) -> Settings:
    s: Settings = client.app.state.settings  # type: ignore[attr-defined]
    return s


def run_db(client: TestClient, fn: Any) -> Any:
    async def run() -> Any:
        engine = create_async_engine(settings_of(client).database_url.get_secret_value())
        redis = Redis.from_url(settings_of(client).redis_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                out = await fn(db, redis)
                await db.commit()
                return out
        finally:
            await redis.aclose()
            await engine.dispose()

    return asyncio.run(run())


@pytest.fixture
def billed(client: TestClient, make_live, login, consult):  # type: ignore[no-untyped-def]
    """A client with a completed session of 5 minutes at 2000 paid from real money."""
    _, aid, _ = make_live("+919855550100")
    headers = login(CLIENT)
    sid = consult(CLIENT, aid)

    async def charge(db: Any, _: Any) -> uuid.UUID:
        uid: uuid.UUID = (
            await db.execute(select(User.id).where(User.phone == CLIENT))
        ).scalar_one()
        await wallet.credit_recharge(db, user_id=uid, payment_id="pay_adm", amount_paise=20000)
        for n in range(1, 6):
            await wallet.charge_minute(
                db,
                session_id=uuid.UUID(sid),
                user_id=uid,
                astrologer_id=uuid.UUID(aid),
                minute=n,
                price_paise=2000,
                commission_bps=4000,
            )
        return uid

    uid = run_db(client, charge)
    return headers, str(uid), sid


def test_admin_only(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    me = login(CLIENT)
    uid = str(uuid.uuid4())
    for method, path in (
        ("get", f"/v1/admin/money/users/{uid}/wallet"),
        ("get", "/v1/admin/money/refunds"),
        ("post", "/v1/admin/money/refunds"),
        ("get", "/v1/admin/money/free-sessions"),
        ("post", "/v1/admin/money/free-sessions/override"),
        ("get", "/v1/admin/money/reconciliation"),
        ("post", "/v1/admin/money/reconciliation/run"),
    ):
        r = client.request(method, path, headers={**me, "Idempotency-Key": "k" * 10}, json={})
        assert r.status_code == 403, (method, path)


def test_manual_refund_and_wallet_view(client: TestClient, billed, admin_headers) -> None:  # type: ignore[no-untyped-def]
    headers, uid, sid = billed
    body = {"session_id": sid, "amount_paise": 3000, "note": "Connection issues, goodwill"}
    post = {**admin_headers, "Idempotency-Key": "manual-refund-01"}
    r = client.post("/v1/admin/money/refunds", json=body, headers=post)
    assert r.status_code == 201, r.text
    refund = r.json()
    assert refund["rule"] == "manual" and refund["amount_paise"] == 3000
    assert (refund["real_paise"], refund["promo_paise"]) == (3000, 0)
    assert refund["session_id"] == sid and refund["actor"].startswith("user:")
    again = client.post("/v1/admin/money/refunds", json=body, headers=post)
    assert again.status_code == 201 and again.json() == refund
    clash = client.post("/v1/admin/money/refunds", json={**body, "amount_paise": 10}, headers=post)
    assert clash.status_code == 409
    too_much = client.post(
        "/v1/admin/money/refunds",
        json={**body, "amount_paise": 7001},
        headers={**admin_headers, "Idempotency-Key": "manual-refund-02"},
    )
    assert too_much.status_code == 422
    assert too_much.json()["detail"]["code"] == "refund_exceeds_charges"
    assert too_much.json()["detail"]["refundable_paise"] == 7000
    missing = client.post(
        "/v1/admin/money/refunds",
        json={**body, "session_id": str(uuid.uuid4())},
        headers={**admin_headers, "Idempotency-Key": "manual-refund-03"},
    )
    assert missing.status_code == 404

    w = client.get("/v1/wallet", headers=headers).json()
    assert w["real_paise"] == 20000 - 10000 + 3000
    view = client.get(f"/v1/admin/money/users/{uid}/wallet", headers=admin_headers).json()
    assert view["wallet"]["real_paise"] == 13000
    assert [t["kind"] for t in view["transactions"]] == ["refund", "consultation", "recharge"]

    listed = client.get("/v1/admin/money/refunds?limit=1", headers=admin_headers).json()
    assert [x["id"] for x in listed["items"]] == [refund["id"]]
    assert listed["items"][0]["note"] == "Connection issues, goodwill"
    assert listed["next_cursor"] is None

    async def audits(db: Any, _: Any) -> list[dict[str, Any]]:
        rows = (
            await db.execute(select(AuditLog).where(AuditLog.action == "refund.create"))
        ).scalars()
        return [dict(r.detail) for r in rows]

    detail = run_db(client, audits)
    assert len(detail) == 1 and detail[0]["amount_paise"] == 3000
    assert "note" not in detail[0]


def test_free_session_claims_and_override(  # type: ignore[no-untyped-def]
    client: TestClient, login, admin_headers, monkeypatch
) -> None:
    monkeypatch.setenv("FLAG_FIRST_FREE_SESSION", "true")
    me = login(CLIENT)
    login("+919855550002")

    async def setup(db: Any, redis: Any) -> tuple[str, str]:
        ids = {
            phone: (await db.execute(select(User.id).where(User.phone == phone))).scalar_one()
            for phone in (CLIENT, "+919855550002")
        }
        u1, u2 = ids[CLIENT], ids["+919855550002"]
        await free_session.claim(
            db, redis, user_id=u1, session_id=uuid.uuid4(), device_id="dev-1", client_ip="10.1.1.1"
        )
        await db.commit()
        await free_session.claim(
            db, redis, user_id=u2, session_id=uuid.uuid4(), device_id="dev-2", client_ip="10.1.1.1"
        )
        return str(u1), str(u2)

    u1, u2 = run_db(client, setup)
    every = client.get("/v1/admin/money/free-sessions", headers=admin_headers).json()["items"]
    assert {c["user_id"] for c in every} == {u1, u2}
    flagged = client.get(
        "/v1/admin/money/free-sessions?flagged=true", headers=admin_headers
    ).json()["items"]
    assert [(c["user_id"], c["abuse_score"], c["reasons"]) for c in flagged] == [
        (u2, 1, ["ip_seen_today"])
    ]
    assert "10.1.1.1" not in str(every) and "dev-1" not in str(every)

    w = client.get("/v1/wallet", headers=me).json()
    assert w["free_session"] == {
        "enabled": True,
        "eligible": False,
        "minutes": 5,
        "reason": "already_used",
    }
    r = client.post(
        "/v1/admin/money/free-sessions/override",
        json={"user_id": u1, "action": "reset", "note": "duplicate claim after outage"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert client.get("/v1/wallet", headers=me).json()["free_session"]["eligible"] is True
    r = client.post(
        "/v1/admin/money/free-sessions/override",
        json={"user_id": u1, "action": "block", "note": ""},
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert client.get("/v1/wallet", headers=me).json()["free_session"]["reason"] == "blocked"
    bad = client.post(
        "/v1/admin/money/free-sessions/override",
        json={"user_id": u1, "action": "delete", "note": ""},
        headers=admin_headers,
    )
    assert bad.status_code == 422
    nobody = client.post(
        "/v1/admin/money/free-sessions/override",
        json={"user_id": str(uuid.uuid4()), "action": "allow", "note": ""},
        headers=admin_headers,
    )
    assert nobody.status_code == 404


def test_reconciliation_endpoints_validate(client: TestClient, admin_headers) -> None:  # type: ignore[no-untyped-def]
    assert client.get("/v1/admin/money/reconciliation", headers=admin_headers).json() == {
        "items": [],
        "next_cursor": None,
    }
    r = client.post(
        "/v1/admin/money/reconciliation/run", json={"date": "not-a-date"}, headers=admin_headers
    )
    assert r.status_code == 422
