"""Hard gate (PLAN.md Phase 4): 100 parallel debits never overdraw or double-spend.

Every call runs in its own database session and connection, all launched together with
asyncio.gather; the pool is smaller than 100 so many are in flight at once and the rest queue.
"""

import asyncio
import datetime as dt
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import wallet
from astro_api.db import make_sessionmaker
from astro_api.models import User
from astro_api.models_ledger import LedgerTransaction, PromoLot

pytestmark = pytest.mark.integration

ASTRO = uuid.uuid4()
PRICE = 1000


@pytest.fixture
async def maker(clean) -> AsyncIterator[async_sessionmaker[AsyncSession]]:  # type: ignore[no-untyped-def]
    engine = create_async_engine(
        clean.database_url.get_secret_value(), pool_size=20, max_overflow=0, pool_timeout=120
    )
    yield make_sessionmaker(engine)
    await engine.dispose()


async def setup_user(
    maker: async_sessionmaker[AsyncSession], real: int, promo_lots: tuple[int, ...] = ()
) -> uuid.UUID:
    async with maker() as db:
        user = User(phone=f"+9195{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
        db.add(user)
        await db.flush()
        if real:
            await wallet.credit_recharge(
                db, user_id=user.id, payment_id=f"pay_{uuid.uuid4().hex[:12]}", amount_paise=real
            )
        for i, amount in enumerate(promo_lots):
            await wallet.grant_promo(
                db,
                user_id=user.id,
                amount_paise=amount,
                campaign="test",
                key=f"promo:test:{user.id}:{i}",
                expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=i + 1),
            )
        await db.commit()
        return user.id


async def charge(
    maker: async_sessionmaker[AsyncSession], uid: uuid.UUID, sid: uuid.UUID, minute: int
) -> wallet.Charge | str:
    async with maker() as db:
        try:
            result = await wallet.charge_minute(
                db,
                session_id=sid,
                user_id=uid,
                astrologer_id=ASTRO,
                minute=minute,
                price_paise=PRICE,
                commission_bps=4000,
            )
        except wallet.InsufficientFunds:
            await db.rollback()
            return "insufficient"
        await db.commit()
        return result


async def balances_never_negative(db: AsyncSession) -> None:
    low = (await db.execute(text("SELECT min(balance_paise) FROM account_balances"))).scalar()
    assert low is not None and low >= 0
    low_lot = (await db.execute(text("SELECT min(remaining_paise) FROM promo_lots"))).scalar()
    assert low_lot is None or low_lot >= 0


async def test_100_parallel_debits_never_overdraw(maker) -> None:  # type: ignore[no-untyped-def]
    uid = await setup_user(maker, real=50 * PRICE)
    sid = uuid.uuid4()
    results = await asyncio.gather(*(charge(maker, uid, sid, n) for n in range(1, 101)))
    ok = [r for r in results if isinstance(r, wallet.Charge)]
    assert len(ok) == 50 and results.count("insufficient") == 50
    assert all(r.created and r.real_paise == PRICE for r in ok)
    async with maker() as db:
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (0, 0)
        assert await wallet.account_balance(db, wallet.real_account(uid)) == 0
        await balances_never_negative(db)
        charges = (
            await db.execute(
                select(func.count())
                .select_from(LedgerTransaction)
                .where(LedgerTransaction.kind == "consultation")
            )
        ).scalar()
        assert charges == 50
        assert await wallet.account_balance(db, wallet.payable_account(ASTRO)) == 50 * 600
        assert await wallet.account_balance(db, wallet.COMMISSION) == 50 * 400


async def test_100_parallel_calls_with_the_same_key_post_once(maker) -> None:  # type: ignore[no-untyped-def]
    uid = await setup_user(maker, real=10 * PRICE)
    sid = uuid.uuid4()
    results = await asyncio.gather(*(charge(maker, uid, sid, 1) for _ in range(100)))
    assert all(isinstance(r, wallet.Charge) for r in results)
    charges = [r for r in results if isinstance(r, wallet.Charge)]
    assert len({r.transaction_id for r in charges}) == 1
    assert sum(r.created for r in charges) == 1
    async with maker() as db:
        assert (await wallet.balances(db, uid)).real_paise == 9 * PRICE
        n = (
            await db.execute(
                select(func.count())
                .select_from(LedgerTransaction)
                .where(LedgerTransaction.idempotency_key == f"session:{sid}:minute:1")
            )
        ).scalar()
        assert n == 1


async def test_100_parallel_debits_across_promo_and_real(maker) -> None:  # type: ignore[no-untyped-def]
    # 20 minutes of promo in three lots (one not a multiple of the price) plus 30 of real.
    uid = await setup_user(maker, real=30 * PRICE, promo_lots=(7500, 5500, 7000))
    sid = uuid.uuid4()
    results = await asyncio.gather(*(charge(maker, uid, sid, n) for n in range(1, 101)))
    ok = [r for r in results if isinstance(r, wallet.Charge)]
    assert len(ok) == 50
    assert sum(r.promo_paise for r in ok) == 20 * PRICE
    assert sum(r.real_paise for r in ok) == 30 * PRICE
    async with maker() as db:
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (0, 0)
        assert (await db.execute(select(func.sum(PromoLot.remaining_paise)))).scalar() == 0
        await balances_never_negative(db)
