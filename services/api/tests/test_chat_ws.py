"""Chat WebSocket end to end with Starlette's TestClient for both roles: tickets, origin check,
activation, message relay, encryption at rest, history after reconnect, client_id dedupe, rate
limit, replacement (4009) and the end of a session (4000)."""

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from astro_api.chat_crypto import Sealed, aad
from astro_api.models_sessions import ChatMessage
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    ORIGIN,
    PRICE,
    FakeMoney,
    World,
    closed_with,
    connect,
    deps_for,
    fake_money_fixture,
    money_fixture,
    until,
    world_fixture,
)

pytestmark = pytest.mark.integration

SECRET_TEXT = "My question is about career in 2027, please"


def rows(w: World, sid: str) -> list[ChatMessage]:
    async def run() -> list[ChatMessage]:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            found = await db.execute(
                select(ChatMessage)
                .where(ChatMessage.session_id == uuid.UUID(sid))
                .order_by(ChatMessage.seq)
            )
            return list(found.scalars())

    return asyncio.run(run())


def test_both_sides_chat_end_to_end(world: World, money: Any) -> None:
    user, _, sid = world.accepted()
    with connect(world, sid, user) as wu:
        hello = wu.receive_json()
        assert hello["type"] == "hello" and hello["role"] == "user"
        assert hello["session"]["status"] == "accepted" and hello["server_time"]
        # Not active yet: messages are refused.
        wu.send_json({"type": "message", "client_id": "early-1", "text": "hi"})
        assert until(wu, "error")["code"] == "session_not_active"

        with connect(world, sid, world.astro) as wa:
            hello_a = wa.receive_json()
            assert hello_a["type"] == "hello" and hello_a["role"] == "astrologer"
            assert hello_a["session"]["minutes_left"] is None
            # Both connected: minute 1 charged, both get the active state.
            assert until(wu, "state")["session"]["status"] == "active"
            state_a = until(wa, "state")["session"]
            assert state_a["status"] == "active" and state_a["billed_minutes"] == 1
            assert money.charged_minutes(uuid.UUID(sid)) == [1]

            wu.send_json({"type": "message", "client_id": "c-1", "text": f"  {SECRET_TEXT} "})
            mine = until(wu, "message")["message"]
            theirs = until(wa, "message")["message"]
            assert mine == theirs
            assert mine["text"] == SECRET_TEXT and mine["sender"] == "user"
            assert mine["client_id"] == "c-1" and mine["seq"] == 2  # 1 = session_started

            # Resent client_id: the stored copy comes back to the sender only, no new row.
            wu.send_json({"type": "message", "client_id": "c-1", "text": SECRET_TEXT})
            assert until(wu, "message")["message"]["id"] == mine["id"]
            wa.send_json({"type": "typing"})
            assert until(wu, "typing") == {"type": "typing", "sender": "astrologer"}
            wa.send_json({"type": "message", "client_id": "a-1", "text": "Namaste"})
            assert until(wu, "message")["message"]["text"] == "Namaste"
            assert until(wa, "message")["message"]["seq"] == 3

            wu.send_json({"type": "ping"})
            assert until(wu, "pong") == {"type": "pong"}
            for bad in (
                {"type": "message", "client_id": "x-1", "text": "   "},
                {"type": "message", "client_id": "x-2", "text": "x" * 2001},
            ):
                wu.send_json(bad)
                assert until(wu, "error")["code"] == "invalid_message"
            wu.send_json({"type": "shout"})
            assert until(wu, "error")["code"] == "bad_frame"

            # End over REST: both sockets get `ended` and close with 4000.
            r = world.post(sid, "end", user)
            assert r.status_code == 200 and r.json()["end_reason"] == "user_ended"
            ended_u = until(wu, "ended")
            assert ended_u["session"]["status"] == "completed"
            assert ended_u["session"]["role"] == "user" and ended_u["session"]["can_review"]
            assert until(wa, "ended")["session"]["role"] == "astrologer"
            assert closed_with(wu) == 4000 and closed_with(wa) == 4000

    # Encrypted at rest: no plaintext in the row; decrypts only with the right AAD.
    stored = rows(world, sid)
    assert [m.sender for m in stored] == ["system", "user", "astrologer", "system"]
    user_row = stored[1]
    assert SECRET_TEXT.encode() not in user_row.ciphertext
    assert b"career" not in user_row.ciphertext and len(user_row.nonce) == 12
    assert user_row.key_id == "dev"
    from astro_api.chat_crypto import cipher_from_settings

    cipher = cipher_from_settings(world.settings)
    sealed = Sealed(user_row.ciphertext, user_row.nonce, user_row.key_id)
    assert cipher.decrypt(sealed, aad(user_row.session_id, 2)) == SECRET_TEXT
    with pytest.raises(Exception):  # noqa: B017 - InvalidTag
        cipher.decrypt(sealed, aad(user_row.session_id, 3))

    # History over REST after the socket is gone.
    history = world.client.get(f"/v1/sessions/{sid}/messages?after_seq=1", headers=user).json()
    assert [(m["seq"], m["text"]) for m in history["items"]] == [
        (2, SECRET_TEXT),
        (3, "Namaste"),
        (4, "session_ended:user_ended"),
    ]

    # A socket opened after the end gets hello, ended, then 4000.
    with connect(world, sid, world.astro) as late:
        assert late.receive_json()["type"] == "hello"
        assert late.receive_json()["type"] == "ended"
        assert closed_with(late) == 4000


