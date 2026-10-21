"""Money path of the load-test seed (written before the implementation; CLAUDE.md: money code is
test-first). Credit goes through wallet.grant_promo with a deterministic key; leftover credit is
forfeited through the ledger's own promo expiry. Every transaction must balance."""

import secrets
import uuid

import pytest
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from astro_api import wallet
from astro_api.models import User
from astro_api.models_ledger import LedgerEntry, LedgerTransaction, PromoLot
from loadtest import seed
from loadtest.common import PHONE_PREFIX, Refused, ensure_seed_allowed

pytestmark = pytest.mark.integration


async def _user(sm: async_sessionmaker[AsyncSession]) -> uuid.UUID:
    async with sm() as db:
        # Tagged like seeded users (test numbers use the 9 slot), so `clean` covers them too.
        u = User(phone=f"{PHONE_PREFIX}9{secrets.randbelow(10**6):06d}", device_ids=[], roles=[])
        db.add(u)
        await db.commit()
        return u.id


async def _txn_sums(db: AsyncSession, user_id: uuid.UUID) -> dict[str, int]:
    """Signed sum (debits - credits) of each of the user's transactions, by idempotency key."""
    signed = case((LedgerEntry.direction == "debit", LedgerEntry.amount_paise), else_=0) - case(
        (LedgerEntry.direction == "credit", LedgerEntry.amount_paise), else_=0
    )
    rows = await db.execute(
        select(LedgerTransaction.idempotency_key, func.sum(signed))
        .join(LedgerEntry, LedgerEntry.transaction_id == LedgerTransaction.id)
        .where(LedgerTransaction.user_id == user_id)
        .group_by(LedgerTransaction.idempotency_key)
    )
    return {key: int(total) for key, total in rows.all()}


async def test_credit_sets_balance_and_balances(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    uid = await _user(sessionmaker)
    async with sessionmaker() as db:
        lot = await seed.credit(db, user_id=uid, amount_paise=12_345)
        await db.commit()
    assert lot.created
    async with sessionmaker() as db:
        b = await wallet.balances(db, uid)
        assert (b.total_paise, b.real_paise, b.promo_paise) == (12_345, 0, 12_345)
        assert await _txn_sums(db, uid) == {f"loadtest:credit:{uid}": 0}
        tx = (
            await db.execute(select(LedgerTransaction).where(LedgerTransaction.user_id == uid))
        ).scalar_one()
        assert tx.kind == "promo_grant"
        promo = (
            await db.execute(select(PromoLot).where(PromoLot.source_transaction_id == tx.id))
        ).scalar_one()
        assert promo.campaign == "loadtest"
        assert promo.expires_at is not None  # lapses on its own if never cleaned


async def test_credit_is_idempotent(sessionmaker: async_sessionmaker[AsyncSession]) -> None:
    uid = await _user(sessionmaker)
    async with sessionmaker() as db:
        first = await seed.credit(db, user_id=uid, amount_paise=5_000)
        await db.commit()
    async with sessionmaker() as db:
        again = await seed.credit(db, user_id=uid, amount_paise=5_000)
        await db.commit()
    assert first.created and not again.created
    assert first.lot_id == again.lot_id
    async with sessionmaker() as db:
        assert (await wallet.balances(db, uid)).total_paise == 5_000
        assert len(await _txn_sums(db, uid)) == 1


async def test_forfeit_expires_leftover_through_ledger(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> None:
    uid = await _user(sessionmaker)
    async with sessionmaker() as db:
        await seed.credit(db, user_id=uid, amount_paise=7_000)
        await db.commit()
    async with sessionmaker() as db:
        assert await seed.forfeit_credit(db, [uid]) == 7_000
        await db.commit()
    async with sessionmaker() as db:
        assert (await wallet.balances(db, uid)).total_paise == 0
        sums = await _txn_sums(db, uid)
        assert len(sums) == 2 and set(sums.values()) == {0}
        assert await seed.forfeit_credit(db, [uid]) == 0  # nothing left: nothing posted


def test_seed_refused_outside_development_and_test() -> None:
    ensure_seed_allowed("development")
    ensure_seed_allowed("test")
    for env in ("staging", "production"):
        with pytest.raises(Refused):
            ensure_seed_allowed(env)
