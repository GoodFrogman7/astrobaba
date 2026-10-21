"""Voice calls (docs/api/portal.md §1, ADR-0008): create checks, call tokens, signed LiveKit
webhooks (real livekit-api verification), activation only with both sockets and both
participants, the `call` socket event, text refused on calls, and duplicate webhooks.

LiveKit itself is the in-memory FakeCalls (real JWT signing and verification, rooms in memory);
test_calls_meter.py covers drops, rejoins and room deletion on every end path, and
test_calls_livekit.py talks to a real dev server when one is running.
"""

import base64
import datetime as dt
import hashlib
import json
import uuid
from typing import Any

import jwt
import pytest
from livekit import api
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from astro_api import chat_bus
from astro_api.livekit_client import FakeCalls, room_name
from astro_api.models import Astrologer
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    ORIGIN,
    World,
    deps_for,
    fake_money_fixture,
    money_fixture,
    world_fixture,
)

pytestmark = pytest.mark.integration

KEY = "test-livekit-key"
SECRET = "test-livekit-secret-0123456789-abcdefgh"
PUBLIC_URL = "wss://calls.example.test"


# ---------------------------------------------------------------- helpers (shared by call tests)


def enable_calls(w: World, monkeypatch: pytest.MonkeyPatch, *, astrologer: bool = True) -> None:
    monkeypatch.setenv("FLAG_VOICE_CALLS", "true")
    if astrologer:
        set_call_enabled(w, True)


def set_call_enabled(w: World, value: bool) -> None:
    import asyncio

    async def run() -> None:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            a = await db.get(Astrologer, uuid.UUID(w.aid))
            assert a is not None
            a.flags = {**(a.flags or {}), "call_enabled": value}
            await db.commit()

    asyncio.run(run())


def install_fake(w: World) -> FakeCalls:
    fake = FakeCalls(KEY, SECRET, PUBLIC_URL)
    w.client.app.state.calls = fake  # type: ignore[attr-defined]
    return fake


def signed(event: dict[str, Any], key: str = KEY, secret: str = SECRET) -> tuple[bytes, str]:
    """A webhook signed the way LiveKit signs it: a JWT issued by the API key, HS256 with the
    secret, whose `sha256` claim is the base64 SHA-256 of the exact body."""
    body = json.dumps(event).encode()
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    token = (
        api.AccessToken(key, secret).with_sha256(digest).with_ttl(dt.timedelta(minutes=5)).to_jwt()
    )
    return body, token


def participant_event(
    sid: str,
    role: str,
    kind: str = "participant_joined",
    *,
    psid: str | None = None,
    at: dt.datetime | None = None,
    event_id: str | None = None,
) -> dict[str, Any]:
    return {
        "event": kind,
        "room": {"sid": "RM_test", "name": room_name(uuid.UUID(sid))},
        "participant": {"sid": psid or f"PA_{role}", "identity": role},
        "id": event_id or f"EV_{uuid.uuid4().hex}",
        "createdAt": str(int((at or dt.datetime.now(dt.UTC)).timestamp())),
    }


def post_webhook(w: World, event: dict[str, Any], **sign: str) -> Any:
    body, token = signed(event, **sign)
    return w.client.post(
        "/v1/calls/livekit/webhook",
        content=body,
        headers={"Authorization": token, "Content-Type": "application/webhook+json"},
    )


def connect(w: World, sid: str, headers: dict[str, str]) -> Any:
    ticket = w.ticket(sid, headers)
    return w.client.websocket_connect(
        f"/v1/sessions/{sid}/ws?ticket={ticket}", headers={"origin": ORIGIN}
    )


def until(ws: WebSocketTestSession, kind: str) -> dict[str, Any]:
    for _ in range(20):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == kind:
            return frame
    raise AssertionError(f"no {kind} frame")


def closed_with(ws: WebSocketTestSession) -> int:
    with pytest.raises(WebSocketDisconnect) as e:
        for _ in range(20):
            ws.receive_json()
    return int(e.value.code)


def code(r: Any) -> str:
    return str(r.json()["detail"]["code"])


def call_state(w: World, sid: str) -> dict[str, chat_bus.CallSide]:
    import asyncio

    async def run() -> dict[str, chat_bus.CallSide]:
        async with deps_for(w.settings) as deps:
            return await chat_bus.call_state(deps.redis, uuid.UUID(sid))

    return asyncio.run(run())


# ---------------------------------------------------------------- create


