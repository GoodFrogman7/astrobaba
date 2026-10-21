"""Refund rules engine (rules in data/marketplace/billing.json). Owned by the wallet work.

The session work calls `on_session_end` after a session ends (in its own transaction, after the
session row is committed); review creation calls `on_review`. Both are idempotent (key
`refund:{rule}:{session_id}`) and audited.
"""

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class SessionFacts:
    session_id: uuid.UUID
    user_id: uuid.UUID
    astrologer_id: uuid.UUID
    status: str  # completed | cancelled | failed
    end_reason: str | None
    accepted_at: dt.datetime | None
    started_at: dt.datetime | None
    ended_at: dt.datetime | None
    billed_minutes: int
    price_per_min_paise: int
    commission_bps: int
    is_free: bool
    # Last time the astrologer's client was seen (heartbeat or message) while active.
    astrologer_last_seen_at: dt.datetime | None


@dataclass(frozen=True)
class RefundResult:
    rule: str
    session_id: uuid.UUID
    amount_paise: int
    created: bool


async def on_session_end(db: AsyncSession, facts: SessionFacts) -> list[RefundResult]:
    """Apply failed_connect / astrologer_drop rules. Caller commits."""
    raise NotImplementedError


async def on_review(
    db: AsyncSession, *, session_id: uuid.UUID, rating: int, at: dt.datetime
) -> RefundResult | None:
    """Apply the low_rating rule. Caller commits."""
    raise NotImplementedError
