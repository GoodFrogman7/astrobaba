"""Chat WebSocket (docs/api/billing.md "Chat WebSocket", shapes in packages/shared/src/chat.ts).

`GET /v1/sessions/{id}/ws?ticket=...`. One socket per (session, role); a newer one replaces the
older (4009). Frames from the client refresh the heartbeat the meter relies on. Events reach the
socket through the Redis channel of the session, so the two sides may be served by different
API processes. Message text is never logged.

On a call (`kind: "call"`) the same socket is the control channel and the meter's heartbeat:
text `message` frames are refused (`call_has_no_text`), and after `hello` the socket gets a
`call` event with who is in the LiveKit room (sent again whenever that changes).
"""

import asyncio
import contextlib
import datetime as dt
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio import Redis
from sqlalchemy import select

from astro_api import chat_bus, ws_tickets
from astro_api import session_service as svc
from astro_api.models import ENDED_SESSION_STATUSES, Astrologer, ConsultSession
from astro_api.ratelimit import incr_window

router = APIRouter()
log = logging.getLogger("astro_api.chat")

CLOSE_ENDED = 4000
CLOSE_BAD_TICKET = 4001
CLOSE_FORBIDDEN = 4003
CLOSE_REPLACED = 4009
MAX_CHARS = 2000
MAX_CLIENT_ID = 64
RATE_LIMIT = 5
RATE_WINDOW_S = 5


async def _role_of(deps: svc.Deps, ticket: ws_tickets.Ticket) -> ConsultSession | None:
    """The session if the ticket's user still holds the ticket's role in it."""
    async with deps.sessionmaker() as db:
        s = await db.get(ConsultSession, ticket.session_id)
        if s is None:
            return None
        if ticket.role == "user" and s.user_id == ticket.user_id:
            return s
        if ticket.role == "astrologer":
            owner = (
                await db.execute(select(Astrologer.user_id).where(Astrologer.id == s.astrologer_id))
            ).scalar_one_or_none()
            if owner == ticket.user_id:
                return s
        return None


