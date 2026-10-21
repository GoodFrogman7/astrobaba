"""Shared world for the portal, earnings and payout tests (no tests here).

Ledger postings in the current month go through the real wallet (`wallet.charge_minute`,
`wallet.post_refund`). Postings in past IST months cannot be made through the public wallet API
(the ledger stamps `occurred_at` with the database clock and is append-only), so `minute()` and
`refund()` with `at=` write them through the wallet's own low-level posting functions: the same
entries, projections and keys, only with a past `occurred_at`. Amounts are plain test numbers.
"""

import asyncio
import datetime as dt
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import wallet
from astro_api.config import Settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.models import ConsultSession, User

ASTRO_A = "+919855550101"
ASTRO_B = "+919855550102"
USER_1 = "+919855550001"
USER_2 = "+919855550002"


def utc(s: str) -> dt.datetime:
    """'2026-09-10T10:00:00' (UTC) → aware datetime."""
    return dt.datetime.fromisoformat(s).replace(tzinfo=dt.UTC)


def run_db[T](settings: Settings, fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
    """Run `fn(db)` in its own engine and transaction, then commit."""

    async def go() -> T:
        engine = make_engine(settings.database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                out = await fn(db)
                await db.commit()
                return out
        finally:
            await engine.dispose()

    return asyncio.run(go())


def sql(settings: Settings, statement: str, **params: Any) -> Any:
    async def go(db: AsyncSession) -> Any:
        result = await db.execute(text(statement), params)
        return result.scalar() if result.returns_rows else None  # type: ignore[attr-defined]

    return run_db(settings, go)


async def fund(db: AsyncSession, user_id: uuid.UUID, paise: int) -> None:
    await wallet.credit_recharge(
        db, user_id=user_id, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=paise
    )


async def new_session(
    db: AsyncSession,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    *,
    kind: str = "chat",
    started_at: dt.datetime | None = None,
    price: int = 2000,
    bps: int = 4000,
) -> uuid.UUID:
    start = started_at or dt.datetime.now(dt.UTC)
    s = ConsultSession(
        user_id=user_id,
        astrologer_id=astrologer_id,
        kind=kind,
        status="completed",
        started_at=start,
        ended_at=start + dt.timedelta(minutes=30),
        price_per_min_paise=price,
        commission_bps=bps,
        settled_at=start + dt.timedelta(minutes=30),
    )
    db.add(s)
    await db.flush()
    return s.id


async def minute(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    n: int,
    price: int,
    bps: int,
    at: dt.datetime | None = None,
) -> None:
    """Charge minute `n` of a session (real wallet when `at` is None, else backdated)."""
    if at is None:
        await wallet.charge_minute(
            db,
            session_id=session_id,
            user_id=user_id,
            astrologer_id=astrologer_id,
            minute=n,
            price_paise=price,
            commission_bps=bps,
        )
        return
    await wallet.lock_user(db, user_id)
    tid = await wallet._insert_txn(
        db,
        key=f"session:{session_id}:minute:{n}",
        payload_hash="test-backdated",
        kind="consultation",
        user_id=user_id,
        session_id=session_id,
        astrologer_id=astrologer_id,
        occurred_at=at,
    )
    assert tid is not None
    commission, astrologer = wallet.split_commission(price, bps)
    await wallet._write(
        db,
        tid,
        [
            wallet._Posting(wallet.real_account(user_id), "debit", price),
            wallet._Posting(wallet.payable_account(astrologer_id), "credit", astrologer),
            wallet._Posting(wallet.COMMISSION, "credit", commission),
        ],
    )


async def minutes(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    count: int,
    price: int,
    bps: int,
    at: dt.datetime | None = None,
) -> None:
    for n in range(1, count + 1):
        when = None if at is None else at + dt.timedelta(minutes=n - 1)
        await minute(
            db,
            session_id=session_id,
            user_id=user_id,
            astrologer_id=astrologer_id,
            n=n,
            price=price,
            bps=bps,
            at=when,
        )


async def refund(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    astrologer_paise: int,
    commission_paise: int,
    at: dt.datetime | None = None,
) -> None:
    """Refund part of a session: real wallet when `at` is None (split by the wallet), else a
    backdated posting with the given split (real money back to the user)."""
    amount = astrologer_paise + commission_paise
    if at is None:
        await wallet.post_refund(
            db,
            key=f"refund:test:{session_id}:{uuid.uuid4().hex[:8]}",
            rule="manual",
            session_id=session_id,
            user_id=user_id,
            astrologer_id=astrologer_id,
            amount_paise=amount,
        )
        return
    await wallet.lock_user(db, user_id)
    tid = await wallet._insert_txn(
        db,
        key=f"refund:test:{session_id}:{uuid.uuid4().hex[:8]}",
        payload_hash="test-backdated",
        kind="refund",
        user_id=user_id,
        session_id=session_id,
        astrologer_id=astrologer_id,
        occurred_at=at,
    )
    assert tid is not None
    await wallet._write(
        db,
        tid,
        [
            wallet._Posting(wallet.real_account(user_id), "credit", amount),
            wallet._Posting(wallet.payable_account(astrologer_id), "debit", astrologer_paise),
            wallet._Posting(wallet.COMMISSION, "debit", commission_paise),
        ],
    )


@dataclass
class PortalWorld:
    client: TestClient
    settings: Settings
    admin: dict[str, str]
    a_headers: dict[str, str]
    a_id: uuid.UUID
    b_headers: dict[str, str]
    b_id: uuid.UUID
    u1: uuid.UUID
    u2: uuid.UUID
    u1_headers: dict[str, str]

    def db[T](self, fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
        return run_db(self.settings, fn)

    def work(
        self,
        astrologer_id: uuid.UUID,
        *,
        count: int,
        at: dt.datetime | None,
        price: int = 2000,
        bps: int = 4000,
        user_id: uuid.UUID | None = None,
        kind: str = "chat",
    ) -> uuid.UUID:
        """A completed session of `count` charged minutes starting at `at`; returns its id."""
        uid = user_id or self.u1

        async def go(db: AsyncSession) -> uuid.UUID:
            sid = await new_session(db, uid, astrologer_id, kind=kind, started_at=at)
            await minutes(
                db,
                session_id=sid,
                user_id=uid,
                astrologer_id=astrologer_id,
                count=count,
                price=price,
                bps=bps,
                at=at,
            )
            return sid

        return self.db(go)

    def refund(
        self,
        session_id: uuid.UUID,
        astrologer_id: uuid.UUID,
        *,
        astrologer_paise: int,
        commission_paise: int,
        at: dt.datetime | None,
        user_id: uuid.UUID | None = None,
    ) -> None:
        uid = user_id or self.u1

        async def go(db: AsyncSession) -> None:
            await refund(
                db,
                session_id=session_id,
                user_id=uid,
                astrologer_id=astrologer_id,
                astrologer_paise=astrologer_paise,
                commission_paise=commission_paise,
                at=at,
            )

        self.db(go)

    def payable(self, astrologer_id: uuid.UUID) -> int:
        async def go(db: AsyncSession) -> int:
            return await wallet.account_balance(db, wallet.payable_account(astrologer_id))

        return self.db(go)


@pytest.fixture(name="portal_world")
def portal_world_fixture(
    client: TestClient, make_live: Any, login: Any, admin_headers: Any
) -> PortalWorld:
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    a_headers, a_id, _ = make_live(ASTRO_A, display_name="Asha Verma")
    b_headers, b_id, _ = make_live(ASTRO_B, display_name="Bina Rao")
    u1_headers = login(USER_1)
    login(USER_2)

    async def users(db: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
        ids = []
        for phone in (USER_1, USER_2):
            uid = (await db.execute(select(User.id).where(User.phone == phone))).scalar_one()
            await fund(db, uid, 10_000_000)
            ids.append(uid)
        return ids[0], ids[1]

    u1, u2 = run_db(settings, users)
    return PortalWorld(
        client,
        settings,
        admin_headers,
        a_headers,
        uuid.UUID(a_id),
        b_headers,
        uuid.UUID(b_id),
        u1,
        u2,
        u1_headers,
    )
