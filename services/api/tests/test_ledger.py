"""Ledger invariants enforced by Postgres itself (ADR-0002 §1, §3): append-only tables, balanced
transactions at commit, positive amounts, no negative user balance even if code is wrong."""

import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import wallet
from astro_api.db import make_sessionmaker
from astro_api.models import User

pytestmark = pytest.mark.integration


@pytest.fixture
async def maker(clean) -> AsyncIterator[async_sessionmaker[AsyncSession]]:  # type: ignore[no-untyped-def]
    engine = create_async_engine(clean.database_url.get_secret_value())
    yield make_sessionmaker(engine)
    await engine.dispose()


async def new_user(db: AsyncSession) -> uuid.UUID:
    user = User(phone=f"+9197{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
    db.add(user)
    await db.flush()
    return user.id


async def funded_user(maker: async_sessionmaker[AsyncSession], paise: int) -> uuid.UUID:
    async with maker() as db:
        uid = await new_user(db)
        await wallet.credit_recharge(
            db, user_id=uid, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=paise
        )
        await db.commit()
    return uid


async def test_entries_and_transactions_are_append_only(maker) -> None:  # type: ignore[no-untyped-def]
    await funded_user(maker, 10000)
    for sql in (
        "UPDATE ledger_entries SET amount_paise = amount_paise + 1",
        "DELETE FROM ledger_entries",
        "UPDATE ledger_transactions SET kind = 'adjustment'",
        "DELETE FROM ledger_transactions",
    ):
        async with maker() as db:
            with pytest.raises(DBAPIError, match="append-only"):
                await db.execute(text(sql))
            await db.rollback()
    async with maker() as db:
        assert (await db.execute(text("SELECT count(*) FROM ledger_entries"))).scalar_one() == 2


async def test_unbalanced_or_empty_transaction_fails_at_commit(maker) -> None:  # type: ignore[no-untyped-def]
    async def insert(entries: list[tuple[str, str, int]]) -> None:
        async with maker() as db:
            tid = uuid.uuid4()
            await db.execute(
                text(
                    "INSERT INTO ledger_transactions (id, idempotency_key, payload_hash, kind) "
                    "VALUES (:id, :k, 'x', 'adjustment')"
                ),
                {"id": tid, "k": f"test:{tid}"},
            )
            for account, direction, amount in entries:
                await db.execute(
                    text(
                        "INSERT INTO ledger_entries (transaction_id, account_id, direction, "
                        "amount_paise) VALUES (:t, :a, :d, :m)"
                    ),
                    {"t": tid, "a": account, "d": direction, "m": amount},
                )
            await db.commit()

    with pytest.raises(DBAPIError, match="unbalanced"):
        await insert([("platform:commission", "credit", 100)])
    with pytest.raises(DBAPIError, match="unbalanced"):
        await insert([("platform:commission", "credit", 100), ("bank:settlement", "debit", 99)])
    with pytest.raises(DBAPIError, match="no entries"):
        await insert([])
    # Balanced is fine.
    await insert([("platform:commission", "credit", 100), ("bank:settlement", "debit", 100)])


async def test_amounts_positive_and_user_balance_never_negative(maker) -> None:  # type: ignore[no-untyped-def]
    uid = await funded_user(maker, 5000)
    async with maker() as db:
        with pytest.raises(IntegrityError):
            await db.execute(
                text(
                    "INSERT INTO ledger_entries (transaction_id, account_id, direction, "
                    "amount_paise) SELECT id, 'x', 'debit', 0 FROM ledger_transactions LIMIT 1"
                )
            )
        await db.rollback()
    async with maker() as db:
        with pytest.raises(IntegrityError):
            await db.execute(
                text("UPDATE account_balances SET balance_paise = -1 WHERE account_id = :a"),
                {"a": wallet.real_account(uid)},
            )
        await db.rollback()
    # Promo entries must name their lot.
    async with maker() as db:
        with pytest.raises(IntegrityError):
            await db.execute(
                text(
                    "INSERT INTO ledger_entries (transaction_id, account_id, direction, "
                    "amount_paise) SELECT id, :a, 'credit', 5 FROM ledger_transactions LIMIT 1"
                ),
                {"a": wallet.promo_account(uid)},
            )
        await db.rollback()


async def test_idempotency_key_is_unique_in_the_database(maker) -> None:  # type: ignore[no-untyped-def]
    await funded_user(maker, 1000)
    async with maker() as db:
        key = (
            await db.execute(text("SELECT idempotency_key FROM ledger_transactions"))
        ).scalar_one()
        with pytest.raises(IntegrityError):
            await db.execute(
                text(
                    "INSERT INTO ledger_transactions (idempotency_key, payload_hash, kind) "
                    "VALUES (:k, 'y', 'adjustment')"
                ),
                {"k": key},
            )
        await db.rollback()