class Connection:
    def __init__(
        self, ws: WebSocket, deps: svc.Deps, session_id: uuid.UUID, role: str, kind: str = "chat"
    ) -> None:
        self.ws = ws
        self.kind = kind
        self.deps = deps
        self.redis: Redis = deps.redis
        self.session_id = session_id
        self.role = role
        self.other = "astrologer" if role == "user" else "user"
        self.conn_id = uuid.uuid4().hex
        self._send_lock = asyncio.Lock()

    async def send(self, event: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.ws.send_text(json.dumps(event, default=str))

    async def error(self, code: str, message: str) -> None:
        await self.send({"type": "error", "code": code, "message": message})

    async def seen(self) -> None:
        now = svc.utcnow()
        await chat_bus.touch(
            self.redis, self.session_id, self.role, now, svc.rules().heartbeat_grace_s
        )
        await chat_bus.refresh_role(self.redis, self.session_id, self.role)

    async def view(self) -> tuple[dict[str, Any], str]:
        async with self.deps.sessionmaker() as db:
            s = await db.get(ConsultSession, self.session_id)
            assert s is not None
            return await svc.view(db, self.deps, s, self.role), s.status

    # ------------------------------------------------------------ inbound

    async def reader(self) -> None:
        while True:
            raw = await self.ws.receive_text()
            await self.seen()
            try:
                frame = json.loads(raw)
                kind = frame.get("type") if isinstance(frame, dict) else None
            except ValueError:
                kind = None
            if kind == "ping":
                await self.send({"type": "pong"})
            elif kind == "typing":
                await chat_bus.publish_event(
                    self.redis, self.session_id, {"type": "typing", "sender": self.role}, self.other
                )
            elif kind == "message":
                await self.on_message(frame)
            else:
                await self.error("bad_frame", "Unknown frame.")

    async def on_message(self, frame: dict[str, Any]) -> None:
        if self.kind == "call":
            await self.error("call_has_no_text", "This is a voice call; text is not sent here.")
            return
        client_id, text = frame.get("client_id"), frame.get("text")
        if not isinstance(client_id, str) or not 1 <= len(client_id) <= MAX_CLIENT_ID:
            await self.error("bad_frame", "client_id is required (1-64 characters).")
            return
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_CHARS:
            await self.error("invalid_message", f"Messages are 1-{MAX_CHARS} characters.")
            return
        key = f"chatrl:{self.session_id}:{self.role}"
        if await incr_window(self.redis, key, RATE_WINDOW_S) > RATE_LIMIT:
            await self.error("rate_limited", "You are sending messages too fast.")
            return
        try:
            message, created = await svc.post_message(
                self.deps, self.session_id, self.role, client_id, text.strip()
            )
        except svc.NotActive:
            await self.error("session_not_active", "Messages can be sent while the chat is on.")
            return
        event = {"type": "message", "message": message}
        if created:
            await chat_bus.publish_event(self.redis, self.session_id, event)
        else:
            await self.send(event)  # a resend: echo the stored copy to the sender only

    # ------------------------------------------------------------ outbound

    async def relay(self, pubsub: Any) -> int:
        """Forward channel events to this socket; returns the close code when it must close."""
        async for item in pubsub.listen():
            if item.get("type") != "message":
                continue
            try:
                envelope = json.loads(item["data"])
            except ValueError:
                continue
            if envelope.get("control") == "replace":
                if envelope.get("role") == self.role and envelope.get("conn") != self.conn_id:
                    return CLOSE_REPLACED
                continue
            if envelope.get("to") not in ("both", self.role):
                continue
            event = envelope.get("event") or {}
            await self.send(event)
            if event.get("type") == "ended":
                return CLOSE_ENDED
        return CLOSE_ENDED


@router.websocket("/v1/sessions/{session_id}/ws")
async def chat_socket(websocket: WebSocket, session_id: uuid.UUID) -> None:
    deps = svc.Deps.of(websocket.app)
    origin = websocket.headers.get("origin")
    if origin is None or origin not in deps.settings.cors_origins:
        # Refused at the handshake (HTTP 403): only our own web origins may open a chat.
        await websocket.close(code=CLOSE_FORBIDDEN)
        return
    ticket = await ws_tickets.redeem(deps.redis, websocket.query_params.get("ticket"))
    await websocket.accept()
    if ticket is None or ticket.session_id != session_id:
        await websocket.close(code=CLOSE_BAD_TICKET)
        return
    found = await _role_of(deps, ticket)
    if found is None:
        await websocket.close(code=CLOSE_FORBIDDEN)
        return

    conn = Connection(websocket, deps, session_id, ticket.role, found.kind)
    pubsub = deps.redis.pubsub()
    await pubsub.subscribe(chat_bus.channel(session_id))
    try:
        await chat_bus.claim_role(deps.redis, session_id, conn.role, conn.conn_id)
        await conn.seen()
        session, status = await conn.view()
        await conn.send(
            {
                "type": "hello",
                "role": conn.role,
                "session": session,
                "server_time": svc.iso(dt.datetime.now(dt.UTC)),
            }
        )
        if status in ENDED_SESSION_STATUSES:
            await conn.send({"type": "ended", "session": session})
            await websocket.close(code=CLOSE_ENDED)
            return
        if conn.kind == "call":
            joined = chat_bus.joined_view(await chat_bus.call_state(deps.redis, session_id))
            await conn.send({"type": "call", "joined": joined})
        if status == "accepted" and await chat_bus.both_connected(deps.redis, session_id):
            await svc.activate(deps, session_id)

        reader = asyncio.create_task(conn.reader())
        relay = asyncio.create_task(conn.relay(pubsub))
        try:
            await asyncio.wait({reader, relay}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (reader, relay):
                task.cancel()
            # Retrieve every outcome so nothing is left unobserved.
            outcomes = await asyncio.gather(reader, relay, return_exceptions=True)
        failure = outcomes[0]
        if isinstance(outcomes[1], int):
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close(code=outcomes[1])
        elif isinstance(failure, Exception) and not isinstance(failure, WebSocketDisconnect):
            log.error("chat socket failed", extra={"error": type(failure).__name__})
    finally:
        with contextlib.suppress(Exception):
            await chat_bus.release_role(deps.redis, session_id, conn.role, conn.conn_id)
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe()
            await pubsub.aclose()  # type: ignore[no-untyped-call]
