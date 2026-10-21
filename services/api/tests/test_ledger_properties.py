"""Property tests (PLAN.md §7): random sequences of grants, charges, refunds and expiries keep
every transaction balanced, every projection equal to the sum of its entries, every promo lot
equal to its entries, and no user balance or lot ever negative. Plus the pure split maths."""

import asyncio
import datetime as dt
import uuid

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from astro_api import wallet
from astro_api.db import make_sessionmaker
from astro_api.models import User

# ------------------------------------------------------------------ pure maths (no database)


@given(st.integers(1, 10**9), st.integers(0, 10000))
def test_commission_split_sums_to_charge(charge: int, bps: int) -> None:
    commission, astrologer = wallet.split_commission(charge, bps)
    assert commission == charge * bps // 10000
    assert commission + astrologer == charge and commission >= 0 and astrologer >= 0


@given(
    st.integers(0, 10**7),
    st.integers(0, 10**7),
    st.lists(st.integers(1, 10**6), min_size=1, max_size=8),
)
def test_proportional_refund_never_exceeds_either_bucket(
    a: int, b: int, refunds: list[int]
) -> None:
    total = a + b
    done = done_a = 0
    for amount in refunds:
        if total == 0 or done + amount > total:
            break
        part_a = wallet.proportional_part(done, amount, a, total, done_a)
        done_a += part_a
        done += amount
        assert 0 <= part_a <= amount
        assert done_a <= a and done - done_a <= b
    if done == total:
        assert done_a == a


# ------------------------------------------------------------------ database properties

ASTRO = uuid.UUID("00000000-0000-0000-0000-0000000000a1")

op = st.one_of(
    st.tuples(st.just("recharge"), st.integers(1, 200000)),
    st.tuples(st.just("promo"), st.integers(1, 50000), st.integers(-2, 30)),
    st.tuples(st.just("charge"), st.integers(0, 2), st.integers(1, 6000), st.integers(0, 10000)),
    st.tuples(st.just("refund"), st.integers(0, 2), st.integers(1, 10000)),
    st.tuples(st.just("free"), st.integers(1, 20000)),
    st.tuples(st.just("close"), st.integers(0, 2)),
    st.tuples(st.just("expire"), st.integers(0, 40)),
)


async def check_invariants(db: AsyncSession) -> None:
    unbalanced = (
        await db.execute(
            text(
                "SELECT t.id FROM ledger_transactions t LEFT JOIN ledger_entries e "
                "ON e.transaction_id = t.id GROUP BY t.id HAVING count(e.id) = 0 OR "
                "sum(CASE WHEN e.direction = 'debit' THEN e.amount_paise ELSE 0 END) <> "
                "sum(CASE WHEN e.direction = 'credit' THEN e.amount_paise ELSE 0 END)"
            )
        )
    ).all()
    assert unbalanced == []
    drift = (
        await db.execute(
            text(
                "SELECT b.account_id, b.balance_paise, coalesce(sum(CASE WHEN "
                "e.direction = b.normal_side THEN e.amount_paise ELSE -e.amount_paise END), 0) "
                "FROM account_balances b LEFT JOIN ledger_entries e ON e.account_id = "
                "b.account_id GROUP BY b.account_id, b.balance_paise "
                "HAVING b.balance_paise <> coalesce(sum(CASE WHEN e.direction = b.normal_side "
                "THEN e.amount_paise ELSE -e.amount_paise END), 0)"
            )
        )
    ).all()
    assert drift == []
    missing = (
        await db.execute(
            text(
                "SELECT DISTINCT e.account_id FROM ledger_entries e LEFT JOIN account_balances b "
                "ON b.account_id = e.account_id WHERE b.account_id IS NULL AND "
                "(e.account_id LIKE 'user:%' OR e.account_id LIKE 'astrologer:%')"
            )
        )
    ).all()
    assert missing == []
    lot_drift = (
        await db.execute(
            text(
                "SELECT l.id FROM promo_lots l LEFT JOIN ledger_entries e ON e.promo_lot_id = l.id "
                "GROUP BY l.id, l.remaining_paise HAVING l.remaining_paise <> coalesce(sum(CASE "
                "WHEN e.direction = 'credit' THEN e.amount_paise ELSE -e.amount_paise END), 0)"
            )
        )
    ).all()
    assert lot_drift == []
    lots_vs_promo = (
        await db.execute(
            text(
                "SELECT l.user_id FROM promo_lots l JOIN account_balances b ON b.account_id = "
                "'user:' || l.user_id || ':' || 'promo' GROUP BY l.user_id, b.balance_paise "
                "HAVING sum(l.remaining_paise) <> b.balance_paise"
            )
        )
    ).all()
    assert lots_vs_promo == []
    negative = (
        await db.execute(
            text(
                "SELECT (SELECT count(*) FROM account_balances WHERE account_id LIKE 'user:%' "
                "AND balance_paise < 0) + (SELECT count(*) FROM promo_lots WHERE "
                "remaining_paise < 0 OR remaining_paise > amount_paise)"
            )
        )
    ).scalar()
    assert negative == 0


