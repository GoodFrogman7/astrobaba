"""Voice calls: LiveKit join tokens and webhooks (docs/api/portal.md §1, ADR-0008).

A call is a consultation session with `kind: "call"`; everything about billing is the session
machinery (session_service.py, billing_meter.py). This module adds the audio side:

- `POST /v1/sessions/{id}/call-token`: a participant of an accepted/active call gets a
  10-minute LiveKit token for room `session-{id}`, identity = their role, microphone only.
- `POST /v1/calls/livekit/webhook`: LiveKit's signed webhooks. `participant_joined` /
  `participant_left` / `participant_connection_aborted` update who is in the room (Redis,
  session_service.call_participant), tell both sockets (`call` event) and may activate the
  session (both sockets and both participants). A side that left is dropped by the meter after
  heartbeat_grace_s unless it rejoins. A join into a session that has ended deletes the room
  again. Events are processed once per LiveKit event id (Redis, 24 h).

Nothing about a person reaches LiveKit, Redis or the logs: identities are roles and rooms are
session ids.
"""

import datetime as dt
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from astro_api import livekit_client
from astro_api import session_service as svc
from astro_api.auth import CurrentSession
from astro_api.db import Db
from astro_api.errors import ApiError
from astro_api.models import ENDED_SESSION_STATUSES, ConsultSession
from astro_api.sessions_api import participant

router = APIRouter(tags=["calls"])
log = logging.getLogger("astro_api.calls")

EVENT_TTL_S = 24 * 3600
JOINABLE = ("accepted", "active")


@router.post("/v1/sessions/{session_id}/call-token")
async def call_token(
    session_id: uuid.UUID, request: Request, session_user: CurrentSession, db: Db
) -> dict[str, Any]:
    """`CallToken` (chat.ts). Needed to join; a rejoin asks for a new one."""
    deps = svc.Deps.of(request.app)
    s, role = await participant(db, session_id, session_user[1])
    if s.kind != "call" or s.status not in JOINABLE:
        raise ApiError(409, "session_not_joinable", "This call cannot be joined now.")
    room = livekit_client.room_name(s.id)
    try:
        backend = deps.call_backend()
        token = backend.mint_token(room=room, identity=role)
    except (RuntimeError, ValueError):
        raise ApiError(409, "call_unavailable", "Voice calls are not available.") from None
    try:
        # Create the room up front (two participants, closes when empty) so LiveKit can run
        # with room auto-creation off. If this fails the join itself tells the client.
        await backend.ensure_room(room)
    except Exception as exc:
        log.warning(
            "call room create failed",
            extra={"session_id": str(s.id), "error": type(exc).__name__},
        )
    return {
        "url": backend.public_url,
        "token": token,
        "room": room,
        "identity": role,
        "expires_in": livekit_client.TOKEN_TTL_S,
    }


@router.post("/v1/calls/livekit/webhook")
async def livekit_webhook(request: Request) -> JSONResponse:
    """LiveKit webhook: signature first (401 and nothing stored when bad), then at most once
    per event id. Unknown rooms and events are acknowledged with 200 and ignored."""
    deps = svc.Deps.of(request.app)
    body = await request.body()
    try:
        event = deps.call_backend().verify_webhook(body, request.headers.get("authorization"))
    except (livekit_client.InvalidWebhook, RuntimeError, ValueError):
        raise ApiError(401, "bad_signature", "Webhook signature is not valid.") from None
    key = f"lkevt:{event.id}" if event.id else None
    if key is not None and not await deps.redis.set(key, "1", nx=True, ex=EVENT_TTL_S):
        return JSONResponse({"status": "duplicate"})
    try:
        outcome = await on_event(deps, event)
    except BaseException:
        if key is not None:
            await deps.redis.delete(key)  # LiveKit retries; let the retry be processed
        raise
    return JSONResponse({"status": outcome})


async def on_event(
    deps: svc.Deps, event: livekit_client.CallEvent, now: dt.datetime | None = None
) -> str:
    """Apply one verified webhook event; returns `ok` or `ignored`."""
    now = now or svc.utcnow()
    if event.event not in livekit_client.PARTICIPANT_EVENTS or event.identity not in svc.ROLES:
        return "ignored"
    session_id = livekit_client.session_of_room(event.room)
    if session_id is None:
        return "ignored"
    async with deps.sessionmaker() as db:
        s = await db.get(ConsultSession, session_id)
        if s is None or s.kind != "call":
            return "ignored"
        status = s.status
    joined = event.event == "participant_joined"
    if status in ENDED_SESSION_STATUSES:
        if joined:
            # Someone joined with a still-valid token after the end: close the room again.
            await svc.close_room(deps, session_id)
        return "ignored"
    if status not in JOINABLE:
        return "ignored"
    # LiveKit's event time (it can arrive late); never in the future.
    at = min(event.created_at, now) if event.created_at is not None else now
    await svc.call_participant(
        deps,
        session_id,
        event.identity,
        joined=joined,
        participant_sid=event.participant_sid,
        at=at,
    )
    return "ok"
