"""Safety in live chat (docs/api/trust.md §3): crisis language from the client is delivered and
flags the session (safety event row, `safety` socket event to both sides, again after every
hello, upsell paused); an astrologer message that breaks a conduct rule is refused, never stored
and only its reason code reaches the moderation queue. No message text in logs."""

import asyncio
import datetime as dt
import json
import logging
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from astro_api import billing_meter, chat_bus
from astro_api import session_service as svc
from astro_api.models_safety import ModerationEvent, SafetyEvent
from astro_api.models_sessions import ChatMessage
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    PRICE,
    World,
    alive,
    at,
    connect,
    deps_for,
    fast,
    money_fixture,
    until,
    world_fixture,
)

pytestmark = pytest.mark.integration

CRISIS = "I can't take it anymore, I want to end my life"
BLOCKED = "Pay me on GPay directly, it is cheaper"


def db_rows(w: World, model: Any, sid: str) -> list[Any]:
    async def run() -> list[Any]:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            found = await db.execute(select(model).where(model.session_id == uuid.UUID(sid)))
            return list(found.scalars())

    return asyncio.run(run())


def active(w: World) -> tuple[dict[str, str], str]:
    user, _, sid = w.accepted()
    return user, sid


def test_client_crisis_is_delivered_flagged_and_shown_to_both(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    user, sid = active(world)
    with connect(world, sid, user) as wu, connect(world, sid, world.astro) as wa:
        until(wu, "hello")
        until(wa, "hello")
        assert until(wu, "state")["session"]["safety_flag"] is False
        until(wa, "state")
        wu.send_json({"type": "message", "client_id": "c-1", "text": CRISIS})
        # Delivered to both, then the safety event to both.
        assert until(wa, "message")["message"]["text"] == CRISIS
        assert until(wu, "message")["message"]["text"] == CRISIS
        assert until(wa, "safety") == {"type": "safety", "kind": "self_harm"}
        assert until(wu, "safety") == {"type": "safety", "kind": "self_harm"}
        # A second crisis message re-sends the event but adds no second flag.
        wu.send_json({"type": "message", "client_id": "c-2", "text": "मुझे अब जीना नहीं है"})
        until(wa, "message")
        assert until(wa, "safety")["kind"] == "self_harm"

    events = db_rows(world, SafetyEvent, sid)
    assert [(e.kind, e.message_seq) for e in events] == [("self_harm", 2)]  # 1 = session_started
    assert set(SafetyEvent.__table__.columns.keys()) == {
        "id",
        "session_id",
        "message_seq",
        "kind",
        "at",
    }
    items = db_rows(world, ModerationEvent, sid)
    assert [(i.kind, i.reason, i.status) for i in items] == [("safety", "self_harm", "open")]

    # Every (re)connect of a flagged session gets the event right after hello.
    with connect(world, sid, world.astro) as wa2:
        hello = wa2.receive_json()
        assert hello["type"] == "hello" and hello["session"]["safety_flag"] is True
        assert wa2.receive_json() == {"type": "safety", "kind": "self_harm"}
    r = world.client.get(f"/v1/sessions/{sid}", headers=user)
    assert r.status_code == 200 and r.json()["safety_flag"] is True

    logged = "\n".join(f"{r.getMessage()} {r.__dict__}" for r in caplog.records)
    assert "end my life" not in logged and "जीना" not in logged


def test_astrologer_rule_break_is_refused_and_not_stored(world: World) -> None:
    user, sid = active(world)
    with connect(world, sid, user) as wu, connect(world, sid, world.astro) as wa:
        until(wu, "hello")
        until(wa, "hello")
        until(wu, "state")
        until(wa, "state")
        for attempt in ("a-1", "a-2"):
            wa.send_json({"type": "message", "client_id": attempt, "text": BLOCKED})
            err = until(wa, "error")
            assert err["code"] == "message_blocked"
            assert err["reason"] == "off_platform_payment" and err["client_id"] == attempt
            assert err["message"] and "GPay" not in err["message"]
        wa.send_json({"type": "message", "client_id": "a-3", "text": "Call me at 9876543210"})
        assert until(wa, "error")["reason"] == "contact_details"
        # The client got none of them: the next thing it sees is the astrologer's clean message.
        wa.send_json({"type": "message", "client_id": "a-4", "text": "Your Moon is in Cancer."})
        got = until(wu, "message")["message"]
        assert got["text"] == "Your Moon is in Cancer." and got["client_id"] == "a-4"
        assert until(wa, "message")["message"]["client_id"] == "a-4"  # its own echo
        # The client is never refused, even with the same words.
        wu.send_json({"type": "message", "client_id": "u-1", "text": BLOCKED})
        assert until(wa, "message")["message"]["text"] == BLOCKED

    stored = db_rows(world, ChatMessage, sid)
    assert [m.client_id for m in stored if m.sender != "system"] == ["a-4", "u-1"]
    items = sorted(
        ((i.kind, i.reason, i.count) for i in db_rows(world, ModerationEvent, sid)),
        key=lambda x: x[1],
    )
    assert items == [("refused", "contact_details", 1), ("refused", "off_platform_payment", 2)]
    assert db_rows(world, SafetyEvent, sid) == []


def test_refusal_on_an_inactive_session_records_nothing(world: World) -> None:
    _, sid = active(world)  # accepted, not active

    async def run() -> None:
        async with deps_for(world.settings) as deps:
            with pytest.raises(svc.NotActive):
                await svc.refuse_message(deps, uuid.UUID(sid), "guarantee")

    asyncio.run(run())
    assert db_rows(world, ModerationEvent, sid) == []


def test_flagged_session_gets_no_low_balance_but_still_ends_at_zero(
    world: World, money: Any
) -> None:
    _, _, raw = world.accepted(fund=3 * PRICE + 500)
    sid = uuid.UUID(raw)
    events: list[dict[str, Any]] = []

    async def run() -> None:
        async with fast(world) as deps:
            pubsub = deps.redis.pubsub()
            await pubsub.subscribe(chat_bus.channel(sid))
            t0 = svc.utcnow()
            await alive(deps, sid, t0)
            assert await svc.activate(deps, sid, t0)
            await svc.post_message(deps, sid, "user", "c-1", CRISIS, crisis="self_harm")
            for k in (1, 2, 3):
                await alive(deps, sid, at(t0, k - 0.1))
                await billing_meter.tick(deps, at(t0, k))
            for _ in range(40):
                m = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.05)
                if m is not None:
                    events.append(json.loads(m["data"]))
            await pubsub.aclose()

    asyncio.run(run())
    row = world.row(sid)
    assert row.status == "completed" and row.end_reason == "insufficient_funds"
    assert row.billed_minutes == 3
    assert [e for e in events if e.get("event", {}).get("type") == "low_balance"] == []
    texts = [
        m["text"]
        for m in world.client.get(f"/v1/sessions/{sid}/messages", headers=world.astro).json()[
            "items"
        ]
    ]
    assert "low_balance" not in texts
    assert texts[-1] == "session_ended:insufficient_funds"


def test_flag_is_written_once_per_kind_even_when_racing(world: World) -> None:
    _, _, raw = world.accepted()
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with deps_for(world.settings) as deps:
            t0 = svc.utcnow()
            await alive(deps, sid, t0)
            assert await svc.activate(deps, sid, t0)
            await asyncio.gather(
                *(
                    svc.post_message(deps, sid, "user", f"c-{i}", CRISIS, crisis="self_harm")
                    for i in range(5)
                )
            )
            await svc.post_message(deps, sid, "user", "e-1", "he is beating me", crisis="emergency")

    asyncio.run(run())
    kinds = sorted(e.kind for e in db_rows(world, SafetyEvent, str(sid)))
    assert kinds == ["emergency", "self_harm"]
    items = db_rows(world, ModerationEvent, str(sid))
    assert sorted(i.reason for i in items) == ["emergency", "self_harm"]
    assert all(i.session_id == sid for i in items)
    assert dt.datetime.now(dt.UTC) > min(e.at for e in db_rows(world, SafetyEvent, str(sid)))
