"""Wallet and ledger operations (ADR-0002). Owned by the wallet work; the session meter calls it.

Every function runs inside the caller's AsyncSession and does NOT commit: the caller commits, so
a charge and the session row update land in one database transaction. Every write is idempotent
on a deterministic key; repeating a call returns the original result with `created=False`.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession


class InsufficientFunds(Exception):
    """The user's spendable balance does not cover the charge. Nothing was written."""


class IdempotencyConflict(Exception):
    """The key was used before with a different payload. Nothing was written; alert."""


@dataclass(frozen=True)
class Balances:
    real_paise: int
    promo_paise: int  # general promo plus any lot restricted to the given session

    @property
    def total_paise(self) -> int:
        return self.real_paise + self.promo_paise


@dataclass(frozen=True)
class Charge:
    transaction_id: uuid.UUID
    promo_paise: int
    real_paise: int
    commission_paise: int
    astrologer_paise: int
    created: bool


async def balances(
    db: AsyncSession, user_id: uuid.UUID, *, session_id: uuid.UUID | None = None
) -> Balances:
    """Spendable balances. Promo lots restricted to another session are excluded; expired lots
    are excluded."""
    raise NotImplementedError


async def minutes_affordable(
    db: AsyncSession, user_id: uuid.UUID, price_paise: int, *, session_id: uuid.UUID | None = None
) -> int:
    """Whole minutes the user can pay for at `price_paise` per minute."""
    raise NotImplementedError


async def charge_minute(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    minute: int,
    price_paise: int,
    commission_bps: int,
) -> Charge:
    """Prepay minute `minute` (1-based) of a session. Key `session:{session_id}:minute:{minute}`.
    Spends the session's own promo lot, then general promo by earliest expiry, then real.
    Locks the user's balance rows; raises InsufficientFunds rather than going negative."""
    raise NotImplementedError


async def grant_free_session(
    db: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID, amount_paise: int
) -> uuid.UUID:
    """Fund a first free session as a promo lot usable only by `session_id`.
    Key `promo:free_session:{user_id}` (once per user, ever). Returns the lot id."""
    raise NotImplementedError


async def close_session_lots(db: AsyncSession, *, session_id: uuid.UUID) -> int:
    """Expire whatever is left of lots restricted to an ended session
    (key `promo_lot:{lot_id}:expire`). Returns paise expired."""
    raise NotImplementedError