def test_reconnect_replaces_and_resumes_history(world: World) -> None:
    user, _, sid = world.accepted()
    with connect(world, sid, world.astro) as wa:
        wa.receive_json()
        with connect(world, sid, user) as wu:
            wu.receive_json()
            until(wa, "state")
            wu.send_json({"type": "message", "client_id": "m-1", "text": "first"})
            first = until(wu, "message")["message"]
            # The same user opens a second socket (e.g. a new tab): the old one closes 4009.
            with connect(world, sid, user) as wu2:
                assert wu2.receive_json()["type"] == "hello"
                assert closed_with(wu) == 4009
                after = world.client.get(
                    f"/v1/sessions/{sid}/messages?after_seq=0", headers=user
                ).json()["items"]
                assert [m["text"] for m in after] == ["session_started", "first"]
                # Resent on the new socket after reconnecting: still one message.
                wu2.send_json({"type": "message", "client_id": "m-1", "text": "first"})
                assert until(wu2, "message")["message"]["id"] == first["id"]
                wu2.send_json({"type": "message", "client_id": "m-2", "text": "second"})
                assert until(wa, "message")["message"]["text"] == "first"
                assert until(wa, "message")["message"]["text"] == "second"
    assert [m.client_id for m in rows(world, sid) if m.sender == "user"] == ["m-1", "m-2"]


def test_rate_limit_five_messages_per_five_seconds(world: World) -> None:
    user, _, sid = world.accepted()
    with connect(world, sid, world.astro) as wa:
        wa.receive_json()
        with connect(world, sid, user) as wu:
            wu.receive_json()
            until(wa, "state")
            for i in range(5):
                wa.send_json({"type": "message", "client_id": f"r-{i}", "text": f"line {i}"})
                assert until(wa, "message")["message"]["client_id"] == f"r-{i}"
            wa.send_json({"type": "message", "client_id": "r-5", "text": "one too many"})
            assert until(wa, "error")["code"] == "rate_limited"
            # The other side has its own budget.
            wu.send_json({"type": "message", "client_id": "u-1", "text": "still fine"})
            seen = [until(wu, "message")["message"]["client_id"] for _ in range(6)]
            assert seen == ["r-0", "r-1", "r-2", "r-3", "r-4", "u-1"]
    assert len([m for m in rows(world, sid) if m.sender == "astrologer"]) == 5


def test_tickets_and_origin(world: World) -> None:
    user, _, sid = world.accepted()
    # Unknown ticket: accepted then closed 4001 so the client knows to fetch a new one.
    with world.client.websocket_connect(
        f"/v1/sessions/{sid}/ws?ticket=not-a-ticket", headers={"origin": ORIGIN}
    ) as ws:
        assert closed_with(ws) == 4001
    with world.client.websocket_connect(f"/v1/sessions/{sid}/ws", headers={"origin": ORIGIN}) as ws:
        assert closed_with(ws) == 4001

    # Single use.
    ticket = world.ticket(sid, user)
    path = f"/v1/sessions/{sid}/ws?ticket={ticket}"
    with world.client.websocket_connect(path, headers={"origin": ORIGIN}) as ws:
        assert ws.receive_json()["type"] == "hello"
    with world.client.websocket_connect(path, headers={"origin": ORIGIN}) as ws:
        assert closed_with(ws) == 4001

    # Bound to its session.
    other_user, _ = world.user("+919844440055")
    other = world.create(other_user).json()["id"]
    ticket = world.ticket(other, other_user)
    with world.client.websocket_connect(
        f"/v1/sessions/{sid}/ws?ticket={ticket}", headers={"origin": ORIGIN}
    ) as ws:
        assert closed_with(ws) == 4001

    # Wrong or missing Origin: refused at the handshake; the ticket is not even spent.
    ticket = world.ticket(sid, user)
    for headers in ({"origin": "https://evil.example"}, {}):
        with pytest.raises(WebSocketDisconnect) as e:  # noqa: SIM117
            with world.client.websocket_connect(
                f"/v1/sessions/{sid}/ws?ticket={ticket}", headers=headers
            ):
                pass
        assert e.value.code == 4003
    with world.client.websocket_connect(
        f"/v1/sessions/{sid}/ws?ticket={ticket}", headers={"origin": ORIGIN}
    ) as ws:
        assert ws.receive_json()["type"] == "hello"


def test_activation_without_funds_cancels(world: World, fake_money: FakeMoney) -> None:
    user, uid, sid = world.accepted(fund=PRICE * 2)
    fake_money.committed.real[uid] = 0  # spent elsewhere between accept and join
    with connect(world, sid, user) as wu:
        wu.receive_json()
        with connect(world, sid, world.astro) as wa:
            wa.receive_json()
            ended = until(wu, "ended")["session"]
            assert ended["status"] == "cancelled" and ended["end_reason"] == "insufficient_funds"
            assert until(wa, "ended")["session"]["billed_minutes"] == 0
            assert closed_with(wu) == 4000 and closed_with(wa) == 4000
    assert fake_money.charged_minutes(uuid.UUID(sid)) == []
