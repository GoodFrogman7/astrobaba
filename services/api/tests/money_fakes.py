"""In-memory stand-in for wallet / refunds / free_session, with the same semantics as the
interfaces in astro_api.wallet, astro_api.refunds and astro_api.free_session:

- prepaid minutes keyed `session:{id}:minute:{n}`; a repeated key returns the original charge
  with created=False; InsufficientFunds (the real class) instead of going negative;
- spend order: the session's own promo lot, then general promo, then real;
- commission = floor(charge * bps / 10000);
- writes are TRANSACTIONAL like the real ledger: they become visible to other database sessions
  only when the caller's AsyncSession commits, and vanish on rollback or close (a process that
  dies mid-transaction leaves nothing behind).

Tests use the `money` fixture. When the real wallet lands, switching the session tests to it is
one line in `money_fixture()` below (return a RealMoney adapter with the same `fund`,
`charged_minutes`, `spent`, `balance` and `refunded` methods); assertions on fake-only details
are guarded with `isinstance(money, FakeMoney)`.

The rest of the module is the session test world (an approved astrologer, funded users, a
`deps_for()` "process" with an injected clock) shared by test_sessions_*, test_chat_*,
test_meter* and test_session_crash*.
"""

import asyncio
import copy
import os
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi.testclient import TestClient
from redis.asyncio import Redis
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from astro_api import free_session, refunds, wallet
from astro_api import session_service as svc
from astro_api.chat_crypto import cipher_from_settings
from astro_api.config import Settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.models import ConsultSession


@dataclass
class Lot:
    user_id: uuid.UUID
    remaining: int
    closed: bool = False


@dataclass
class Posted:
    key: str
    session_id: uuid.UUID
    minute: int
    promo: int
    real: int
    commission: int
    transaction_id: uuid.UUID = field(default_factory=uuid.uuid4)


@dataclass
class State:
    real: dict[uuid.UUID, int] = field(default_factory=dict)
    promo: dict[uuid.UUID, int] = field(default_factory=dict)
    lots: dict[uuid.UUID, Lot] = field(default_factory=dict)  # by session id
    free_grants: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)  # user -> session
    charges: dict[str, Posted] = field(default_factory=dict)
    free_claims: set[uuid.UUID] = field(default_factory=set)
    expired: dict[uuid.UUID, int] = field(default_factory=dict)


Op = Callable[[State], None]


