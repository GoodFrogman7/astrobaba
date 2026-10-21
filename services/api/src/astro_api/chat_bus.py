"""Redis side of a chat session: pub/sub fan-out, socket ownership and heartbeats (ADR-0007).

- `chat:{session_id}` (pub/sub): every API process holding a socket for the session subscribes,
  so a message written by one process reaches the other side wherever it is connected.
  Envelopes are JSON: `{"to": "both"|"user"|"astrologer", "event": ServerEvent}` or a control
  message `{"control": "replace", "role", "conn"}` (a newer socket took over that role).
- `conn:{session_id}:{role}`: id of the socket that currently owns the role (TTL, refreshed by
  traffic). Activation needs both.
- `hb:{session_id}:{role}`: epoch seconds the side was last seen (socket traffic). Never moves
  backwards. If a touch finds the previous value older than the grace period, the previous value
  is kept in `hbgap:{session_id}:{role}` (first gap wins), so the meter still sees that the side
  was gone even when the client reconnected before the meter looked, e.g. after an API outage.

Nothing here carries message text except the `message` event payload itself, which goes only to
the session's own channel.
"""

import datetime as dt
import json
import uuid
from typing import Any

from redis.asyncio import Redis

ROLES = ("user", "astrologer")
HB_TTL_S = 24 * 3600
CONN_TTL_S = 75  # clients ping every 20 s

_TOUCH = """
local prev = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[1])
if prev and tonumber(prev) >= now then
  return prev
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
if prev and (now - tonumber(prev)) > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], prev, 'NX', 'EX', ARGV[3])
end
return prev
"""

_RELEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def channel(session_id: uuid.UUID) -> str:
    return f"chat:{session_id}"


def hb_key(session_id: uuid.UUID, role: str) -> str:
    return f"hb:{session_id}:{role}"


def gap_key(session_id: uuid.UUID, role: str) -> str:
    return f"hbgap:{session_id}:{role}"


def conn_key(session_id: uuid.UUID, role: str) -> str:
    return f"conn:{session_id}:{role}"


def _ts(v: bytes | str | None) -> dt.datetime | None:
    if v is None:
        return None
    try:
        return dt.datetime.fromtimestamp(float(v.decode() if isinstance(v, bytes) else v), dt.UTC)
    except ValueError:
        return None


# ---------------------------------------------------------------- fan-out


async def publish(redis: Redis, session_id: uuid.UUID, envelope: dict[str, Any]) -> None:
    await redis.publish(channel(session_id), json.dumps(envelope, default=str))


async def publish_event(
    redis: Redis, session_id: uuid.UUID, event: dict[str, Any], to: str = "both"
) -> None:
    await publish(redis, session_id, {"to": to, "event": event})


# ---------------------------------------------------------------- heartbeats


async def touch(
    redis: Redis, session_id: uuid.UUID, role: str, now: dt.datetime, grace_s: float
) -> None:
    """Record that `role` was seen at `now` (socket connect, any frame)."""
    await redis.eval(
        _TOUCH,
        2,
        hb_key(session_id, role),
        gap_key(session_id, role),
        f"{now.timestamp():.3f}",
        str(grace_s),
        str(HB_TTL_S),
    )


async def last_seen(
    redis: Redis, session_id: uuid.UUID
) -> dict[str, tuple[dt.datetime | None, dt.datetime | None]]:
    """{role: (last seen, start of the first silence longer than grace or None)}."""
    keys = [hb_key(session_id, r) for r in ROLES] + [gap_key(session_id, r) for r in ROLES]
    values = await redis.mget(keys)
    return {r: (_ts(values[i]), _ts(values[i + len(ROLES)])) for i, r in enumerate(ROLES)}


async def clear_gaps(redis: Redis, session_id: uuid.UUID) -> None:
    await redis.delete(*(gap_key(session_id, r) for r in ROLES))


# ---------------------------------------------------------------- socket ownership


async def claim_role(redis: Redis, session_id: uuid.UUID, role: str, conn_id: str) -> None:
    """This socket now owns the role; any older socket for it is told to close (4009)."""
    await redis.set(conn_key(session_id, role), conn_id, ex=CONN_TTL_S)
    await publish(redis, session_id, {"control": "replace", "role": role, "conn": conn_id})


async def refresh_role(redis: Redis, session_id: uuid.UUID, role: str) -> None:
    await redis.expire(conn_key(session_id, role), CONN_TTL_S)


async def release_role(redis: Redis, session_id: uuid.UUID, role: str, conn_id: str) -> None:
    await redis.eval(_RELEASE, 1, conn_key(session_id, role), conn_id)


async def both_connected(redis: Redis, session_id: uuid.UUID) -> bool:
    values = await redis.mget([conn_key(session_id, r) for r in ROLES])
    return all(v is not None for v in values)
