"""Refund rules engine (billing.json refund_rules): failed_connect, astrologer_drop, low_rating.
Refunds reverse the session's buckets proportionally, are idempotent per rule and session, and
every one is audited with ids and amounts only."""

import datetime as dt
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import refunds, wallet
from astro_api.db import make_sessionmaker
from astro_api.models import Astrologer, AuditLog, ConsultSession, User
from astro_api.models_ledger import PromoLot, Refund

pytestmark = pytest.mark.integration

T0 = dt.datetime(2026, 10, 20, 10, 0, tzinfo=dt.UTC)
PRICE = 1000


@pytest.fixture
async def maker(clean) -> AsyncIterator[async_sessionmaker[AsyncSession]]:  # type: ignore[no-untyped-def]
    engine = create_async_engine(clean.database_url.get_secret_value())
    yield make_sessionmaker(engine)
    await engine.dispose()


async def new_user(db: AsyncSession) -> uuid.UUID:
    user = User(phone=f"+9193{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
    db.add(user)
    await db.flush()
    return user.id


async def new_astrologer(db: AsyncSession) -> uuid.UUID:
    uid = await new_user(db)
    a = Astrologer(
        user_id=uid,
        display_name="Test Astrologer",
        slug=f"test-{uid.hex[:8]}",
        bio="Bio",
        skills=["vedic"],
        languages=["en"],
        gender="female",
        requested_price_per_min_paise=PRICE,
        price_per_min_paise=PRICE,
        tier="rising",
        experience_years=3,
        status="approved",
        accepts_terms_at=T0,
    )
    db.add(a)
    await db.flush()
    return a.id


async def paid_session(
    db: AsyncSession,
    *,
    uid: uuid.UUID,
    aid: uuid.UUID,
    minutes: int,
    ended_at: dt.datetime | None = None,
) -> uuid.UUID:
    s = ConsultSession(
        user_id=uid,
        astrologer_id=aid,
        kind="chat",
        status="completed",
        started_at=T0,
        ended_at=ended_at or T0 + dt.timedelta(minutes=minutes),
    )
    db.add(s)
    await db.flush()
    for n in range(1, minutes + 1):
        await wallet.charge_minute(
            db,
            session_id=s.id,
            user_id=uid,
            astrologer_id=aid,
            minute=n,
            price_paise=PRICE,
            commission_bps=4000,
        )
    return s.id


def facts(sid: uuid.UUID, uid: uuid.UUID, aid: uuid.UUID, **kw: Any) -> refunds.SessionFacts:
    base: dict[str, Any] = {
        "session_id": sid,
        "user_id": uid,
        "astrologer_id": aid,
        "status": "completed",
        "end_reason": "user_ended",
        "accepted_at": T0,
        "started_at": T0,
        "ended_at": T0 + dt.timedelta(minutes=10),
        "billed_minutes": 10,
        "price_per_min_paise": PRICE,
        "commission_bps": 4000,
        "is_free": False,
        "astrologer_last_seen_at": T0 + dt.timedelta(minutes=10),
    }
    base.update(kw)
    return refunds.SessionFacts(**base)


async def setup(db: AsyncSession, minutes: int = 10) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """User with 3000 promo + 20000 real; a session of `minutes` paid minutes at 1000."""
    uid = await new_user(db)
    aid = await new_astrologer(db)
    await wallet.credit_recharge(
        db, user_id=uid, payment_id=f"pay_{uid.hex[:10]}", amount_paise=20000
    )
    await wallet.grant_promo(
        db,
        user_id=uid,
        amount_paise=3000,
        campaign="welcome",
        key=f"promo:welcome:{uid}",
        expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=10),
    )
    sid = await paid_session(db, uid=uid, aid=aid, minutes=minutes)
    await db.commit()
    return uid, aid, sid


