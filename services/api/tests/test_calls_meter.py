"""Voice calls and the meter (docs/api/portal.md §1 "Side gone", "On end"; ADR-0008), driven
with explicit ticks and an injected clock (billing_minute_seconds=1) like test_meter.py:

- a participant who leaves the LiveKit room (while their control socket stays open) is dropped
  after heartbeat_grace_s, at the time they left; a rejoin within the grace keeps billing; a
  rejoin after the grace (before the meter looked) still ends the call at the leave time;
- the late `participant_left` of a connection replaced by a newer one is ignored;
- the LiveKit room is deleted on every end path, and a failed delete never blocks or reverses
  the end: the meter's settle sweep retries it;
- before charging a call minute the meter lists the room: a missing participant counts as
  left, an unreachable (or slow) LiveKit means no charge, and the call ends at the first failed
  check once that lasts longer than the grace period; a brief flap keeps billing.
"""

import asyncio
import datetime as dt
import uuid
from typing import Any

import pytest

from astro_api import billing_meter, calls_api, chat_bus, livekit_client
from astro_api import session_service as svc
from astro_api.livekit_client import FakeCalls, room_name
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    PRICE,
    FakeMoney,
    World,
    deps_for,
    fake_money_fixture,
    money_fixture,
    world_fixture,
)
from services.api.tests.test_calls import enable_calls, install_fake

pytestmark = pytest.mark.integration
GRACE = 90.0


def at(t0: dt.datetime, seconds: float) -> dt.datetime:
    return t0 + dt.timedelta(seconds=seconds)


async def alive(deps: svc.Deps, sid: uuid.UUID, now: dt.datetime, *roles: str) -> None:
    """Control-socket traffic (ping) from these sides."""
    for role in roles or svc.ROLES:
        await chat_bus.touch(deps.redis, sid, role, now, GRACE)


async def room(
    deps: svc.Deps, sid: uuid.UUID, role: str, joined: bool, when: dt.datetime, psid: str = ""
) -> bool:
    return await calls_api.participant_event(
        deps, sid, role, joined=joined, participant_sid=psid or f"PA_{role}", at=when
    )


async def start_call(deps: svc.Deps, sid: uuid.UUID, t0: dt.datetime) -> None:
    await alive(deps, sid, t0)
    assert not await svc.activate(deps, sid, t0)  # sockets alone are not enough for a call
    await room(deps, sid, "user", True, t0)
    assert not await svc.activate(deps, sid, t0)
    await room(deps, sid, "astrologer", True, t0)
    assert await svc.activate(deps, sid, t0)


def fast(w: World, calls: FakeCalls) -> Any:
    return deps_for(w.settings, calls, billing_minute_seconds=1.0)


@pytest.fixture
def call(world: World, monkeypatch: pytest.MonkeyPatch) -> tuple[World, FakeCalls]:
    enable_calls(world, monkeypatch)
    return world, install_fake(world)


