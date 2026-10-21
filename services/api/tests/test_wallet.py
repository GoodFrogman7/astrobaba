"""Wallet operations (ADR-0002): balances, per-minute charges with commission split, spend order
(promo first, earliest expiry first), session-restricted lots, expiry, idempotency."""

import datetime as dt
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import billing_config, wallet
from astro_api.db import make_sessionmaker
from astro_api.models import User
from astro_api.models_ledger import LedgerEntry, LedgerTransaction, PromoLot

pytestmark = pytest.mark.integration

NOW = dt.datetime.now(dt.UTC)


@pytest.fixture
async def maker(clean) -> AsyncIterator[async_sessionmaker[AsyncSession]]:  # type: ignore[no-untyped-def]
    engine = create_async_engine(clean.database_url.get_secret_value())
    yield make_sessionmaker(engine)
    await engine.dispose()


async def new_user(db: AsyncSession) -> uuid.UUID:
    user = User(phone=f"+9196{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
    db.add(user)
    await db.flush()
    return user.id


async def recharge(db: AsyncSession, uid: uuid.UUID, paise: int) -> wallet.Posted:
    return await wallet.credit_recharge(
        db, user_id=uid, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=paise
    )


async def promo(
    db: AsyncSession, uid: uuid.UUID, paise: int, days: float, campaign: str = "test"
) -> uuid.UUID:
    lot = await wallet.grant_promo(
        db,
        user_id=uid,
        amount_paise=paise,
        campaign=campaign,
        key=f"promo:{campaign}:{uuid.uuid4()}",
        expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=days),
    )
    return lot.lot_id


def charge_args(uid: uuid.UUID, sid: uuid.UUID, minute: int, **kw: int) -> dict[str, object]:
    return {
        "session_id": sid,
        "user_id": uid,
        "astrologer_id": kw.pop("astrologer", None) or ASTRO,
        "minute": minute,
        "price_paise": kw.pop("price", 1000),
        "commission_bps": kw.pop("bps", 4000),
    }


ASTRO = uuid.UUID("00000000-0000-0000-0000-00000000a571")


async def test_recharge_credits_real_and_is_idempotent(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        first = await wallet.credit_recharge(
            db, user_id=uid, payment_id="pay_A1", amount_paise=50000
        )
        again = await wallet.credit_recharge(
            db, user_id=uid, payment_id="pay_A1", amount_paise=50000
        )
        assert first.created and not again.created
        assert again.transaction_id == first.transaction_id
        with pytest.raises(wallet.IdempotencyConflict):
            await wallet.credit_recharge(db, user_id=uid, payment_id="pay_A1", amount_paise=1)
        await db.commit()
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise, b.total_paise) == (50000, 0, 50000)
        assert await wallet.minutes_affordable(db, uid, 1500) == 33
        entries = (
            await db.execute(
                select(LedgerEntry.account_id, LedgerEntry.direction, LedgerEntry.amount_paise)
            )
        ).all()
        assert sorted(entries) == [
            (wallet.CLEARING, "debit", 50000),
            (wallet.real_account(uid), "credit", 50000),
        ]


