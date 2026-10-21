"""Hard gate (PLAN.md Phase 4): kill the API mid-session → billing resumes correctly, no free or
double minutes. Also: an outage longer than heartbeat_grace_s ends the session at last-seen
without charging the outage, and two meters running at once never double-charge.

Each "process" is a real app instance (create_app + its lifespan). A killed process simply
stops: its shutdown never runs, and a transaction it had open never commits. Time is injected,
with billing_minute_seconds=1 so a minute is one second of injected time.

These tests use the `money` fixture, i.e. the real ledger (assertions on fake-only call counters
are guarded).
"""

import asyncio
import datetime as dt
import uuid
from typing import Any

import pytest
from fastapi import FastAPI

from astro_api import billing_meter, chat_bus, wallet
from astro_api import session_service as svc
from astro_api.config import Settings
from astro_api.main import create_app
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    GRACE,
    PRICE,
    FakeMoney,
    World,
    at,
    money_fixture,
    world_fixture,
)

pytestmark = pytest.mark.integration


class Process:
    """One API process: an app whose lifespan has started. `kill()` abandons it without running
    its shutdown (only the sockets are released at the very end so the test does not leak)."""

    def __init__(self, settings: Settings) -> None:
        self.app: FastAPI = create_app(settings)
        self._lifespan: Any = None

    async def boot(self) -> "Process":
        self._lifespan = self.app.router.lifespan_context(self.app)
        await self._lifespan.__aenter__()
        return self

    @property
    def deps(self) -> svc.Deps:
        return svc.Deps.of(self.app)

    async def release(self) -> None:
        await self.app.state.redis.aclose()
        await self.app.state.engine.dispose()


async def alive(p: Process, sid: uuid.UUID, now: dt.datetime) -> None:
    """Both clients send a frame (ping) to whichever process serves them now."""
    for role in ("user", "astrologer"):
        await chat_bus.touch(p.deps.redis, sid, role, now, GRACE)


def fast_settings(w: World) -> Settings:
    return w.settings.model_copy(update={"billing_minute_seconds": 1.0, "meter_tick_seconds": 0})


def keys(sid: uuid.UUID, minutes: range) -> list[str]:
    return [f"session:{sid}:minute:{n}" for n in minutes]


def test_kill_api_mid_session_billing_resumes_without_free_or_double_minutes(
    world: World, money: Any
) -> None:
    _, uid, raw = world.accepted(fund=100 * PRICE)
    sid = uuid.UUID(raw)
    settings = fast_settings(world)

    async def scenario() -> dt.datetime:
        t0 = svc.utcnow()
        a = await Process(settings).boot()
        await alive(a, sid, t0)
        assert await svc.activate(a.deps, sid, t0)  # minute 1, prepaid at the start
        for k in (1, 2, 3):
            await alive(a, sid, at(t0, k + 0.1))
            report = await billing_meter.tick(a.app, at(t0, k + 0.2))
            assert report.charged == [(sid, k + 1)]

        # Process A dies in the middle of charging minute 5: the charge and the row update were
        # written in a transaction that never commits.
        await alive(a, sid, at(t0, 4.05))
        async with a.deps.sessionmaker() as db:
            s = await svc.lock(db, sid)
            assert s is not None and s.billed_minutes == 4
            await wallet.charge_minute(
                db,
                session_id=sid,
                user_id=s.user_id,
                astrologer_id=s.astrologer_id,
                minute=5,
                price_paise=s.price_per_min_paise,
                commission_bps=s.commission_bps,
            )
            s.billed_minutes = 5
            # killed: no commit

        # Process B starts (A's shutdown never ran). The clients reconnect within the grace
        # period; minute 5 started while they were away but inside grace, so it is owed once.
        b = await Process(settings).boot()
        await alive(b, sid, at(t0, 4.6))
        assert (await billing_meter.tick(b.app, at(t0, 4.7))).charged == [(sid, 5)]
        assert (await billing_meter.tick(b.app, at(t0, 4.8))).charged == []
        for k in (5, 6):
            await alive(b, sid, at(t0, k + 0.1))
            assert (await billing_meter.tick(b.app, at(t0, k + 0.2))).charged == [(sid, k + 1)]
        await alive(b, sid, at(t0, 6.4))  # the last frames before B dies too

        # A long outage: nothing runs for 200 s (> heartbeat_grace_s). Process C starts and the
        # clients reconnect before its first tick; the gap is still detected.
        c = await Process(settings).boot()
        await alive(c, sid, at(t0, 206.4))
        report = await billing_meter.tick(c.app, at(t0, 206.5))
        assert report.charged == [] and report.ended == [(sid, "user_dropped")]
        assert (await billing_meter.tick(c.app, at(t0, 300))).charged == []

        for p in (a, b, c):
            await p.release()
        return t0

    t0 = asyncio.run(scenario())

    assert money.charged_minutes(sid) == [1, 2, 3, 4, 5, 6, 7]  # each minute exactly once
    if isinstance(money, FakeMoney):
        calls = [money.calls[k] for k in keys(sid, range(1, 8))]
        assert calls == [1, 1, 1, 1, 2, 1, 1]  # minute 5: one rolled back, one committed
        assert money.spent(sid) == 7 * PRICE
        assert money.balance(uid) == 93 * PRICE
    row = world.row(sid)
    assert row.status == "completed" and row.end_reason == "user_dropped"
    assert row.billed_minutes == 7 and row.billed_paise == 7 * PRICE
    assert row.ended_at is not None
    assert abs((row.ended_at - at(t0, 6.4)).total_seconds()) < 0.01  # at last seen
    assert row.settled_at is not None  # refund rules ran after the end
    if isinstance(money, FakeMoney):
        assert money.refunded() == [sid]


