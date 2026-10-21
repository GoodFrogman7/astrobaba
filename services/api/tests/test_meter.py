"""Per-minute metering rules, driven with explicit ticks and an injected clock
(billing_minute_seconds=1): boundaries, insufficient funds, low balance, free-minute cap,
dropped sides, settle-after-crash and the background loop switch."""

import asyncio
import datetime as dt
import json
import time
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from astro_api import billing_meter, chat_bus, wallet
from astro_api import session_service as svc
from astro_api.main import create_app
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    PRICE,
    FakeMoney,
    World,
    alive,
    at,
    deps_for,
    fake_money_fixture,
    fast,
    money_fixture,
    world_fixture,
)

pytestmark = pytest.mark.integration


async def start(deps: svc.Deps, sid: uuid.UUID, t0: dt.datetime) -> None:
    await alive(deps, sid, t0)
    assert await svc.activate(deps, sid, t0)


def test_minutes_are_prepaid_at_each_boundary(world: World, money: Any) -> None:
    _, _, raw = world.accepted()
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with fast(world) as deps:
            t0 = svc.utcnow()
            await start(deps, sid, t0)
            assert (await billing_meter.tick(deps, at(t0, 0.5))).charged == []
            await alive(deps, sid, at(t0, 0.9))
            assert (await billing_meter.tick(deps, at(t0, 1.0))).charged == [(sid, 2)]
            assert (await billing_meter.tick(deps, at(t0, 1.5))).charged == []
            # A late tick catches up every minute that started while both were there.
            await alive(deps, sid, at(t0, 3.1))
            report = await billing_meter.tick(deps, at(t0, 3.2))
            assert report.charged == [(sid, 3), (sid, 4)]

    asyncio.run(run())
    row = world.row(sid)
    assert row.status == "active" and row.billed_minutes == 4
    assert money.charged_minutes(sid) == [1, 2, 3, 4]
    assert row.billed_paise == 4 * PRICE == money.spent(sid)


def test_insufficient_funds_ends_at_the_boundary_with_low_balance_first(
    world: World, money: Any
) -> None:
    _, uid, raw = world.accepted(fund=3 * PRICE + 500)
    sid = uuid.UUID(raw)
    events: list[dict[str, Any]] = []

    async def run() -> None:
        async with fast(world) as deps:
            pubsub = deps.redis.pubsub()
            await pubsub.subscribe(chat_bus.channel(sid))
            t0 = svc.utcnow()
            await start(deps, sid, t0)
            for k in (1, 2, 3):
                await alive(deps, sid, at(t0, k - 0.1))
                await billing_meter.tick(deps, at(t0, k))
            for _ in range(40):  # the subscribe confirmation reads as None too
                m = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.05)
                if m is not None:
                    events.append(json.loads(m["data"]))
            await pubsub.aclose()

    asyncio.run(run())
    row = world.row(sid)
    assert row.status == "completed" and row.end_reason == "insufficient_funds"
    assert row.billed_minutes == 3 and money.charged_minutes(sid) == [1, 2, 3]
    assert row.ended_at is not None and row.started_at is not None
    assert row.ended_at - row.started_at == dt.timedelta(seconds=3)
    assert money.balance(uid) == 500  # never negative, never a free minute
    low = [e["event"] for e in events if e.get("event", {}).get("type") == "low_balance"]
    assert low == [{"type": "low_balance", "minutes_left": 1}]  # after minute 2, once
    ended = [e for e in events if e.get("event", {}).get("type") == "ended"]
    assert {e["to"] for e in ended} == {"user", "astrologer"}
    texts = [
        m["text"]
        for m in world.client.get(f"/v1/sessions/{sid}/messages", headers=world.astro).json()[
            "items"
        ]
    ]
    assert texts == ["session_started", "low_balance", "session_ended:insufficient_funds"]


def test_free_session_stops_at_free_minutes_even_with_money(
    world: World, fake_money: FakeMoney
) -> None:
    _, uid, raw = world.accepted(fund=100_000, free=True)
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with fast(world) as deps:
            t0 = svc.utcnow()
            await start(deps, sid, t0)
            for k in range(1, 7):
                await alive(deps, sid, at(t0, k - 0.1))
                await billing_meter.tick(deps, at(t0, k))

    asyncio.run(run())
    row = world.row(sid)
    assert row.status == "completed" and row.end_reason == "free_minutes_used"
    assert fake_money.charged_minutes(sid) == [1, 2, 3, 4, 5]
    assert row.started_at is not None and row.ended_at == row.started_at + dt.timedelta(seconds=5)
    assert fake_money.balance(uid) == 100_000  # paid entirely from the session's own lot
    assert fake_money.committed.lots[sid].closed and fake_money.committed.expired[sid] == 0


