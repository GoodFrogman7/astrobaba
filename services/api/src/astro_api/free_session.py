"""First free session eligibility and abuse heuristics. Owned by the wallet work; the session
work calls `check` before creating a free session and `claim` in the same transaction."""

import uuid
from dataclasses import dataclass

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    minutes: int
    reason: str | None  # flag_off | already_used | device_used | ip_limit | blocked | abuse_score


async def check(
    db: AsyncSession, redis: Redis, *, user_id: uuid.UUID, device_id: str, client_ip: str
) -> Eligibility:
    raise NotImplementedError


async def claim(
    db: AsyncSession,
    redis: Redis,
    *,
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    device_id: str,
    client_ip: str,
) -> None:
    """Record the claim (unique per user) so later checks see it. Caller commits."""
    raise NotImplementedError