def test_outage_without_reconnect_ends_at_last_seen(world: World, money: Any) -> None:
    _, _, raw = world.accepted(fund=100 * PRICE)
    sid = uuid.UUID(raw)
    settings = fast_settings(world)

    async def scenario() -> dt.datetime:
        t0 = svc.utcnow()
        a = await Process(settings).boot()
        await alive(a, sid, t0)
        assert await svc.activate(a.deps, sid, t0)
        await alive(a, sid, at(t0, 1.5))
        assert (await billing_meter.tick(a.app, at(t0, 1.6))).charged == [(sid, 2)]
        # A dies at t0+1.6; B comes up 100 s later and nobody has reconnected.
        b = await Process(settings).boot()
        report = await billing_meter.tick(b.app, at(t0, 101.6))
        assert report.charged == [] and report.ended == [(sid, "user_dropped")]
        for p in (a, b):
            await p.release()
        return t0

    t0 = asyncio.run(scenario())
    assert money.charged_minutes(sid) == [1, 2]
    row = world.row(sid)
    assert row.billed_minutes == 2 and row.ended_at is not None
    assert abs((row.ended_at - at(t0, 1.5)).total_seconds()) < 0.01


def test_two_meters_at_once_never_double_charge(
    world: World, make_live: Any, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    sessions = [uuid.UUID(world.accepted("+919844440301")[2])]
    for i in (2, 3):
        astro, aid, _ = make_live(f"+91984444031{i}")
        headers, _ = world.user(f"+91984444030{i}")
        sid = world.create(headers, astrologer_id=aid).json()["id"]
        assert world.post(sid, "accept", astro).status_code == 200
        sessions.append(uuid.UUID(sid))
    settings = fast_settings(world)
    real = wallet.charge_minute

    async def slow(*args: Any, **kwargs: Any) -> Any:
        out = await real(*args, **kwargs)
        await asyncio.sleep(0.02)  # hold the row lock while the other meters arrive
        return out

    async def scenario() -> None:
        a = await Process(settings).boot()
        b = await Process(settings).boot()
        t0 = svc.utcnow()
        for sid in sessions:
            await alive(a, sid, t0)
            assert await svc.activate(a.deps, sid, t0)
        monkeypatch.setattr(wallet, "charge_minute", slow)
        for k in (1, 2, 3, 4):
            for sid in sessions:
                await alive(a, sid, at(t0, k - 0.05))
            reports = await asyncio.gather(
                billing_meter.tick(a.app, at(t0, k)),
                billing_meter.tick(b.app, at(t0, k)),
                billing_meter.tick(a.app, at(t0, k)),
                billing_meter.tick(b.app, at(t0, k)),
            )
            charged = sorted(c for r in reports for c in r.charged)
            assert charged == sorted((sid, k + 1) for sid in sessions)
        for p in (a, b):
            await p.release()

    asyncio.run(scenario())
    for sid in sessions:
        assert money.charged_minutes(sid) == [1, 2, 3, 4, 5]
        assert world.row(sid).billed_minutes == 5
        if isinstance(money, FakeMoney):
            # Row locks kept every other meter away: not even a second attempt.
            assert [money.calls[k] for k in keys(sid, range(1, 6))] == [1] * 5