async def run_ops(url: str, ops: list[tuple[object, ...]]) -> None:
    engine = create_async_engine(url)
    maker = make_sessionmaker(engine)
    try:
        async with maker() as db:
            user = User(phone=f"+9194{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
            db.add(user)
            await db.commit()
            uid = user.id
        sessions = [uuid.uuid4() for _ in range(3)]
        minutes = [0, 0, 0]
        free_used = False
        for i, o in enumerate(ops):
            async with maker() as db:
                kind = o[0]
                if kind == "recharge":
                    await wallet.credit_recharge(
                        db,
                        user_id=uid,
                        payment_id=f"pay_{uid.hex[:8]}_{i}",
                        amount_paise=int(o[1]),  # type: ignore[call-overload]
                    )
                elif kind == "promo":
                    await wallet.grant_promo(
                        db,
                        user_id=uid,
                        amount_paise=int(o[1]),  # type: ignore[call-overload]
                        campaign="prop",
                        key=f"promo:prop:{uid}:{i}",
                        expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=int(o[2])),  # type: ignore[call-overload]
                    )
                elif kind == "charge":
                    s, price, bps = int(o[1]), int(o[2]), int(o[3])  # type: ignore[call-overload]
                    before = await wallet.balances(db, uid, session_id=sessions[s])
                    try:
                        c = await wallet.charge_minute(
                            db,
                            session_id=sessions[s],
                            user_id=uid,
                            astrologer_id=ASTRO,
                            minute=minutes[s] + 1,
                            price_paise=price,
                            commission_bps=bps,
                        )
                    except wallet.InsufficientFunds:
                        assert before.total_paise < price
                        await db.rollback()
                        continue
                    assert before.total_paise >= price
                    assert c.promo_paise + c.real_paise == price
                    minutes[s] += 1
                elif kind == "refund":
                    s, bps = int(o[1]), int(o[2])  # type: ignore[call-overload]
                    totals = await wallet.session_totals(db, sessions[s])
                    refundable = totals.charged_paise - totals.refunded_paise
                    amount = refundable * bps // 10000
                    if amount <= 0:
                        continue
                    r = await wallet.post_refund(
                        db,
                        key=f"refund:prop:{sessions[s]}:{i}",
                        rule="manual",
                        session_id=sessions[s],
                        user_id=uid,
                        astrologer_id=ASTRO,
                        amount_paise=amount,
                    )
                    assert r.real_paise + r.promo_paise == amount
                    assert r.commission_paise + r.astrologer_paise == amount
                elif kind == "free":
                    if free_used:
                        continue
                    free_used = True
                    await wallet.grant_free_session(
                        db,
                        user_id=uid,
                        session_id=sessions[0],
                        amount_paise=int(o[1]),  # type: ignore[call-overload]
                    )
                elif kind == "close":
                    await wallet.close_session_lots(db, session_id=sessions[int(o[1])])  # type: ignore[call-overload]
                elif kind == "expire":
                    await wallet.expire_due_lots(
                        db,
                        now=dt.datetime.now(dt.UTC) + dt.timedelta(days=int(o[1])),  # type: ignore[call-overload]
                    )
                await db.commit()
        async with maker() as db:
            await check_invariants(db)
    finally:
        await engine.dispose()


@pytest.mark.integration
@settings(
    max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture]
)
@given(ops=st.lists(op, min_size=1, max_size=25))
def test_random_ledger_histories_keep_invariants(clean, ops) -> None:  # type: ignore[no-untyped-def]
    asyncio.run(run_ops(clean.database_url.get_secret_value(), ops))
