"""One-time purchases from the wallet (reports, AI questions): promo first, then real; idempotent;
never negative; full refunds reverse the same buckets (ADR-0002, docs/api/revenue.md)."""

import asyncio
import datetime as dt
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import wallet
from astro_api.db import make_sessionmaker
from astro_api.models import User
from astro_api.models_ledger import LedgerEntry, PromoLot

pytestmark = pytest.mark.integration


@pytest.fixture
async def maker(clean) -> AsyncIterator[async_sessionmaker[AsyncSession]]:  # type: ignore[no-untyped-def]
    engine = create_async_engine(clean.database_url.get_secret_value(), pool_size=20)
    yield make_sessionmaker(engine)
    await engine.dispose()


async def funded(db: AsyncSession, real: int, promo: int = 0) -> uuid.UUID:
    user = User(phone=f"+9197{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
    db.add(user)
    await db.flush()
    if real:
        await wallet.credit_recharge(
            db, user_id=user.id, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=real
        )
    if promo:
        await wallet.grant_promo(
            db,
            user_id=user.id,
            amount_paise=promo,
            campaign="test",
            key=f"promo:test:{uuid.uuid4()}",
            expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=5),
        )
    await db.commit()
    return user.id


def buy(uid: uuid.UUID, ref: str, amount: int = 49900) -> dict[str, object]:
    return {
        "user_id": uid,
        "key": f"report:{ref}:paid",
        "product": "report",
        "ref_id": ref,
        "amount_paise": amount,
    }


async def test_purchase_spends_promo_first_and_credits_revenue(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await funded(db, real=50000, promo=10000)
        p = await wallet.charge_purchase(db, **buy(uid, "r1"))  # type: ignore[arg-type]
        await db.commit()
        assert (p.promo_paise, p.real_paise, p.created) == (10000, 39900, True)
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (10100, 0)
        assert await wallet.account_balance(db, wallet.REPORT_REVENUE) == 49900
        again = await wallet.charge_purchase(db, **buy(uid, "r1"))  # type: ignore[arg-type]
        assert not again.created and again.transaction_id == p.transaction_id
        with pytest.raises(wallet.IdempotencyConflict):
            await wallet.charge_purchase(db, **buy(uid, "r1", amount=100))  # type: ignore[arg-type]


async def test_purchase_never_overdraws_and_writes_nothing_when_short(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await funded(db, real=1000)
        with pytest.raises(wallet.InsufficientFunds):
            await wallet.charge_purchase(db, **buy(uid, "r2", amount=1001))  # type: ignore[arg-type]
        await db.rollback()
        assert (await wallet.balances(db, uid)).real_paise == 1000
        entries = (await db.execute(select(LedgerEntry))).scalars().all()
        assert all(e.account_id != wallet.REPORT_REVENUE for e in entries)


async def test_purchase_ignores_a_free_session_lot(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await funded(db, real=0)
        await wallet.grant_free_session(db, user_id=uid, session_id=uuid.uuid4(), amount_paise=5000)
        await db.commit()
        with pytest.raises(wallet.InsufficientFunds):
            await wallet.charge_purchase(db, **buy(uid, "r3", amount=1000))  # type: ignore[arg-type]


async def test_parallel_purchases_never_overdraw(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await funded(db, real=10 * 1000)

    async def one(i: int) -> bool:
        async with maker() as db:
            try:
                await wallet.charge_purchase(
                    db,
                    user_id=uid,
                    key=f"ai:{i}:charge",
                    product="ai_question",
                    ref_id=str(i),
                    amount_paise=1000,
                )
                await db.commit()
                return True
            except wallet.InsufficientFunds:
                await db.rollback()
                return False

    results = await asyncio.gather(*(one(i) for i in range(20)))
    assert results.count(True) == 10
    async with maker() as db:
        assert (await wallet.balances(db, uid)).real_paise == 0
        assert await wallet.account_balance(db, wallet.AI_REVENUE) == 10000


async def test_full_refund_reverses_buckets_once(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await funded(db, real=50000, promo=10000)
        await wallet.charge_purchase(db, **buy(uid, "r4"))  # type: ignore[arg-type]
        await db.commit()
        r = await wallet.refund_purchase(
            db, user_id=uid, key="refund:report:r4", original_key="report:r4:paid"
        )
        await db.commit()
        assert (r.real_paise, r.promo_paise, r.created) == (39900, 10000, True)
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (50000, 10000)
        assert await wallet.account_balance(db, wallet.REPORT_REVENUE) == 0
        lot = (await db.execute(select(PromoLot).where(PromoLot.campaign == "refund"))).scalar_one()
        assert lot.remaining_paise == 10000 and lot.session_id is None
        again = await wallet.refund_purchase(
            db, user_id=uid, key="refund:report:r4", original_key="report:r4:paid"
        )
        assert not again.created and again.transaction_id == r.transaction_id
        with pytest.raises(LookupError):
            await wallet.refund_purchase(
                db, user_id=uid, key="refund:report:nope", original_key="report:nope:paid"
            )