async def test_charge_splits_commission_and_spends_promo_first_earliest_expiry(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        await recharge(db, uid, 10000)
        late = await promo(db, uid, 700, days=20, campaign="late")
        soon = await promo(db, uid, 500, days=2, campaign="soon")
        await db.commit()
        sid = uuid.uuid4()

        c1 = await wallet.charge_minute(db, **charge_args(uid, sid, 1, price=999, bps=3500))  # type: ignore[arg-type]
        # commission = floor(999 * 3500 / 10000) = 349; astrologer gets the remainder.
        assert (c1.commission_paise, c1.astrologer_paise) == (349, 650)
        # Promo first: the lot expiring soonest (500), then the later one (499 of 700).
        assert (c1.promo_paise, c1.real_paise, c1.created) == (999, 0, True)
        lots = {
            lot.id: lot.remaining_paise for lot in (await db.execute(select(PromoLot))).scalars()
        }
        assert lots == {soon: 0, late: 201}

        c2 = await wallet.charge_minute(db, **charge_args(uid, sid, 2, price=999, bps=3500))  # type: ignore[arg-type]
        assert (c2.promo_paise, c2.real_paise) == (201, 798)
        await db.commit()
        b = await wallet.balances(db, uid)
        assert (b.real_paise, b.promo_paise) == (10000 - 798, 0)
        payable = await wallet.account_balance(db, wallet.payable_account(ASTRO))
        assert payable == 650 * 2


async def test_spend_order_is_config(maker, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(billing_config, "spend_order", lambda: ["real", "promo"])
    async with maker() as db:
        uid = await new_user(db)
        await recharge(db, uid, 1500)
        await promo(db, uid, 5000, days=3)
        c1 = await wallet.charge_minute(db, **charge_args(uid, uuid.uuid4(), 1))  # type: ignore[arg-type]
        assert (c1.real_paise, c1.promo_paise) == (1000, 0)
        c2 = await wallet.charge_minute(db, **charge_args(uid, uuid.uuid4(), 1))  # type: ignore[arg-type]
        assert (c2.real_paise, c2.promo_paise) == (500, 500)
        await db.commit()


async def test_insufficient_funds_writes_nothing_and_replays_return_original(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        await recharge(db, uid, 1500)
        await db.commit()
        sid = uuid.uuid4()
        first = await wallet.charge_minute(db, **charge_args(uid, sid, 1))  # type: ignore[arg-type]
        await db.commit()
        with pytest.raises(wallet.InsufficientFunds):
            await wallet.charge_minute(db, **charge_args(uid, sid, 2))  # type: ignore[arg-type]
        await db.rollback()
        # A retry of minute 1 returns the original even though funds are now short.
        again = await wallet.charge_minute(db, **charge_args(uid, sid, 1))  # type: ignore[arg-type]
        assert again == wallet.Charge(
            transaction_id=first.transaction_id,
            promo_paise=0,
            real_paise=1000,
            commission_paise=400,
            astrologer_paise=600,
            created=False,
        )
        with pytest.raises(wallet.IdempotencyConflict):
            await wallet.charge_minute(db, **charge_args(uid, sid, 1, price=900))  # type: ignore[arg-type]
        await db.rollback()
        count = (await db.execute(select(func.count()).select_from(LedgerTransaction))).scalar()
        assert count == 2  # recharge + one minute
        assert (await wallet.balances(db, uid)).real_paise == 500


async def test_charge_rejects_bad_input(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        await recharge(db, uid, 5000)
        for bad in ({"price": 0}, {"bps": 10001}, {"bps": -1}):
            with pytest.raises(ValueError):
                await wallet.charge_minute(db, **charge_args(uid, uuid.uuid4(), 1, **bad))  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            await wallet.charge_minute(db, **charge_args(uid, uuid.uuid4(), 0))  # type: ignore[arg-type]
        # bps 10000: the platform keeps everything, no zero-amount entry is written.
        c = await wallet.charge_minute(db, **charge_args(uid, uuid.uuid4(), 1, bps=10000))  # type: ignore[arg-type]
        assert (c.commission_paise, c.astrologer_paise) == (1000, 0)
        await db.commit()


async def test_free_session_lot_is_restricted_and_closed_at_end(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        await recharge(db, uid, 3000)
        await promo(db, uid, 400, days=5)
        free_sid, other_sid = uuid.uuid4(), uuid.uuid4()
        lot_id = await wallet.grant_free_session(
            db, user_id=uid, session_id=free_sid, amount_paise=2500
        )
        # Once per user, ever: a replay returns the same lot; another session conflicts.
        assert (
            await wallet.grant_free_session(db, user_id=uid, session_id=free_sid, amount_paise=2500)
            == lot_id
        )
        with pytest.raises(wallet.IdempotencyConflict):
            await wallet.grant_free_session(
                db, user_id=uid, session_id=other_sid, amount_paise=2500
            )
        await db.commit()

        # Invisible outside its session.
        assert (await wallet.balances(db, uid)).promo_paise == 400
        assert (await wallet.balances(db, uid, session_id=other_sid)).promo_paise == 400
        assert (await wallet.balances(db, uid, session_id=free_sid)).promo_paise == 2900

        # Spent first inside its session, then general promo, then real.
        c1 = await wallet.charge_minute(db, **charge_args(uid, free_sid, 1))  # type: ignore[arg-type]
        c2 = await wallet.charge_minute(db, **charge_args(uid, free_sid, 2))  # type: ignore[arg-type]
        assert (c1.promo_paise, c2.promo_paise) == (1000, 1000)
        lot = await db.get(PromoLot, lot_id)
        assert lot is not None and lot.remaining_paise == 500
        expired = await wallet.close_session_lots(db, session_id=free_sid)
        assert expired == 500
        assert await wallet.close_session_lots(db, session_id=free_sid) == 0
        await db.commit()
        b = await wallet.balances(db, uid, session_id=free_sid)
        assert (b.real_paise, b.promo_paise) == (3000, 400)
        kinds = (
            await db.execute(
                select(LedgerTransaction.kind, func.count()).group_by(LedgerTransaction.kind)
            )
        ).all()
        assert dict(kinds) == {
            "recharge": 1,
            "promo_grant": 1,
            "free_session_grant": 1,
            "consultation": 2,
            "promo_expiry": 1,
        }


async def test_expired_lots_are_not_spendable_and_expire_job_posts_them(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        lot_id = await promo(db, uid, 800, days=1)
        await db.commit()
        future = dt.datetime.now(dt.UTC) + dt.timedelta(days=2)
        # Not spendable once past expiry, even before the job runs.
        await db.execute(
            text("UPDATE promo_lots SET expires_at = now() - interval '1 second' WHERE id = :i"),
            {"i": lot_id},
        )
        await db.commit()
        assert (await wallet.balances(db, uid)).promo_paise == 0
        with pytest.raises(wallet.InsufficientFunds):
            await wallet.charge_minute(db, **charge_args(uid, uuid.uuid4(), 1, price=100))  # type: ignore[arg-type]
        await db.rollback()
        assert await wallet.expire_due_lots(db, now=future) == 800
        assert await wallet.expire_due_lots(db, now=future) == 0
        await db.commit()
        assert await wallet.account_balance(db, wallet.promo_account(uid)) == 0
        assert await wallet.account_balance(db, wallet.PROMO_EXPIRED) == 800


async def test_settlement_moves_clearing_to_bank_with_fees(maker) -> None:  # type: ignore[no-untyped-def]
    async with maker() as db:
        uid = await new_user(db)
        await recharge(db, uid, 100000)
        s = await wallet.post_settlement(
            db, settlement_id="setl_1", amount_paise=97640, fees_paise=2360, occurred_at=NOW
        )
        assert s.created
        again = await wallet.post_settlement(
            db, settlement_id="setl_1", amount_paise=97640, fees_paise=2360, occurred_at=NOW
        )
        assert not again.created
        await db.commit()
        assert await wallet.account_balance(db, wallet.CLEARING) == 0
        assert await wallet.account_balance(db, wallet.BANK) == 97640
        assert await wallet.account_balance(db, wallet.GATEWAY_FEES) == 2360