class FakeMoney:
    def __init__(self) -> None:
        self.committed = State()
        self.pending: dict[int, list[Op]] = {}
        self.calls: Counter[str] = Counter()  # charge_minute calls per key (committed or not)
        self.refund_facts: list[refunds.SessionFacts] = []
        self.free_eligible = True

    # ------------------------------------------------------------ test helpers

    def fund(self, user_id: uuid.UUID, real_paise: int = 0, promo_paise: int = 0) -> None:
        self.committed.real[user_id] = self.committed.real.get(user_id, 0) + real_paise
        self.committed.promo[user_id] = self.committed.promo.get(user_id, 0) + promo_paise

    def charged_minutes(self, session_id: uuid.UUID) -> list[int]:
        return sorted(
            p.minute for p in self.committed.charges.values() if p.session_id == session_id
        )

    def spent(self, session_id: uuid.UUID) -> int:
        return sum(
            p.promo + p.real for p in self.committed.charges.values() if p.session_id == session_id
        )

    def balance(self, user_id: uuid.UUID) -> int:
        return self.committed.real.get(user_id, 0) + self.committed.promo.get(user_id, 0)

    def refunded(self) -> list[uuid.UUID]:
        return [f.session_id for f in self.refund_facts]

    # ------------------------------------------------------------ transactions

    def _hook(self, db: AsyncSession) -> int:
        sync: Session = db.sync_session
        if sync.info.get("fake_money") is not self:
            sync.info["fake_money"] = self

            def after_commit(session: Session) -> None:
                for op in self.pending.pop(id(session), []):
                    op(self.committed)

            def after_end(session: Session, transaction: SessionTransaction) -> None:
                if transaction.parent is None:
                    self.pending.pop(id(session), None)

            event.listen(sync, "after_commit", after_commit)
            event.listen(sync, "after_transaction_end", after_end)
        return id(sync)

    def _view(self, db: AsyncSession) -> State:
        ops = self.pending.get(self._hook(db), [])
        if not ops:
            return self.committed
        state = copy.deepcopy(self.committed)
        for op in ops:
            op(state)
        return state

    def _write(self, db: AsyncSession, op: Op) -> None:
        self.pending.setdefault(self._hook(db), []).append(op)

    # ------------------------------------------------------------ wallet

    def _spendable(
        self, state: State, user_id: uuid.UUID, session_id: uuid.UUID | None
    ) -> tuple[int, int, int]:
        lot = state.lots.get(session_id) if session_id else None
        lot_left = lot.remaining if lot and lot.user_id == user_id and not lot.closed else 0
        return lot_left, state.promo.get(user_id, 0), state.real.get(user_id, 0)

    async def balances(
        self, db: AsyncSession, user_id: uuid.UUID, *, session_id: uuid.UUID | None = None
    ) -> wallet.Balances:
        lot, promo, real = self._spendable(self._view(db), user_id, session_id)
        return wallet.Balances(real_paise=real, promo_paise=promo + lot)

    async def minutes_affordable(
        self,
        db: AsyncSession,
        user_id: uuid.UUID,
        price_paise: int,
        *,
        session_id: uuid.UUID | None = None,
    ) -> int:
        return sum(self._spendable(self._view(db), user_id, session_id)) // price_paise

    async def charge_minute(
        self,
        db: AsyncSession,
        *,
        session_id: uuid.UUID,
        user_id: uuid.UUID,
        astrologer_id: uuid.UUID,
        minute: int,
        price_paise: int,
        commission_bps: int,
    ) -> wallet.Charge:
        key = f"session:{session_id}:minute:{minute}"
        self.calls[key] += 1
        state = self._view(db)
        if key in state.charges:
            p = state.charges[key]
            return self._charge(p, created=False)
        lot, promo, real = self._spendable(state, user_id, session_id)
        if lot + promo + real < price_paise:
            raise wallet.InsufficientFunds()
        from_lot = min(lot, price_paise)
        from_promo = min(promo, price_paise - from_lot)
        from_real = price_paise - from_lot - from_promo
        posted = Posted(
            key,
            session_id,
            minute,
            promo=from_lot + from_promo,
            real=from_real,
            commission=price_paise * commission_bps // 10000,
        )

        def op(s: State) -> None:
            if from_lot:
                s.lots[session_id].remaining -= from_lot
            s.promo[user_id] = s.promo.get(user_id, 0) - from_promo
            s.real[user_id] = s.real.get(user_id, 0) - from_real
            assert s.promo[user_id] >= 0 and s.real[user_id] >= 0, "overdraft"
            s.charges[key] = posted

        self._write(db, op)
        return self._charge(posted, created=True)

    @staticmethod
    def _charge(p: Posted, *, created: bool) -> wallet.Charge:
        return wallet.Charge(
            transaction_id=p.transaction_id,
            promo_paise=p.promo,
            real_paise=p.real,
            commission_paise=p.commission,
            astrologer_paise=p.promo + p.real - p.commission,
            created=created,
        )

    async def grant_free_session(
        self, db: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID, amount_paise: int
    ) -> uuid.UUID:
        state = self._view(db)
        if user_id in state.free_grants:
            return state.free_grants[user_id]

        def op(s: State) -> None:
            s.free_grants[user_id] = session_id
            s.lots[session_id] = Lot(user_id, amount_paise)

        self._write(db, op)
        return session_id

    async def close_session_lots(self, db: AsyncSession, *, session_id: uuid.UUID) -> int:
        lot = self._view(db).lots.get(session_id)
        if lot is None or lot.closed:
            return 0
        left = lot.remaining

        def op(s: State) -> None:
            s.lots[session_id].closed = True
            s.expired[session_id] = left
            s.lots[session_id].remaining = 0

        self._write(db, op)
        return left

    # ------------------------------------------------------------ refunds, free session

    async def on_session_end(
        self, db: AsyncSession, facts: refunds.SessionFacts, *, minute_seconds: float = 60.0
    ) -> list[refunds.RefundResult]:
        if facts.session_id not in self.refunded():
            self.refund_facts.append(facts)
        return []

    async def check(
        self, db: AsyncSession, redis: Redis, *, user_id: uuid.UUID, device_id: str, client_ip: str
    ) -> free_session.Eligibility:
        if not self.free_eligible:
            return free_session.Eligibility(False, 5, "flag_off")
        if user_id in self._view(db).free_claims:
            return free_session.Eligibility(False, 5, "already_used")
        return free_session.Eligibility(True, 5, None)

    async def claim(
        self,
        db: AsyncSession,
        redis: Redis,
        *,
        user_id: uuid.UUID,
        session_id: uuid.UUID,
        device_id: str,
        client_ip: str,
    ) -> None:
        eligibility = await self.check(
            db, redis, user_id=user_id, device_id=device_id, client_ip=client_ip
        )
        if not eligibility.eligible:
            raise free_session.FreeSessionUnavailable(eligibility.reason or "unavailable")
        self._write(db, lambda s: s.free_claims.add(user_id))

    # ------------------------------------------------------------ install

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in (
            "balances",
            "minutes_affordable",
            "charge_minute",
            "grant_free_session",
            "close_session_lots",
        ):
            monkeypatch.setattr(wallet, name, getattr(self, name))
        monkeypatch.setattr(refunds, "on_session_end", self.on_session_end)
        monkeypatch.setattr(free_session, "check", self.check)
        monkeypatch.setattr(free_session, "claim", self.claim)