def test_create_call_needs_the_flag_and_the_astrologers_switch(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers, _ = world.user()
    monkeypatch.setenv("FLAG_VOICE_CALLS", "false")
    set_call_enabled(world, True)
    r = world.create(headers, kind="call")
    assert r.status_code == 409 and code(r) == "call_unavailable"

    monkeypatch.setenv("FLAG_VOICE_CALLS", "true")
    set_call_enabled(world, False)
    r = world.create(headers, kind="call")
    assert r.status_code == 409 and code(r) == "call_unavailable"

    set_call_enabled(world, True)
    r = world.create(headers, kind="call")
    assert r.status_code == 201, r.text
    view = r.json()
    assert view["kind"] == "call" and view["status"] == "requested"
    assert view["price_per_min_paise"] == 2000  # same price as chat

    # Same Idempotency-Key with the other kind is a different request.
    key = uuid.uuid4().hex
    other, _ = world.user("+919844440077")
    assert world.create(other, key, kind="call").status_code == 201
    r = world.create(other, key, kind="chat")
    assert r.status_code == 409 and code(r) == "idempotency_conflict"


def test_chat_create_is_unchanged_when_calls_are_on(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    headers, _ = world.user()
    r = world.create(headers)
    assert r.status_code == 201 and r.json()["kind"] == "chat"
    r = world.client.post(
        "/v1/sessions",
        json={"astrologer_id": world.aid, "kind": "video", "free": False},
        headers={**headers, "Idempotency-Key": uuid.uuid4().hex},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------- call token


def test_call_token_grants_join_microphone_only(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    fake = install_fake(world)
    user, _, sid = world.accepted(kind="call")
    room = f"session-{sid}"

    for headers, role in ((user, "user"), (world.astro, "astrologer")):
        r = world.client.post(f"/v1/sessions/{sid}/call-token", headers=headers)
        assert r.status_code == 200, r.text
        out = r.json()
        assert set(out) == {"url", "token", "room", "identity", "expires_in"}
        assert out["url"] == PUBLIC_URL and out["room"] == room
        assert out["identity"] == role and out["expires_in"] == 600

        claims = api.TokenVerifier(KEY, SECRET).verify(out["token"])
        assert claims.identity == role and claims.name == "" and claims.metadata == ""
        video = claims.video
        assert video is not None
        assert video.room == room and video.room_join is True
        assert video.can_publish is True and video.can_subscribe is True
        assert video.can_publish_sources == ["microphone"]
        assert video.can_publish_data is False
        assert not video.room_admin and not video.room_create and not video.room_list
        assert not video.room_record and not video.can_update_own_metadata

        raw = jwt.decode(out["token"], SECRET, algorithms=["HS256"], issuer=KEY)
        assert raw["sub"] == role and raw["exp"] - raw["nbf"] == 600
        assert raw["roomConfig"]["maxParticipants"] == 2
        assert "name" not in raw and "metadata" not in raw
        # Nothing about the person in the token.
        assert USER_PHONE_DIGITS not in out["token"]
    assert fake.created == [room, room]

    # Wrong secret does not verify.
    with pytest.raises(jwt.InvalidSignatureError):
        api.TokenVerifier(KEY, "another-secret-of-enough-length-000000").verify(out["token"])


USER_PHONE_DIGITS = "9844440001"


def test_call_token_only_for_joinable_calls(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    install_fake(world)
    # A chat session has no audio room.
    user, _, chat_sid = world.accepted()
    r = world.client.post(f"/v1/sessions/{chat_sid}/call-token", headers=user)
    assert r.status_code == 409 and code(r) == "session_not_joinable"
    assert world.post(chat_sid, "cancel", user).status_code == 200

    # A call still waiting for the astrologer cannot be joined; neither can an ended one.
    r = world.create(user, kind="call")
    sid = r.json()["id"]
    r = world.client.post(f"/v1/sessions/{sid}/call-token", headers=user)
    assert r.status_code == 409 and code(r) == "session_not_joinable"
    assert world.post(sid, "cancel", user).status_code == 200
    r = world.client.post(f"/v1/sessions/{sid}/call-token", headers=world.astro)
    assert r.status_code == 409 and code(r) == "session_not_joinable"

    # Someone else's call: 404, nothing revealed.
    _, _, sid = world.accepted("+919844440078", kind="call")
    stranger, _ = world.user("+919844440079")
    assert world.client.post(f"/v1/sessions/{sid}/call-token", headers=stranger).status_code == 404


# ---------------------------------------------------------------- webhook signature


def test_webhook_signature_is_verified_and_bad_ones_change_nothing(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    install_fake(world)
    _, _, sid = world.accepted(kind="call")
    event = participant_event(sid, "user")
    body, token = signed(event)
    url = "/v1/calls/livekit/webhook"

    bad: list[tuple[bytes, dict[str, str]]] = [
        (body, {}),  # missing
        (body, {"Authorization": "not-a-jwt"}),
        (body, {"Authorization": signed(event, secret="wrong-secret-0123456789-abcdefghij")[1]}),
        (body, {"Authorization": signed(event, key="another-key")[1]}),  # wrong issuer
        (body.replace(b"participant_joined", b"participant_left"), {"Authorization": token}),
        # Signature over a different body.
        (body, {"Authorization": signed(participant_event(sid, "astrologer"))[1]}),
    ]
    expired = jwt.encode(
        {"iss": KEY, "sha256": base64.b64encode(hashlib.sha256(body).digest()).decode(), "exp": 1},
        SECRET,
        algorithm="HS256",
    )
    bad.append((body, {"Authorization": expired}))
    for content, headers in bad:
        r = world.client.post(url, content=content, headers=headers)
        assert r.status_code == 401 and code(r) == "bad_signature", r.text
    assert not call_state(world, sid)["user"].joined

    # The genuine one (LiveKit sends the bare JWT; a Bearer prefix is accepted too).
    r = world.client.post(url, content=body, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json() == {"status": "ok"}
    assert call_state(world, sid)["user"].joined


def test_unknown_rooms_and_events_are_acknowledged_and_ignored(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    install_fake(world)
    chat_user, _, chat_sid = world.accepted()
    assert world.post(chat_sid, "cancel", chat_user).status_code == 200
    _, _, sid = world.accepted("+919844440080", kind="call")
    other_room = participant_event(sid, "user")
    other_room["room"]["name"] = "lobby"
    stranger = participant_event(sid, "user")
    stranger["participant"]["identity"] = "+919844440080"
    unknown_session = participant_event(str(uuid.uuid4()), "user")
    for event in (
        {"event": "room_started", "room": {"name": room_name(uuid.UUID(sid))}, "id": "EV_r1"},
        {"event": "track_published", "room": {"name": room_name(uuid.UUID(sid))}, "id": "EV_t1"},
        other_room,
        stranger,
        unknown_session,
        participant_event(chat_sid, "user"),  # a chat has no room
    ):
        r = post_webhook(world, event)
        assert r.status_code == 200 and r.json() == {"status": "ignored"}, event
    assert not any(side.joined for side in call_state(world, sid).values())


# ---------------------------------------------------------------- activation and the socket


def test_call_activates_only_with_both_sockets_and_both_participants(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    fake = install_fake(world)
    user, _, sid = world.accepted(kind="call")
    room = room_name(uuid.UUID(sid))

    with connect(world, sid, user) as wu, connect(world, sid, world.astro) as wa:
        assert wu.receive_json()["type"] == "hello"
        assert until(wu, "call") == {"type": "call", "joined": {"user": False, "astrologer": False}}
        assert wa.receive_json()["type"] == "hello"
        assert until(wa, "call")["joined"] == {"user": False, "astrologer": False}
        # Both sockets are up but nobody is in the audio room: still accepted, nothing charged.
        assert world.row(sid).status == "accepted"
        assert money.charged_minutes(uuid.UUID(sid)) == []

        joined_user = participant_event(sid, "user", event_id="EV_join_user")
        assert post_webhook(world, joined_user).json() == {"status": "ok"}
        assert until(wu, "call")["joined"] == {"user": True, "astrologer": False}
        assert until(wa, "call")["joined"] == {"user": True, "astrologer": False}
        assert world.row(sid).status == "accepted"

        # LiveKit retries: the same event id is processed once.
        r = post_webhook(world, joined_user)
        assert r.status_code == 200 and r.json() == {"status": "duplicate"}

        assert post_webhook(world, participant_event(sid, "astrologer")).json()["status"] == "ok"
        assert until(wu, "call")["joined"] == {"user": True, "astrologer": True}
        state = until(wu, "state")["session"]
        assert state["status"] == "active" and state["billed_minutes"] == 1
        assert until(wa, "state")["session"]["status"] == "active"
        assert money.charged_minutes(uuid.UUID(sid)) == [1]

        # Calls carry no text; ping still works (it is the meter's heartbeat).
        wu.send_json({"type": "message", "client_id": "c-1", "text": "hello?"})
        assert until(wu, "error")["code"] == "call_has_no_text"
        wa.send_json({"type": "ping"})
        assert until(wa, "pong") == {"type": "pong"}

        # A leave is announced at once (the meter decides about dropping later).
        left = participant_event(sid, "astrologer", "participant_left")
        assert post_webhook(world, left).json()["status"] == "ok"
        assert until(wu, "call")["joined"] == {"user": True, "astrologer": False}
        assert world.row(sid).status == "active"

        r = world.post(sid, "end", world.astro)
        assert r.status_code == 200 and r.json()["end_reason"] == "astrologer_ended"
        assert until(wu, "ended")["session"]["status"] == "completed"
        assert closed_with(wu) == 4000
        assert until(wa, "ended")["session"]["kind"] == "call"
        assert closed_with(wa) == 4000
    assert fake.deleted == [room]
    assert world.row(sid).settled_at is not None
    texts = [
        m["text"]
        for m in world.client.get(f"/v1/sessions/{sid}/messages", headers=user).json()["items"]
    ]
    assert texts == ["session_started", "session_ended:astrologer_ended"]


def test_join_after_the_end_closes_the_room_again(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    enable_calls(world, monkeypatch)
    fake = install_fake(world)
    user, _, sid = world.accepted(kind="call")
    assert world.post(sid, "cancel", user).status_code == 200
    room = room_name(uuid.UUID(sid))
    assert fake.deleted == [room]  # accepted: a token could have been issued
    # A token issued before the end is still valid for a few minutes: a join is undone.
    r = post_webhook(world, participant_event(sid, "user"))
    assert r.status_code == 200 and r.json() == {"status": "ignored"}
    assert fake.deleted == [room, room]
    # A leave after the end needs nothing.
    post_webhook(world, participant_event(sid, "user", "participant_left"))
    assert fake.deleted == [room, room]
