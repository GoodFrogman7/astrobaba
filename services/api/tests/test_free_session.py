"""First free session: flag, once per user ever, device and IP heuristics, abuse score, admin
override. Devices and IPs are stored only as HMACs keyed with SECRET_KEY."""

import uuid
from collections.abc import AsyncIterator

import pytest
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import free_session, wallet
from astro_api.db import make_sessionmaker
from astro_api.models import AuditLog, User
from astro_api.models_ledger import FreeSessionClaim

pytestmark = pytest.mark.integration


@pytest.fixture
async def env(clean, monkeypatch) -> AsyncIterator[tuple[async_sessionmaker[AsyncSession], Redis]]:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("FLAG_FIRST_FREE_SESSION", "true")
    engine = create_async_engine(clean.database_url.get_secret_value())
    redis = Redis.from_url(clean.redis_url.get_secret_value())
    yield make_sessionmaker(engine), redis
    await redis.aclose()
    await engine.dispose()


async def new_user(db: AsyncSession, devices: list[str] | None = None) -> uuid.UUID:
    user = User(phone=f"+9192{uuid.uuid4().int % 10**8:08d}", device_ids=devices or [], roles=[])
    db.add(user)
    await db.flush()
    return user.id


async def check(db: AsyncSession, redis: Redis, uid: uuid.UUID, device: str, ip: str) -> str | None:
    e = await free_session.check(db, redis, user_id=uid, device_id=device, client_ip=ip)
    assert e.minutes == 5
    assert e.eligible == (e.reason is None)
    return e.reason


async def claim(db: AsyncSession, redis: Redis, uid: uuid.UUID, device: str, ip: str) -> None:
    await free_session.claim(
        db, redis, user_id=uid, session_id=uuid.uuid4(), device_id=device, client_ip=ip
    )


async def test_flag_off(env, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    maker, redis = env
    monkeypatch.setenv("FLAG_FIRST_FREE_SESSION", "false")
    async with maker() as db:
        uid = await new_user(db)
        assert await check(db, redis, uid, "device-aaaa", "10.0.0.1") == "flag_off"


async def test_once_per_user_and_stored_as_hashes(env) -> None:  # type: ignore[no-untyped-def]
    maker, redis = env
    async with maker() as db:
        uid = await new_user(db, ["device-aaaa"])
        assert await check(db, redis, uid, "device-aaaa", "10.0.0.1") is None
        await claim(db, redis, uid, "device-aaaa", "10.0.0.1")
        await db.commit()
        assert await check(db, redis, uid, "device-bbbb", "10.0.0.9") == "already_used"
        with pytest.raises(free_session.FreeSessionUnavailable) as e:
            await claim(db, redis, uid, "device-bbbb", "10.0.0.9")
        assert e.value.reason == "already_used"
        await db.rollback()
        row = (await db.execute(select(FreeSessionClaim))).scalar_one()
        assert row.device_hash == free_session.device_hash("device-aaaa") != "device-aaaa"
        assert "10.0.0.1" not in row.ip_hash and len(row.ip_hash) == 64
        assert row.abuse_score == 0


async def test_device_and_ip_limits(env) -> None:  # type: ignore[no-untyped-def]
    maker, redis = env
    async with maker() as db:
        first = await new_user(db)
        await claim(db, redis, first, "device-shared", "10.0.0.2")
        await db.commit()
        second = await new_user(db)
        assert await check(db, redis, second, "device-shared", "10.9.9.9") == "device_used"
        # Three free sessions from one IP today; the fourth user on that IP is refused.
        for i in range(2):
            u = await new_user(db)
            await claim(db, redis, u, f"device-ip-{i}", "10.0.0.2")
            await db.commit()
        fourth = await new_user(db)
        assert await check(db, redis, fourth, "device-fresh", "10.0.0.2") == "ip_limit"
        with pytest.raises(free_session.FreeSessionUnavailable):
            await claim(db, redis, fourth, "device-fresh", "10.0.0.2")
        await db.rollback()


async def test_abuse_score_threshold(env) -> None:  # type: ignore[no-untyped-def]
    maker, redis = env
    async with maker() as db:
        # Another account already signed in on this device (no free session there).
        await new_user(db, ["device-multi"])
        other = await new_user(db)
        await claim(db, redis, other, "device-other", "10.0.0.3")
        await db.commit()
        uid = await new_user(db, ["device-multi"])
        # Device shared with another account (+1) and the IP already had a free session (+1).
        assert await check(db, redis, uid, "device-multi", "10.0.0.3") == "abuse_score"
        # One signal alone stays under the threshold of 2.
        assert await check(db, redis, uid, "device-multi", "10.0.0.4") is None
        await claim(db, redis, uid, "device-multi", "10.0.0.4")
        await db.commit()
        row = (
            await db.execute(select(FreeSessionClaim).where(FreeSessionClaim.user_id == uid))
        ).scalar_one()
        assert row.abuse_score == 1 and row.reasons == ["device_shared"]


async def test_admin_override_allow_block_reset(env) -> None:  # type: ignore[no-untyped-def]
    maker, redis = env
    async with maker() as db:
        admin = "user:admin"
        first = await new_user(db)
        await claim(db, redis, first, "device-x1", "10.0.0.5")
        uid = await new_user(db)
        await db.commit()
        assert await check(db, redis, uid, "device-x1", "10.0.0.6") == "device_used"
        await free_session.override(db, user_id=uid, action="allow", note="support #1", actor=admin)
        await db.commit()
        assert await check(db, redis, uid, "device-x1", "10.0.0.6") is None
        await free_session.override(db, user_id=uid, action="block", note=None, actor=admin)
        await db.commit()
        assert await check(db, redis, uid, "device-new", "10.0.0.7") == "blocked"

        # Reset lets a user who already had their free session have another one.
        sid1 = uuid.uuid4()
        await wallet.grant_free_session(db, user_id=first, session_id=sid1, amount_paise=1000)
        await db.commit()
        assert await check(db, redis, first, "device-x1", "10.0.0.5") == "already_used"
        await free_session.override(db, user_id=first, action="reset", note=None, actor=admin)
        await db.commit()
        assert await check(db, redis, first, "device-x9", "10.0.0.8") is None
        sid2 = uuid.uuid4()
        await claim(db, redis, first, "device-x9", "10.0.0.8")
        lot2 = await wallet.grant_free_session(
            db, user_id=first, session_id=sid2, amount_paise=1000
        )
        await db.commit()
        assert lot2 is not None
        actions = (
            await db.execute(
                select(AuditLog.action, AuditLog.entity_id).where(
                    AuditLog.action.like("free_session.%")
                )
            )
        ).all()
        assert [a for a, _ in actions] == [
            "free_session.override",
            "free_session.override",
            "free_session.override",
        ]
        assert {e for _, e in actions} == {str(uid), str(first)}
        with pytest.raises(ValueError):
            await free_session.override(db, user_id=uid, action="nope", note=None, actor=admin)