async def test_astrologer_drop_refunds_minutes_after_last_activity_proportionally(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid, aid, sid = await setup(db)
        # Last seen 2.5 minutes in (during minute 3): minutes 4..10 are refunded.
        f = facts(
            sid,
            uid,
            aid,
            end_reason="astrologer_dropped",
            astrologer_last_seen_at=T0 + dt.timedelta(seconds=150),
        )
        out = await refunds.on_session_end(db, f, minute_seconds=60)
        assert out == [refunds.RefundResult("astrologer_drop", sid, 7000, True)]
        await db.commit()
        assert await refunds.on_session_end(db, f, minute_seconds=60) == [
            refunds.RefundResult("astrologer_drop", sid, 7000, False)
        ]
        await db.commit()

        row = (await db.execute(select(Refund))).scalar_one()
        # Session was paid 3000 promo + 7000 real; refund 7000 keeps that proportion.
        assert (row.amount_paise, row.promo_paise, row.real_paise) == (7000, 2100, 4900)
        assert (row.commission_paise, row.astrologer_paise) == (2800, 4200)
        assert row.rule == "astrologer_drop" and row.actor == "system:refunds"
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (20000 - 7000 + 4900, 2100)
        lot = (await db.execute(select(PromoLot).where(PromoLot.campaign == "refund"))).scalar_one()
        assert lot.session_id is None and lot.remaining_paise == 2100
        assert lot.expires_at is not None
        assert lot.expires_at > dt.datetime.now(dt.UTC) + dt.timedelta(days=29)
        assert await wallet.account_balance(db, wallet.payable_account(aid)) == 6000 - 4200
        assert await wallet.account_balance(db, wallet.COMMISSION) == 4000 - 2800
        audit = (
            await db.execute(select(AuditLog).where(AuditLog.action == "refund.create"))
        ).scalar_one()
        assert audit.entity_id == str(sid)
        assert set(audit.detail) <= {
            "rule",
            "amount_paise",
            "real_paise",
            "promo_paise",
            "transaction_id",
            "refund_id",
            "user_id",
        }


async def test_failed_connect_refunds_everything_billed(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid, aid, sid = await setup(db, minutes=1)
        f = facts(
            sid, uid, aid, status="failed", end_reason="join_timeout", started_at=None,
            billed_minutes=1,
        )  # fmt: skip
        out = await refunds.on_session_end(db, f, minute_seconds=60)
        assert out == [refunds.RefundResult("failed_connect", sid, 1000, True)]
        await db.commit()
        # The minute was paid from promo, so it comes back as promo.
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (20000, 3000)


async def test_no_refund_for_normal_end_free_or_unbilled_sessions(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid, aid, sid = await setup(db, minutes=2)
        assert await refunds.on_session_end(db, facts(sid, uid, aid), minute_seconds=60) == []
        dropped_free = facts(
            sid, uid, aid, end_reason="astrologer_dropped", is_free=True,
            astrologer_last_seen_at=T0,
        )  # fmt: skip
        assert await refunds.on_session_end(db, dropped_free, minute_seconds=60) == []
        never = facts(
            uuid.uuid4(), uid, aid, status="cancelled", end_reason="astrologer_declined",
            started_at=None, billed_minutes=0,
        )  # fmt: skip
        assert await refunds.on_session_end(db, never, minute_seconds=60) == []
        await db.commit()
        assert (await db.execute(text("SELECT count(*) FROM refunds"))).scalar() == 0


async def test_low_rating_rule_window_bps_cap_and_monthly_limit(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid, aid, sid = await setup(db)
        ended = T0 + dt.timedelta(minutes=10)
        assert await refunds.on_review(db, session_id=sid, rating=3, at=ended) is None
        late = ended + dt.timedelta(hours=24, seconds=1)
        assert await refunds.on_review(db, session_id=sid, rating=1, at=late) is None
        r = await refunds.on_review(db, session_id=sid, rating=2, at=ended + dt.timedelta(hours=1))
        # 50% of 10000 billed = 5000 (under the 20000 cap).
        assert r == refunds.RefundResult("low_rating", sid, 5000, True)
        await db.commit()
        again = await refunds.on_review(db, session_id=sid, rating=2, at=ended)
        assert again == refunds.RefundResult("low_rating", sid, 5000, False)

        # One low-rating refund per user per 30 days.
        sid2 = await paid_session(db, uid=uid, aid=aid, minutes=3)
        await db.commit()
        assert await refunds.on_review(db, session_id=sid2, rating=1, at=ended) is None

        # Cap: a long session refunds at most cap_paise.
        uid3 = await new_user(db)
        await wallet.credit_recharge(db, user_id=uid3, payment_id="pay_big", amount_paise=100000)
        sid3 = await paid_session(db, uid=uid3, aid=aid, minutes=60)
        await db.commit()
        big = await refunds.on_review(db, session_id=sid3, rating=1, at=ended)
        assert big is not None and big.amount_paise == 20000
        await db.commit()


async def test_refunds_never_exceed_what_was_charged(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid, aid, sid = await setup(db, minutes=4)
        drop = facts(
            sid, uid, aid, end_reason="astrologer_dropped", billed_minutes=4,
            astrologer_last_seen_at=T0,
        )  # fmt: skip
        out = await refunds.on_session_end(db, drop, minute_seconds=60)
        assert out[0].amount_paise == 3000  # minutes 2..4
        await db.commit()
        low = await refunds.on_review(db, session_id=sid, rating=1, at=T0)
        # 50% of 4000 = 2000, but only 1000 is left to refund.
        assert low is not None and low.amount_paise == 1000
        await db.commit()
        with pytest.raises(refunds.RefundNotAllowed) as e:
            await refunds.manual_refund(
                db, session_id=sid, amount_paise=1, key="manual-0001", actor="user:x", note=None
            )
        assert e.value.code == "refund_exceeds_charges"
        totals = await wallet.session_totals(db, sid)
        assert totals.refunded_paise == totals.charged_paise == 4000


def test_review_with_low_rating_refunds_in_the_same_transaction(  # type: ignore[no-untyped-def]
    client: TestClient, make_live, login, consult
) -> None:
    _, aid, _ = make_live("+919822220100")
    me = login("+919822220001")
    sid = consult("+919822220001", aid)

    import asyncio

    settings = client.app.state.settings  # type: ignore[attr-defined]

    async def charge() -> None:
        engine = create_async_engine(settings.database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                uid = (
                    await db.execute(select(User.id).where(User.phone == "+919822220001"))
                ).scalar_one()
                await wallet.credit_recharge(
                    db, user_id=uid, payment_id="pay_rev", amount_paise=10000
                )
                for n in (1, 2, 3, 4):
                    await wallet.charge_minute(
                        db,
                        session_id=uuid.UUID(sid),
                        user_id=uid,
                        astrologer_id=uuid.UUID(aid),
                        minute=n,
                        price_paise=2000,
                        commission_bps=4000,
                    )
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(charge())
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 2000
    r = client.post(
        f"/v1/consult-sessions/{sid}/review", json={"rating": 1, "text": "Not useful."}, headers=me
    )
    assert r.status_code == 201, r.text
    assert client.get("/v1/wallet", headers=me).json()["real_paise"] == 6000
    items = client.get("/v1/wallet/transactions", headers=me).json()["items"]
    assert items[0]["kind"] == "refund" and items[0]["amount_paise"] == 4000
    assert items[0]["astrologer"]["display_name"] == "Asha Verma"
    assert items[1]["kind"] == "consultation" and items[1]["amount_paise"] == -8000