class RealMoney:
    """The same test-facing methods over the real ledger (astro_api.wallet)."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _run(self, fn: Callable[[AsyncSession], Any]) -> Any:
        async def go() -> Any:
            engine = make_engine(self.settings.database_url.get_secret_value())
            try:
                async with make_sessionmaker(engine)() as db:
                    out = await fn(db)
                    await db.commit()
                    return out
            finally:
                await engine.dispose()

        return asyncio.run(go())

    def fund(self, user_id: uuid.UUID, real_paise: int = 0, promo_paise: int = 0) -> None:
        assert promo_paise == 0, "promo funding: use wallet.grant_promo in the test"

        async def go(db: AsyncSession) -> None:
            await wallet.credit_recharge(
                db, user_id=user_id, payment_id=f"test_{uuid.uuid4().hex}", amount_paise=real_paise
            )

        if real_paise:
            self._run(go)

    def _minute_keys(self, session_id: uuid.UUID) -> list[str]:
        from sqlalchemy import select

        from astro_api.models_ledger import LedgerTransaction

        async def go(db: AsyncSession) -> list[str]:
            rows = await db.execute(
                select(LedgerTransaction.idempotency_key).where(
                    LedgerTransaction.idempotency_key.like(f"session:{session_id}:minute:%")
                )
            )
            return list(rows.scalars())

        keys: list[str] = self._run(go)
        return keys

    def charged_minutes(self, session_id: uuid.UUID) -> list[int]:
        return sorted(int(k.rsplit(":", 1)[1]) for k in self._minute_keys(session_id))

    def spent(self, session_id: uuid.UUID) -> int:
        async def go(db: AsyncSession) -> int:
            totals = await wallet.session_totals(db, session_id)
            return int(totals.charged_paise)

        return int(self._run(go))

    def balance(self, user_id: uuid.UUID) -> int:
        async def go(db: AsyncSession) -> int:
            return (await wallet.balances(db, user_id)).total_paise

        return int(self._run(go))


@pytest.fixture(name="money")
def money_fixture(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, clean: Settings
) -> Any:
    """The money backend for session tests: the real ledger, so the hard gates (crash, double
    meters, insufficient funds) run against the real wallet. Tests that look inside the in-memory
    fake ask for `fake_money` and get the fake; SESSION_TESTS_MONEY=fake forces the fake for all."""
    if "fake_money" not in request.fixturenames and os.environ.get("SESSION_TESTS_MONEY") != "fake":
        return RealMoney(clean)
    fake = FakeMoney()
    fake.install(monkeypatch)
    return fake


@pytest.fixture(name="fake_money")
def fake_money_fixture(money: Any) -> FakeMoney:
    """For tests that look inside the fake (lots, refund facts, call counters)."""
    assert isinstance(money, FakeMoney)
    return money


# ---------------------------------------------------------------- session test world

ORIGIN = "http://localhost:3000"
ASTRO_PHONE = "+919844440100"
USER_PHONE = "+919844440001"
PRICE = 2000  # make_live default (tier rising: 4000 bps)


@asynccontextmanager
async def deps_for(settings: Settings, **overrides: Any) -> AsyncIterator[svc.Deps]:
    """A Deps (one "API process": its own engine and Redis pool) for driving the state machine
    and the meter directly, e.g. with billing_minute_seconds=1 and an injected clock."""
    s = settings.model_copy(update=overrides)
    engine = make_engine(s.database_url.get_secret_value())
    redis = Redis.from_url(s.redis_url.get_secret_value())
    try:
        yield svc.Deps(make_sessionmaker(engine), redis, s, cipher_from_settings(s))
    finally:
        await redis.aclose()
        await engine.dispose()


@dataclass
class World:
    client: TestClient
    login: Callable[..., dict[str, str]]
    money: Any
    astro: dict[str, str]
    aid: str
    slug: str
    settings: Settings

    def user(
        self, phone: str = USER_PHONE, fund: int = 100_000
    ) -> tuple[dict[str, str], uuid.UUID]:
        headers = self.login(phone)
        uid = uuid.UUID(self.client.get("/v1/me", headers=headers).json()["id"])
        if fund:
            self.money.fund(uid, real_paise=fund)
        return headers, uid

    def create(
        self,
        headers: dict[str, str],
        key: str | None = None,
        *,
        free: bool = False,
        astrologer_id: str | None = None,
    ) -> Any:
        return self.client.post(
            "/v1/sessions",
            json={"astrologer_id": astrologer_id or self.aid, "kind": "chat", "free": free},
            headers={**headers, "Idempotency-Key": key or uuid.uuid4().hex},
        )

    def post(self, sid: str, action: str, headers: dict[str, str]) -> Any:
        return self.client.post(f"/v1/sessions/{sid}/{action}", headers=headers)

    def accepted(
        self, phone: str = USER_PHONE, fund: int = 100_000, *, free: bool = False
    ) -> tuple[dict[str, str], uuid.UUID, str]:
        headers, uid = self.user(phone, fund)
        r = self.create(headers, free=free)
        assert r.status_code == 201, r.text
        sid = r.json()["id"]
        r = self.post(sid, "accept", self.astro)
        assert r.status_code == 200 and r.json()["status"] == "accepted", r.text
        return headers, uid, sid

    def ticket(self, sid: str, headers: dict[str, str]) -> str:
        r = self.client.post(f"/v1/sessions/{sid}/ws-ticket", headers=headers)
        assert r.status_code == 200, r.text
        return str(r.json()["ticket"])

    def row(self, sid: str | uuid.UUID) -> ConsultSession:
        async def get() -> ConsultSession:
            async with deps_for(self.settings) as deps, deps.sessionmaker() as db:
                s = await db.get(ConsultSession, uuid.UUID(str(sid)))
                assert s is not None
                return s

        return asyncio.run(get())


@pytest.fixture(name="world")
def world_fixture(
    client: TestClient, make_live: Any, login: Any, money: Any, clean: Settings
) -> World:
    astro, aid, slug = make_live(ASTRO_PHONE)
    return World(client, login, money, astro, aid, slug, clean)