def test_a_side_gone_longer_than_grace_ends_at_its_last_seen(
    world: World, fake_money: FakeMoney
) -> None:
    _, _, raw = world.accepted()
    sid = uuid.UUID(raw)

    async def run() -> dt.datetime:
        async with fast(world) as deps:
            t0 = svc.utcnow()
            await start(deps, sid, t0)
            await alive(deps, sid, at(t0, 2.4))  # astrologer's last frame
            await alive(deps, sid, at(t0, 2.9), "user")
            assert (await billing_meter.tick(deps, at(t0, 3.0))).charged == [
                (sid, 2),
                (sid, 3),
                (sid, 4),
            ]
            await alive(deps, sid, at(t0, 50), "user")
            await alive(deps, sid, at(t0, 93), "user")
            report = await billing_meter.tick(deps, at(t0, 93.5))
            assert report.charged == [] and report.ended == [(sid, "astrologer_dropped")]
            return t0

    t0 = asyncio.run(run())
    row = world.row(sid)
    assert row.status == "completed" and row.billed_minutes == 4
    assert row.ended_at is not None and abs((row.ended_at - at(t0, 2.4)).total_seconds()) < 0.01
    facts = fake_money.refund_facts[0]
    assert facts.end_reason == "astrologer_dropped"
    assert facts.astrologer_last_seen_at is not None
    assert abs((facts.astrologer_last_seen_at - at(t0, 2.4)).total_seconds()) < 0.01
    assert world.client.get(f"/v1/astrologers/{world.slug}").json()["presence"] == "offline"


def test_after_end_steps_rerun_after_a_crash(world: World, fake_money: FakeMoney) -> None:
    _, _, raw = world.accepted()
    sid = uuid.UUID(raw)

    async def crash_after_end_commit() -> None:
        async with deps_for(world.settings) as deps:
            await start(deps, sid, svc.utcnow())
            async with deps.sessionmaker() as db:
                s = await svc.lock(db, sid)
                assert s is not None
                await svc.finish(db, deps, s, "completed", "user_ended", svc.utcnow())
                await db.commit()
            # ...the process dies here: no refunds, presence still busy, settled_at empty.

    asyncio.run(crash_after_end_commit())
    assert world.row(sid).settled_at is None and fake_money.refunded() == []
    assert world.client.get(f"/v1/astrologers/{world.slug}").json()["presence"] == "busy"

    async def later_tick() -> None:
        async with deps_for(world.settings) as deps:
            await billing_meter.tick(deps, svc.utcnow())  # too soon: the owner may still run it
            assert fake_money.refunded() == []
            await billing_meter.tick(deps, svc.utcnow() + dt.timedelta(seconds=31))

    asyncio.run(later_tick())
    assert fake_money.refunded() == [sid] and world.row(sid).settled_at is not None
    assert world.client.get(f"/v1/astrologers/{world.slug}").json()["presence"] == "offline"


def test_charge_failure_rolls_back_and_is_retried(
    world: World, fake_money: FakeMoney, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, raw = world.accepted()
    sid = uuid.UUID(raw)
    real = wallet.charge_minute

    async def broken(*args: Any, **kwargs: Any) -> Any:
        await real(*args, **kwargs)
        raise RuntimeError("database went away")

    async def run() -> None:
        async with fast(world) as deps:
            t0 = svc.utcnow()
            await start(deps, sid, t0)
            await alive(deps, sid, at(t0, 1.0))
            monkeypatch.setattr(wallet, "charge_minute", broken)
            with pytest.raises(RuntimeError):
                await billing_meter.tick(deps, at(t0, 1.0))
            monkeypatch.setattr(wallet, "charge_minute", real)
            assert (await billing_meter.tick(deps, at(t0, 1.1))).charged == [(sid, 2)]

    asyncio.run(run())
    assert fake_money.charged_minutes(sid) == [1, 2] and world.row(sid).billed_minutes == 2
    assert fake_money.calls[f"session:{sid}:minute:2"] == 2


def test_background_loop_only_when_enabled(clean: Any) -> None:
    quick = clean.model_copy(update={"meter_tick_seconds": 0.05})
    app = create_app(quick)
    with TestClient(app):
        assert getattr(app.state, "meter_task", None) is None  # APP_ENV=test: off by default
    app = create_app(quick)
    app.state.meter_enabled = True
    with TestClient(app):
        task = app.state.meter_task
        time.sleep(0.2)
        assert not task.done()
    assert task.cancelled() and app.state.meter_task is None
    off = create_app(clean.model_copy(update={"meter_tick_seconds": 0}))
    off.state.meter_enabled = True
    with TestClient(off):
        assert getattr(off.state, "meter_task", None) is None
