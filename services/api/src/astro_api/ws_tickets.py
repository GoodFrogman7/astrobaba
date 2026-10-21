"""Single-use WebSocket tickets (ADR-0007).

Browsers cannot send an Authorization header on a WebSocket, and a bearer token in a URL ends up
in proxy logs. So the client asks for a ticket over authenticated REST and opens the socket with
`?ticket=`. A ticket is random, lives 30 s in Redis (only its SHA-256 is the key), is bound to
(user, session, role) and is deleted atomically on first use.
"""

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

TICKET_TTL_S = 30


@dataclass(frozen=True)
class Ticket:
    user_id: uuid.UUID
    session_id: uuid.UUID
    role: str


def _key(ticket: str) -> str:
    return "wst:" + hashlib.sha256(ticket.encode()).hexdigest()


async def issue(redis: Redis, *, user_id: uuid.UUID, session_id: uuid.UUID, role: str) -> str:
    ticket = secrets.token_urlsafe(32)
    value = json.dumps({"u": str(user_id), "s": str(session_id), "r": role})
    await redis.set(_key(ticket), value, ex=TICKET_TTL_S)
    return ticket


async def redeem(redis: Redis, ticket: str | None) -> Ticket | None:
    """The ticket's binding, or None when unknown, expired or already used."""
    if not ticket or len(ticket) > 128:
        return None
    raw = await redis.getdel(_key(ticket))
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        return Ticket(uuid.UUID(data["u"]), uuid.UUID(data["s"]), str(data["r"]))
    except (ValueError, KeyError, TypeError):
        return None
