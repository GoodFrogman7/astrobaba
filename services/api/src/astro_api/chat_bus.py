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
- `call:{session_id}:{role}` (calls only, hash `state`, `psid`, `at`): whether the role is in the
  LiveKit room, from LiveKit webhooks. `psid` is the LiveKit participant sid of the current
  connection, so the late `participant_left` of a connection that a newer one replaced (same
  identity) is ignored; `at` orders events that arrive out of order. A rejoin after more than
  the grace period records the leave time in `hbgap:` exactly like a heartbeat gap.
- `callver:{session_id}` (calls only, hash): the meter's presence checks against LiveKit before
  charging. `ok_upto` = highest minute that a successful room listing covers, `last_try` = time
  of the last check, `fail_since` = when checks started failing (cleared by a success).
  `callverclaim:{session_id}` keeps two meter processes from checking the same call at once.

Nothing here carries message text except the `message` event payload itself, which goes only to
the session's own channel. `safety` events (docs/api/trust.md §3) carry the crisis kind only.
"""

import datetime as dt
import json
import uuid
from dataclasses import dataclass
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


_CALL_MARK = """
local state = redis.call('HGET', KEYS[1], 'state')
local psid = redis.call('HGET', KEYS[1], 'psid')
local prev_at = tonumber(redis.call('HGET', KEYS[1], 'at') or '0')
local at = tonumber(ARGV[3])
-- A join by a new connection after a leave is always news: the meter's room listing records a
-- leave at its own clock, which can be later than the 1-second webhook time of the rejoin.
local new_conn = ARGV[1] == 'joined' and state == 'left' and psid ~= ARGV[2]
if state and at < prev_at and not new_conn then
  return 0
end
if ARGV[1] == 'joined' then
  if state == 'joined' and psid == ARGV[2] then
    return 0
  end
  if state == 'left' and (at - prev_at) > tonumber(ARGV[4]) then
    redis.call('SET', KEYS[2], tostring(prev_at), 'NX', 'EX', ARGV[5])
  end
  redis.call('HSET', KEYS[1], 'state', 'joined', 'psid', ARGV[2], 'at', ARGV[3])
else
  if state ~= 'joined' then
    return 0
  end
  if psid and psid ~= '' and ARGV[2] ~= '' and psid ~= ARGV[2] then
    return 0
  end
  redis.call('HSET', KEYS[1], 'state', 'left', 'at', ARGV[3])
end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
"""


def channel(session_id: uuid.UUID) -> str:
    return f"chat:{session_id}"


def hb_key(session_id: uuid.UUID, role: str) -> str:
    return f"hb:{session_id}:{role}"


def gap_key(session_id: uuid.UUID, role: str) -> str:
    return f"hbgap:{session_id}:{role}"


def conn_key(session_id: uuid.UUID, role: str) -> str:
    return f"conn:{session_id}:{role}"


def call_key(session_id: uuid.UUID, role: str) -> str:
    return f"call:{session_id}:{role}"


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


def safety_event() -> dict[str, Any]:
    """`{type: "safety", kind: "self_harm"}` (chat.ts): the client shows the crisis resources
    and the not-a-helpline notice, the astrologer the crisis guidance (conduct.json). `kind`
    names the banner: an emergency flag (danger, violence) shows the same resources (112)."""
    return {"type": "safety", "kind": "self_harm"}


async def publish_safety(redis: Redis, session_id: uuid.UUID) -> None:
    """Tell both sides that the session was flagged."""
    await publish_event(redis, session_id, safety_event(), to="both")


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


# ---------------------------------------------------------------- calls: who is in the audio room


@dataclass(frozen=True)
class CallSide:
    joined: bool
    left_at: dt.datetime | None  # set while the side is out of the room after having joined


async def call_mark(
    redis: Redis,
    session_id: uuid.UUID,
    role: str,
    *,
    joined: bool,
    participant_sid: str,
    at: dt.datetime,
    grace_s: float,
) -> bool:
    """Apply a LiveKit join/leave for `role`; False when it changes nothing (a duplicate, an
    out-of-order event or the leave of a replaced connection)."""
    changed = await redis.eval(
        _CALL_MARK,
        2,
        call_key(session_id, role),
        gap_key(session_id, role),
        "joined" if joined else "left",
        participant_sid,
        f"{at.timestamp():.3f}",
        str(grace_s),
        str(HB_TTL_S),
    )
    return bool(changed)


async def call_state(redis: Redis, session_id: uuid.UUID) -> dict[str, CallSide]:
    out: dict[str, CallSide] = {}
    for role in ROLES:
        raw = await redis.hmget(call_key(session_id, role), ["state", "at"])
        state = raw[0].decode() if isinstance(raw[0], bytes) else raw[0]
        out[role] = CallSide(state == "joined", _ts(raw[1]) if state == "left" else None)
    return out


def joined_view(state: dict[str, CallSide]) -> dict[str, bool]:
    """`joined` of the `call` socket event (chat.ts)."""
    return {role: state[role].joined for role in ROLES}


async def both_joined(redis: Redis, session_id: uuid.UUID) -> bool:
    return all(side.joined for side in (await call_state(redis, session_id)).values())


# ---------------------------------------------------------------- calls: presence checks


@dataclass(frozen=True)
class VerifyState:
    ok_upto: int  # minutes up to this one may be charged (0: none checked yet)
    last_try: dt.datetime | None
    fail_since: dt.datetime | None


def verify_key(session_id: uuid.UUID) -> str:
    return f"callver:{session_id}"


async def verify_state(redis: Redis, session_id: uuid.UUID) -> VerifyState:
    raw = await redis.hmget(verify_key(session_id), ["ok_upto", "last_try", "fail_since"])
    ok = raw[0].decode() if isinstance(raw[0], bytes) else raw[0]
    return VerifyState(int(ok) if ok else 0, _ts(raw[1]), _ts(raw[2]))


async def verify_claim(redis: Redis, session_id: uuid.UUID, now: dt.datetime, ttl_s: int) -> bool:
    """Claim this call's next presence check (one process at a time); records the attempt."""
    if not await redis.set(f"callverclaim:{session_id}", "1", nx=True, ex=ttl_s):
        return False
    await redis.hset(verify_key(session_id), "last_try", f"{now.timestamp():.3f}")
    await redis.expire(verify_key(session_id), HB_TTL_S)
    return True


_VERIFY_OK = """
local cur = tonumber(redis.call('HGET', KEYS[1], 'ok_upto') or '0')
if tonumber(ARGV[1]) > cur then redis.call('HSET', KEYS[1], 'ok_upto', ARGV[1]) end
redis.call('HDEL', KEYS[1], 'fail_since')
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('DEL', KEYS[2])
"""


async def verify_ok(redis: Redis, session_id: uuid.UUID, ok_upto: int) -> None:
    await redis.eval(
        _VERIFY_OK, 2, verify_key(session_id), f"callverclaim:{session_id}", str(ok_upto), HB_TTL_S
    )


async def verify_failed(redis: Redis, session_id: uuid.UUID, now: dt.datetime) -> None:
    """The first failure of a streak wins (`fail_since` is when presence stopped being known)."""
    await redis.hsetnx(verify_key(session_id), "fail_since", f"{now.timestamp():.3f}")
    await redis.expire(verify_key(session_id), HB_TTL_S)
    await redis.delete(f"callverclaim:{session_id}")