def test_left_participant_is_dropped_after_grace_at_the_time_they_left(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(kind="call")
    sid = uuid.UUID(raw)

    async def run() -> dt.datetime:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            assert await room(deps, sid, "astrologer", False, at(t0, 2.4))
            # Both control sockets keep pinging: only the audio room says the astrologer left.
            await alive(deps, sid, at(t0, 2.9))
            report = await billing_meter.tick(deps, at(t0, 3.0))
            assert report.charged == [(sid, 2), (sid, 3), (sid, 4)] and report.ended == []
            await alive(deps, sid, at(t0, 50))
            await alive(deps, sid, at(t0, 92))
            report = await billing_meter.tick(deps, at(t0, 92.5))
            assert report.charged == [] and report.ended == [(sid, "astrologer_dropped")]
            return t0

    t0 = asyncio.run(run())
    row = world.row(sid)
    assert row.status == "completed" and row.end_reason == "astrologer_dropped"
    assert row.billed_minutes == 4 and fake_money.charged_minutes(sid) == [1, 2, 3, 4]
    assert row.ended_at is not None and abs((row.ended_at - at(t0, 2.4)).total_seconds()) < 0.01
    facts = fake_money.refund_facts[0]
    assert facts.astrologer_last_seen_at is not None
    assert abs((facts.astrologer_last_seen_at - at(t0, 2.4)).total_seconds()) < 0.01
    assert fake.deleted == [room_name(sid)] and row.settled_at is not None


def test_rejoin_within_grace_keeps_billing(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(fund=200 * PRICE, kind="call")
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            await room(deps, sid, "user", False, at(t0, 5))  # network blip
            await alive(deps, sid, at(t0, 60))
            await room(deps, sid, "user", True, at(t0, 60), psid="PA_user_2")  # back, new sid
            await alive(deps, sid, at(t0, 99.5))
            report = await billing_meter.tick(deps, at(t0, 100))
            assert report.ended == [] and report.charged[-1] == (sid, 101)

    asyncio.run(run())
    row = world.row(sid)
    assert row.status == "active" and row.billed_minutes == 101
    assert fake.deleted == []


def test_rejoin_after_grace_still_ends_at_the_leave_time(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(kind="call")
    sid = uuid.UUID(raw)

    async def run() -> dt.datetime:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            await alive(deps, sid, at(t0, 1.5))
            assert (await billing_meter.tick(deps, at(t0, 1.5))).charged == [(sid, 2)]
            await room(deps, sid, "user", False, at(t0, 1.8))
            # Gone longer than the grace, back before any meter looked (e.g. meters down),
            # while both control sockets kept pinging.
            for k in (50, 100, 120):
                await alive(deps, sid, at(t0, k))
            await room(deps, sid, "user", True, at(t0, 120), psid="PA_user_2")
            report = await billing_meter.tick(deps, at(t0, 120.5))
            assert report.charged == [] and report.ended == [(sid, "user_dropped")]
            return t0

    t0 = asyncio.run(run())
    row = world.row(sid)
    assert row.end_reason == "user_dropped" and row.billed_minutes == 2
    assert row.ended_at is not None and abs((row.ended_at - at(t0, 1.8)).total_seconds()) < 0.01
    assert fake.deleted == [room_name(sid)]


def test_replaced_connection_and_out_of_order_events_are_ignored(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(fund=200 * PRICE, kind="call")
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            # The user opens the call on a second device: LiveKit replaces the first
            # connection (same identity) and reports the old one's leave afterwards.
            assert await room(deps, sid, "user", True, at(t0, 10), psid="PA_user_2")
            assert not await room(deps, sid, "user", False, at(t0, 10), psid="PA_user")
            # A duplicate join and a stale event (older than what we have) change nothing.
            assert not await room(deps, sid, "user", True, at(t0, 11), psid="PA_user_2")
            assert not await room(deps, sid, "astrologer", False, at(t0, -5))
            state = await chat_bus.call_state(deps.redis, sid)
            assert state["user"].joined and state["astrologer"].joined
            await alive(deps, sid, at(t0, 50))
            await alive(deps, sid, at(t0, 95))
            assert (await billing_meter.tick(deps, at(t0, 95))).ended == []

    asyncio.run(run())
    assert world.row(sid).status == "active"


# ---------------------------------------------------------------- room deletion on every end


def test_room_deleted_on_every_end_path(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    """One path after another (an astrologer has one accepted session at a time)."""
    world, fake = call
    ended: list[uuid.UUID] = []

    def run(fn: Any) -> None:
        async def go() -> None:
            async with fast(world, fake) as deps:
                await fn(deps)

        asyncio.run(go())

    # User ends, astrologer ends (REST).
    for phone, ender, reason in (
        ("+919844440201", "user", "user_ended"),
        ("+919844440202", "astrologer", "astrologer_ended"),
    ):
        user, _, raw = world.accepted(phone, kind="call")
        sid = uuid.UUID(raw)

        async def started(deps: svc.Deps, sid: uuid.UUID = sid) -> None:
            await start_call(deps, sid, svc.utcnow())

        run(started)
        r = world.post(raw, "end", user if ender == "user" else world.astro)
        assert r.status_code == 200 and r.json()["end_reason"] == reason
        ended.append(sid)

    # Funds run out mid-call (meter, at the minute boundary).
    _, _, raw = world.accepted("+919844440203", fund=2 * PRICE + 100, kind="call")
    broke = uuid.UUID(raw)

    async def runs_dry(deps: svc.Deps) -> None:
        t0 = svc.utcnow()
        await start_call(deps, broke, t0)
        for k in (1, 2):
            await alive(deps, broke, at(t0, k - 0.1))
            await billing_meter.tick(deps, at(t0, k))

    run(runs_dry)
    assert world.row(broke).end_reason == "insufficient_funds"
    ended.append(broke)

    # The wallet was emptied between accept and both joining (activation fails).
    _, uid, raw = world.accepted("+919844440204", kind="call")
    no_funds = uuid.UUID(raw)
    fake_money.committed.real[uid] = 0

    async def cannot_start(deps: svc.Deps) -> None:
        t0 = svc.utcnow()
        await alive(deps, no_funds, t0)
        await room(deps, no_funds, "user", True, t0)
        await room(deps, no_funds, "astrologer", True, t0)
        assert not await svc.activate(deps, no_funds, t0)

    run(cannot_start)
    assert world.row(no_funds).status == "cancelled"
    assert world.row(no_funds).end_reason == "insufficient_funds"
    ended.append(no_funds)

    # Nobody joined in time.
    _, _, raw = world.accepted("+919844440205", kind="call")
    timeout = uuid.UUID(raw)

    async def times_out(deps: svc.Deps) -> None:
        await billing_meter.tick(deps, svc.utcnow() + dt.timedelta(seconds=GRACE + 5))

    run(times_out)
    assert world.row(timeout).end_reason == "join_timeout"
    ended.append(timeout)

    # The user cancels after accept (a token may already have been issued).
    user, _, raw = world.accepted("+919844440206", kind="call")
    assert world.post(raw, "cancel", user).status_code == 200
    ended.append(uuid.UUID(raw))

    assert fake.deleted == [room_name(s) for s in ended]

    # A call cancelled before accept never had a room: nothing to delete.
    user, _ = world.user("+919844440207")
    raw = world.create(user, kind="call").json()["id"]
    assert world.post(raw, "cancel", user).status_code == 200
    assert fake.deleted == [room_name(s) for s in ended]


def test_failed_room_delete_never_blocks_the_end_and_is_retried(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    user, _, raw = world.accepted(kind="call")
    sid = uuid.UUID(raw)

    async def go() -> None:
        async with fast(world, fake) as deps:
            await start_call(deps, sid, svc.utcnow())

    asyncio.run(go())
    fake.fail_deletes = 1  # LiveKit unreachable for a moment
    r = world.post(raw, "end", user)
    assert r.status_code == 200 and r.json()["status"] == "completed"
    row = world.row(sid)
    assert row.status == "completed" and row.settled_at is None and fake.deleted == []
    assert fake_money.refunded() == [sid]  # the rest of after_end ran

    async def sweep() -> None:
        async with fast(world, fake) as deps:
            await billing_meter.tick(deps, svc.utcnow() + dt.timedelta(seconds=31))

    asyncio.run(sweep())
    assert fake.deleted == [room_name(sid)] and world.row(sid).settled_at is not None
    assert world.row(sid).end_reason == "user_ended"  # never reversed


def test_chat_sessions_never_touch_livekit(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    user, _, raw = world.accepted()

    async def go() -> None:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await alive(deps, uuid.UUID(raw), t0)
            assert await svc.activate(deps, uuid.UUID(raw), t0)  # no audio room needed

    asyncio.run(go())
    assert world.post(raw, "end", user).status_code == 200
    assert fake.deleted == [] and fake.created == []


# ---------------------------------------------------------------- presence checks with LiveKit


def audit_actions(w: World, sid: uuid.UUID) -> list[str]:
    from sqlalchemy import select

    from astro_api.models import AuditLog

    async def run() -> list[str]:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            rows = await db.execute(select(AuditLog.action).where(AuditLog.entity_id == str(sid)))
            return list(rows.scalars())

    return asyncio.run(run())


def test_livekit_silently_gone_stops_billing_and_ends_at_first_failure(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(kind="call")
    sid = uuid.UUID(raw)
    name = room_name(sid)

    async def run() -> dt.datetime:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            await alive(deps, sid, at(t0, 0.9))
            assert (await billing_meter.tick(deps, at(t0, 1.0))).charged == [(sid, 2)]
            assert fake.listed == [name]
            fake.down = True  # LiveKit stops answering; no webhook says anything
            for k in (2.0, 2.5, 3.0, 50.0, 91.5):
                await alive(deps, sid, at(t0, k))  # both control sockets are fine
                report = await billing_meter.tick(deps, at(t0, k))
                assert report.charged == [] and report.ended == []
            # One check per boundary, then one retry per minute (2.5 was skipped).
            assert len(fake.listed) == 1 + 4
            report = await billing_meter.tick(deps, at(t0, 92.5))
            assert report.charged == [] and report.ended == [(sid, "service_unavailable")]
            return t0

    t0 = asyncio.run(run())
    row = world.row(sid)
    assert row.status == "completed" and row.end_reason == "service_unavailable"
    assert row.billed_minutes == 2 and fake_money.charged_minutes(sid) == [1, 2]
    assert row.ended_at is not None and abs((row.ended_at - at(t0, 2.0)).total_seconds()) < 0.01
    assert "session.call_unverified" in audit_actions(world, sid)
    facts = fake_money.refund_facts[0]
    assert facts.astrologer_last_seen_at is not None
    assert abs((facts.astrologer_last_seen_at - at(t0, 2.0)).total_seconds()) < 0.01
    assert fake.deleted == [name]


def test_livekit_flapping_briefly_keeps_billing(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(fund=200 * PRICE, kind="call")
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            await alive(deps, sid, at(t0, 0.9))
            assert (await billing_meter.tick(deps, at(t0, 1.0))).charged == [(sid, 2)]
            fake.down = True
            await alive(deps, sid, at(t0, 2.0))
            assert (await billing_meter.tick(deps, at(t0, 2.0))).charged == []  # unverified
            assert (await chat_bus.verify_state(deps.redis, sid)).fail_since is not None
            fake.down = False
            await alive(deps, sid, at(t0, 3.0))
            # Confirmed again: the minutes that started meanwhile are charged once.
            assert (await billing_meter.tick(deps, at(t0, 3.0))).charged == [(sid, 3), (sid, 4)]
            assert (await chat_bus.verify_state(deps.redis, sid)).fail_since is None
            await alive(deps, sid, at(t0, 50))
            await alive(deps, sid, at(t0, 95))
            report = await billing_meter.tick(deps, at(t0, 95.5))
            assert report.ended == [] and report.charged[-1] == (sid, 96)

    asyncio.run(run())
    row = world.row(sid)
    assert row.status == "active" and row.billed_minutes == 96
    assert fake_money.charged_minutes(sid) == list(range(1, 97))


def test_participant_missing_from_the_listing_is_treated_as_left(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(kind="call")
    sid = uuid.UUID(raw)
    fake.present[room_name(sid)] = {"user"}  # the astrologer's audio is gone; no webhook came

    async def run() -> dt.datetime:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            await alive(deps, sid, at(t0, 0.9))
            report = await billing_meter.tick(deps, at(t0, 1.0))
            assert report.charged == [(sid, 2)] and report.ended == []  # grace still applies
            state = await chat_bus.call_state(deps.redis, sid)
            assert state["user"].joined and not state["astrologer"].joined
            left_at = state["astrologer"].left_at
            assert left_at is not None and abs((left_at - at(t0, 1.0)).total_seconds()) < 0.01
            for k in (50, 91):
                await alive(deps, sid, at(t0, k))
            report = await billing_meter.tick(deps, at(t0, 91.5))
            assert report.ended == [(sid, "astrologer_dropped")]
            return t0

    t0 = asyncio.run(run())
    row = world.row(sid)
    assert row.end_reason == "astrologer_dropped" and row.billed_minutes == 2
    assert row.ended_at is not None and abs((row.ended_at - at(t0, 1.0)).total_seconds()) < 0.01
    assert "session.call_unverified" not in audit_actions(world, sid)


def test_rejoin_webhook_after_a_listing_leave_counts_even_with_an_earlier_second(
    call: tuple[World, FakeCalls], fake_money: FakeMoney
) -> None:
    world, fake = call
    _, _, raw = world.accepted(fund=200 * PRICE, kind="call")
    sid = uuid.UUID(raw)
    fake.present[room_name(sid)] = {"user"}

    async def run() -> None:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            await billing_meter.tick(deps, at(t0, 1.6))  # listing: astrologer missing at 1.6
            # The reconnect happened at 1.7, but webhook times are whole seconds.
            fake.present.pop(room_name(sid))
            assert await room(deps, sid, "astrologer", True, at(t0, 1.0), psid="PA_astro_2")
            for k in (50, 95):
                await alive(deps, sid, at(t0, k))
            assert (await billing_meter.tick(deps, at(t0, 95.5))).ended == []

    asyncio.run(run())
    assert world.row(sid).status == "active"


def test_a_slow_livekit_counts_as_unreachable(
    call: tuple[World, FakeCalls], fake_money: FakeMoney, monkeypatch: pytest.MonkeyPatch
) -> None:
    world, fake = call
    _, _, raw = world.accepted(kind="call")
    sid = uuid.UUID(raw)

    async def slow(room_name: str) -> set[str]:
        await asyncio.sleep(5)
        return {"user", "astrologer"}

    async def run() -> None:
        async with fast(world, fake) as deps:
            t0 = svc.utcnow()
            await start_call(deps, sid, t0)
            monkeypatch.setattr(livekit_client, "VERIFY_TIMEOUT_S", 0.2)
            monkeypatch.setattr(fake, "list_participants", slow)
            await alive(deps, sid, at(t0, 1.0))
            started = asyncio.get_running_loop().time()
            assert (await billing_meter.tick(deps, at(t0, 1.0))).charged == []
            assert asyncio.get_running_loop().time() - started < 2
            failed = (await chat_bus.verify_state(deps.redis, sid)).fail_since
            assert failed is not None and abs((failed - at(t0, 1.0)).total_seconds()) < 0.01

    asyncio.run(run())
    assert world.row(sid).billed_minutes == 1
