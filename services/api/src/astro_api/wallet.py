"""Wallet and ledger operations (ADR-0002).

Every function runs inside the caller's AsyncSession and does NOT commit: the caller commits, so
a charge and the session row update land in one database transaction. Every write is idempotent
on a deterministic key; repeating a call returns the original result with `created=False`.

Concurrency: every operation that touches a user's money first locks that user's two balance
rows with SELECT ... FOR UPDATE, real then promo, then the user's promo lots, then upserts other
projections in a fixed order. One user's operations therefore run one at a time; the
`CHECK (balance_paise >= 0)` on user accounts backs this up in the database.
"""

import datetime as dt
import hashlib
import json
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import case, false, func, insert, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config
from astro_api.models_ledger import (
    AccountBalance,
    FreeSessionOverride,
    LedgerEntry,
    LedgerTransaction,
    PromoLot,
)

# ------------------------------------------------------------------ accounts (ADR-0002 §2)

COMMISSION = "platform:commission"
PROMO_EXPENSE = "platform:promo_expense"
PROMO_EXPIRED = "platform:promo_expired"
REFUNDS = "platform:refunds"
GATEWAY_FEES = "platform:gateway_fees"
CLEARING = "gateway:razorpay:clearing"
BANK = "bank:settlement"
BANK_PAYOUTS = "bank:payouts"  # asset: the account astrologer payouts are sent from
DEBIT_NORMAL = frozenset({PROMO_EXPENSE, REFUNDS, GATEWAY_FEES, CLEARING, BANK, BANK_PAYOUTS})

FREE_SESSION_LOT_TTL = dt.timedelta(days=1)  # safety net; the lot is closed when the session ends

Direction = Literal["debit", "credit"]


def real_account(user_id: uuid.UUID) -> str:
    return f"user:{user_id}:real"


def promo_account(user_id: uuid.UUID) -> str:
    return f"user:{user_id}:promo"


def payable_account(astrologer_id: uuid.UUID) -> str:
    return f"astrologer:{astrologer_id}:payable"


def normal_side(account_id: str) -> Direction:
    return "debit" if account_id in DEBIT_NORMAL else "credit"


def is_projected(account_id: str) -> bool:
    """User and astrologer accounts keep a balance projection. Platform, gateway and bank
    accounts are summed from entries when needed: they would otherwise be one hot row that every
    charge in the system updates."""
    return account_id.startswith(("user:", "astrologer:"))


# ------------------------------------------------------------------ results and errors


class InsufficientFunds(Exception):
    """The user's spendable balance does not cover the charge. Nothing was written."""


class IdempotencyConflict(Exception):
    """The key was used before with a different payload. Nothing was written; alert."""


class PayoutExceedsPayable(Exception):
    """A payout is larger than the astrologer's payable balance. Nothing was written."""

    def __init__(self, payable_paise: int) -> None:
        super().__init__(f"payable: {payable_paise}")
        self.payable_paise = payable_paise


class RefundTooLarge(Exception):
    """A refund exceeds what is left to refund on the session. Nothing was written."""

    def __init__(self, refundable_paise: int) -> None:
        super().__init__(f"refundable: {refundable_paise}")
        self.refundable_paise = refundable_paise


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


@dataclass(frozen=True)
class Posted:
    transaction_id: uuid.UUID
    created: bool


@dataclass(frozen=True)
class Lot:
    lot_id: uuid.UUID
    transaction_id: uuid.UUID
    created: bool


@dataclass(frozen=True)
class RefundPosting:
    transaction_id: uuid.UUID
    amount_paise: int
    real_paise: int
    promo_paise: int
    commission_paise: int
    astrologer_paise: int
    lot_id: uuid.UUID | None
    created: bool


@dataclass(frozen=True)
class SessionTotals:
    charged_paise: int
    real_paise: int
    promo_paise: int
    commission_paise: int
    astrologer_paise: int
    refunded_paise: int
    refunded_real_paise: int
    refunded_promo_paise: int
    refunded_commission_paise: int
    refunded_astrologer_paise: int
    is_free: bool


@dataclass(frozen=True)
class _Posting:
    account_id: str
    direction: Direction
    amount_paise: int
    lot_id: uuid.UUID | None = None


# ------------------------------------------------------------------ pure maths


def split_commission(charge_paise: int, bps: int) -> tuple[int, int]:
    """(commission, astrologer): commission = floor(charge * bps / 10000), astrologer gets the
    remainder, so the two always sum to the charge (ADR-0002 §7)."""
    commission = charge_paise * bps // 10000
    return commission, charge_paise - commission


def proportional_part(done: int, amount: int, part_total: int, total: int, done_part: int) -> int:
    """Share of a refund of `amount` that belongs to one bucket of the original charge.

    Cumulative rounding: after this refund the bucket has given back
    floor((done + amount) * part_total / total) in all, so repeated partial refunds never take
    more from a bucket than it was charged and a full refund restores it exactly."""
    return (done + amount) * part_total // total - done_part


def _hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


# ------------------------------------------------------------------ low-level posting


async def _existing(db: AsyncSession, key: str, payload_hash: str) -> LedgerTransaction | None:
    tx = (
        await db.execute(select(LedgerTransaction).where(LedgerTransaction.idempotency_key == key))
    ).scalar_one_or_none()
    if tx is not None and tx.payload_hash != payload_hash:
        raise IdempotencyConflict(key)
    return tx


async def lock_user(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    """Create (if needed) and lock the user's balance rows, real then promo. Returns their
    projected balances (real, promo)."""
    real, promo = real_account(user_id), promo_account(user_id)
    await db.execute(
        pg_insert(AccountBalance)
        .values(
            [
                {"account_id": real, "normal_side": "credit", "balance_paise": 0, "version": 0},
                {"account_id": promo, "normal_side": "credit", "balance_paise": 0, "version": 0},
            ]
        )
        .on_conflict_do_nothing(index_elements=["account_id"])
    )
    rows = (
        await db.execute(
            select(AccountBalance.account_id, AccountBalance.balance_paise)
            .where(AccountBalance.account_id.in_((real, promo)))
            # 'user:{id}:real' sorts after 'user:{id}:promo': descending locks real first.
            .order_by(AccountBalance.account_id.desc())
            .with_for_update()
        )
    ).all()
    found = {account: balance for account, balance in rows}
    return found[real], found[promo]


async def _insert_txn(
    db: AsyncSession,
    *,
    key: str,
    payload_hash: str,
    kind: str,
    user_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    astrologer_id: uuid.UUID | None = None,
    external_ref: str | None = None,
    occurred_at: dt.datetime | None = None,
) -> uuid.UUID | None:
    """Insert the transaction row; None when the key already exists (a concurrent winner)."""
    values: dict[str, Any] = {
        "id": uuid.uuid4(),
        "idempotency_key": key,
        "payload_hash": payload_hash,
        "kind": kind,
        "user_id": user_id,
        "session_id": session_id,
        "astrologer_id": astrologer_id,
        "external_ref": external_ref,
    }
    if occurred_at is not None:
        values["occurred_at"] = occurred_at
    stmt = (
        pg_insert(LedgerTransaction)
        .values(**values)
        .on_conflict_do_nothing(index_elements=["idempotency_key"])
        .returning(LedgerTransaction.id)
    )
    tid: uuid.UUID | None = (await db.execute(stmt)).scalar_one_or_none()
    return tid


def _projection_order(account_id: str) -> tuple[int, str]:
    if account_id.startswith("user:"):
        return (0 if account_id.endswith(":real") else 1, account_id)
    return (2, account_id)


async def _write(db: AsyncSession, transaction_id: uuid.UUID, postings: list[_Posting]) -> None:
    postings = [p for p in postings if p.amount_paise != 0]
    if any(p.amount_paise < 0 for p in postings):
        raise ValueError("posting amounts must be positive")
    debits = sum(p.amount_paise for p in postings if p.direction == "debit")
    credits = sum(p.amount_paise for p in postings if p.direction == "credit")
    if not postings or debits != credits:
        raise ValueError(f"unbalanced postings: {debits} != {credits}")
    await db.execute(
        insert(LedgerEntry),
        [
            {
                "transaction_id": transaction_id,
                "account_id": p.account_id,
                "direction": p.direction,
                "amount_paise": p.amount_paise,
                "promo_lot_id": p.lot_id,
            }
            for p in postings
        ],
    )
    deltas: dict[str, int] = {}
    for p in postings:
        if is_projected(p.account_id):
            sign = 1 if p.direction == normal_side(p.account_id) else -1
            deltas[p.account_id] = deltas.get(p.account_id, 0) + sign * p.amount_paise
    for account_id in sorted(deltas, key=_projection_order):
        if not account_id.startswith("user:"):  # user rows already exist (lock_user)
            await db.execute(
                pg_insert(AccountBalance)
                .values(
                    account_id=account_id,
                    normal_side=normal_side(account_id),
                    balance_paise=0,
                    version=0,
                )
                .on_conflict_do_nothing(index_elements=["account_id"])
            )
        await db.execute(
            update(AccountBalance)
            .where(AccountBalance.account_id == account_id)
            .values(
                balance_paise=AccountBalance.balance_paise + deltas[account_id],
                version=AccountBalance.version + 1,
                updated_at=func.now(),
            )
        )


async def _sums(db: AsyncSession, transaction_id: uuid.UUID) -> dict[tuple[str, str], int]:
    rows = (
        await db.execute(
            select(
                LedgerEntry.account_id, LedgerEntry.direction, func.sum(LedgerEntry.amount_paise)
            )
            .where(LedgerEntry.transaction_id == transaction_id)
            .group_by(LedgerEntry.account_id, LedgerEntry.direction)
        )
    ).all()
    return {(a, d): int(s) for a, d, s in rows}


def _bucket(account_id: str) -> str:
    if account_id.startswith("user:"):
        return "real" if account_id.endswith(":real") else "promo"
    if account_id == COMMISSION:
        return "commission"
    if account_id.startswith("astrologer:"):
        return "astrologer"
    return "other"


def _by_bucket(sums: dict[tuple[str, str], int], direction: str) -> dict[str, int]:
    out = {"real": 0, "promo": 0, "commission": 0, "astrologer": 0, "other": 0}
    for (account, d), amount in sums.items():
        if d == direction:
            out[_bucket(account)] += amount
    return out


# ------------------------------------------------------------------ reads


def _usable_lots_query(user_id: uuid.UUID, session_id: uuid.UUID | None, now: dt.datetime) -> Any:
    restricted = PromoLot.session_id == session_id if session_id else false()
    return (
        select(PromoLot)
        .where(
            PromoLot.user_id == user_id,
            PromoLot.remaining_paise > 0,
            (PromoLot.expires_at.is_(None)) | (PromoLot.expires_at > now),
            (PromoLot.session_id.is_(None)) | restricted,
        )
        # The session's own lot first, then earliest expiry (ADR-0002 §6).
        .order_by(
            PromoLot.session_id.is_(None),
            PromoLot.expires_at.asc().nulls_last(),
            PromoLot.created_at,
            PromoLot.id,
        )
    )


async def usable_lots(
    db: AsyncSession, user_id: uuid.UUID, *, session_id: uuid.UUID | None = None
) -> list[PromoLot]:
    return list((await db.execute(_usable_lots_query(user_id, session_id, _now()))).scalars())


async def balances(
    db: AsyncSession, user_id: uuid.UUID, *, session_id: uuid.UUID | None = None
) -> Balances:
    """Spendable balances. Promo lots restricted to another session are excluded; expired lots
    are excluded."""
    real = (
        await db.execute(
            select(AccountBalance.balance_paise).where(
                AccountBalance.account_id == real_account(user_id)
            )
        )
    ).scalar_one_or_none()
    lots = _usable_lots_query(user_id, session_id, _now()).subquery()
    promo = (await db.execute(select(func.coalesce(func.sum(lots.c.remaining_paise), 0)))).scalar()
    return Balances(real_paise=int(real or 0), promo_paise=int(promo or 0))


async def minutes_affordable(
    db: AsyncSession, user_id: uuid.UUID, price_paise: int, *, session_id: uuid.UUID | None = None
) -> int:
    """Whole minutes the user can pay for at `price_paise` per minute."""
    if price_paise <= 0:
        raise ValueError("price_paise must be positive")
    b = await balances(db, user_id, session_id=session_id)
    return b.total_paise // price_paise


async def account_balance(db: AsyncSession, account_id: str) -> int:
    """Balance on the account's normal side, summed from ledger entries (the record)."""
    signed = case(
        (LedgerEntry.direction == normal_side(account_id), LedgerEntry.amount_paise),
        else_=-LedgerEntry.amount_paise,
    )
    total = (
        await db.execute(
            select(func.coalesce(func.sum(signed), 0)).where(LedgerEntry.account_id == account_id)
        )
    ).scalar()
    return int(total or 0)


# ------------------------------------------------------------------ charges


async def _charge_from(db: AsyncSession, tx: LedgerTransaction) -> Charge:
    sums = await _sums(db, tx.id)
    debit, credit = _by_bucket(sums, "debit"), _by_bucket(sums, "credit")
    return Charge(
        transaction_id=tx.id,
        promo_paise=debit["promo"],
        real_paise=debit["real"],
        commission_paise=credit["commission"],
        astrologer_paise=credit["astrologer"],
        created=False,
    )


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
    if minute < 1:
        raise ValueError("minute is 1-based")
    if price_paise <= 0:
        raise ValueError("price_paise must be positive")
    if not 0 <= commission_bps <= 10000:
        raise ValueError("commission_bps must be within 0..10000")
    key = f"session:{session_id}:minute:{minute}"
    payload_hash = _hash(
        {
            "session_id": session_id,
            "user_id": user_id,
            "astrologer_id": astrologer_id,
            "minute": minute,
            "price_paise": price_paise,
            "commission_bps": commission_bps,
        }
    )
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return await _charge_from(db, tx)
    real_balance, _ = await lock_user(db, user_id)
    # A concurrent call with the same key may have committed while we waited for the lock.
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return await _charge_from(db, tx)

    lots = list(
        (
            await db.execute(_usable_lots_query(user_id, session_id, _now()).with_for_update())
        ).scalars()
    )
    restricted = [lot for lot in lots if lot.session_id is not None]
    general = [lot for lot in lots if lot.session_id is None]
    if sum(lot.remaining_paise for lot in lots) + real_balance < price_paise:
        raise InsufficientFunds(f"session {session_id} minute {minute}")

    remaining = price_paise
    from_lots: list[tuple[PromoLot, int]] = []
    real_part = 0

    def take_lots(candidates: list[PromoLot]) -> None:
        nonlocal remaining
        for lot in candidates:
            if remaining == 0:
                return
            part = min(lot.remaining_paise, remaining)
            if part > 0:
                from_lots.append((lot, part))
                remaining -= part

    take_lots(restricted)
    for bucket in billing_config.spend_order():
        if bucket == "promo":
            take_lots(general)
        else:
            real_part = min(real_balance, remaining)
            remaining -= real_part
    if remaining:  # cannot happen after the total check; never post a partial charge
        raise InsufficientFunds(f"session {session_id} minute {minute}")

    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="consultation",
        user_id=user_id,
        session_id=session_id,
        astrologer_id=astrologer_id,
    )
    if tid is None:  # pragma: no cover - we hold the user's lock, so nobody else can post it
        tx = await _existing(db, key, payload_hash)
        assert tx is not None
        return await _charge_from(db, tx)
    commission, astrologer = split_commission(price_paise, commission_bps)
    postings = [_Posting(real_account(user_id), "debit", real_part)]
    postings += [_Posting(promo_account(user_id), "debit", part, lot.id) for lot, part in from_lots]
    postings += [
        _Posting(payable_account(astrologer_id), "credit", astrologer),
        _Posting(COMMISSION, "credit", commission),
    ]
    await _write(db, tid, postings)
    for lot, part in from_lots:
        lot.remaining_paise -= part
    await db.flush()
    promo_part = sum(part for _, part in from_lots)
    return Charge(
        transaction_id=tid,
        promo_paise=promo_part,
        real_paise=real_part,
        commission_paise=commission,
        astrologer_paise=astrologer,
        created=True,
    )


# ------------------------------------------------------------------ credits and promo


async def credit_recharge(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    payment_id: str,
    amount_paise: int,
    occurred_at: dt.datetime | None = None,
) -> Posted:
    """Captured gateway payment → user's real balance. Key `razorpay:payment:{id}:captured`.
    Debit gateway clearing, credit user real."""
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    key = f"razorpay:payment:{payment_id}:captured"
    payload_hash = _hash({"user_id": user_id, "payment_id": payment_id, "amount": amount_paise})
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return Posted(tx.id, False)
    await lock_user(db, user_id)
    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="recharge",
        user_id=user_id,
        external_ref=payment_id,
        occurred_at=occurred_at,
    )
    if tid is None:
        tx = await _existing(db, key, payload_hash)
        assert tx is not None
        return Posted(tx.id, False)
    await _write(
        db,
        tid,
        [
            _Posting(CLEARING, "debit", amount_paise),
            _Posting(real_account(user_id), "credit", amount_paise),
        ],
    )
    return Posted(tid, True)


async def _lot_for(db: AsyncSession, tx: LedgerTransaction) -> Lot:
    lot_id = (
        await db.execute(select(PromoLot.id).where(PromoLot.source_transaction_id == tx.id))
    ).scalar_one()
    return Lot(lot_id, tx.id, False)


async def grant_promo(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    amount_paise: int,
    campaign: str,
    key: str,
    expires_at: dt.datetime | None,
    session_id: uuid.UUID | None = None,
    kind: str = "promo_grant",
) -> Lot:
    """Grant promotional credit as a new lot. Debit platform:promo_expense, credit user:promo.
    `expires_at` is not part of the idempotency payload (a retry computes it again)."""
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    payload_hash = _hash(
        {
            "user_id": user_id,
            "amount": amount_paise,
            "campaign": campaign,
            "session_id": session_id,
            "kind": kind,
        }
    )
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return await _lot_for(db, tx)
    await lock_user(db, user_id)
    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind=kind,
        user_id=user_id,
        session_id=session_id,
    )
    if tid is None:
        tx = await _existing(db, key, payload_hash)
        assert tx is not None
        return await _lot_for(db, tx)
    lot = PromoLot(
        id=uuid.uuid4(),
        user_id=user_id,
        campaign=campaign,
        amount_paise=amount_paise,
        remaining_paise=amount_paise,
        expires_at=expires_at,
        session_id=session_id,
        source_transaction_id=tid,
    )
    db.add(lot)
    await db.flush()
    await _write(
        db,
        tid,
        [
            _Posting(PROMO_EXPENSE, "debit", amount_paise),
            _Posting(promo_account(user_id), "credit", amount_paise, lot.id),
        ],
    )
    return Lot(lot.id, tid, True)


async def free_session_key(db: AsyncSession, user_id: uuid.UUID) -> str:
    """`promo:free_session:{user_id}`; after an admin reset, suffixed with the reset count."""
    resets = (
        await db.execute(
            select(FreeSessionOverride.resets).where(FreeSessionOverride.user_id == user_id)
        )
    ).scalar_one_or_none()
    base = f"promo:free_session:{user_id}"
    return f"{base}:reset{resets}" if resets else base


async def grant_free_session(
    db: AsyncSession, *, user_id: uuid.UUID, session_id: uuid.UUID, amount_paise: int
) -> uuid.UUID:
    """Fund a first free session as a promo lot usable only by `session_id`.
    Key `promo:free_session:{user_id}` (once per user, ever). Returns the lot id."""
    lot = await grant_promo(
        db,
        user_id=user_id,
        amount_paise=amount_paise,
        campaign="free_session",
        key=await free_session_key(db, user_id),
        expires_at=_now() + FREE_SESSION_LOT_TTL,
        session_id=session_id,
        kind="free_session_grant",
    )
    return lot.lot_id


async def _expire_locked_lot(db: AsyncSession, lot: PromoLot) -> int:
    """Post the expiry of what is left of a lot. The user's rows and the lot must be locked."""
    if lot.remaining_paise <= 0:
        return 0
    key = f"promo_lot:{lot.id}:expire"
    payload_hash = _hash({"lot_id": lot.id})
    if await _existing(db, key, payload_hash) is not None:  # pragma: no cover - remaining is 0
        return 0
    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="promo_expiry",
        user_id=lot.user_id,
        session_id=lot.session_id,
    )
    if tid is None:  # pragma: no cover - guarded by the lot lock
        return 0
    amount = lot.remaining_paise
    await _write(
        db,
        tid,
        [
            _Posting(promo_account(lot.user_id), "debit", amount, lot.id),
            _Posting(PROMO_EXPIRED, "credit", amount),
        ],
    )
    lot.remaining_paise = 0
    lot.closed_at = _now()
    await db.flush()
    return amount


async def _expire_lots(
    db: AsyncSession, lot_ids: list[uuid.UUID], *, due: dt.datetime | None
) -> int:
    users = (
        await db.execute(select(PromoLot.user_id).where(PromoLot.id.in_(lot_ids)).distinct())
    ).scalars()
    total = 0
    for user_id in sorted(users):
        await lock_user(db, user_id)
        conds = [
            PromoLot.id.in_(lot_ids),
            PromoLot.user_id == user_id,
            PromoLot.remaining_paise > 0,
        ]
        if due is not None:
            conds.append(PromoLot.expires_at <= due)
        lots = (
            await db.execute(select(PromoLot).where(*conds).order_by(PromoLot.id).with_for_update())
        ).scalars()
        for lot in list(lots):
            total += await _expire_locked_lot(db, lot)
    return total


async def close_session_lots(db: AsyncSession, *, session_id: uuid.UUID) -> int:
    """Expire whatever is left of lots restricted to an ended session
    (key `promo_lot:{lot_id}:expire`). Returns paise expired."""
    ids = list(
        (
            await db.execute(
                select(PromoLot.id).where(
                    PromoLot.session_id == session_id, PromoLot.remaining_paise > 0
                )
            )
        ).scalars()
    )
    return await _expire_lots(db, ids, due=None) if ids else 0


async def expire_due_lots(db: AsyncSession, *, now: dt.datetime, limit: int = 1000) -> int:
    """Expire lots whose `expires_at` has passed (scheduled job). Returns paise expired."""
    ids = list(
        (
            await db.execute(
                select(PromoLot.id)
                .where(PromoLot.remaining_paise > 0, PromoLot.expires_at <= now)
                .limit(limit)
            )
        ).scalars()
    )
    return await _expire_lots(db, ids, due=now) if ids else 0


# ------------------------------------------------------------------ settlement


async def post_settlement(
    db: AsyncSession,
    *,
    settlement_id: str,
    amount_paise: int,
    fees_paise: int,
    occurred_at: dt.datetime | None = None,
) -> Posted:
    """Gateway settlement: debit bank (net) and gateway fees, credit clearing (gross).
    Key `razorpay:settlement:{id}`."""
    if amount_paise < 0 or fees_paise < 0 or amount_paise + fees_paise == 0:
        raise ValueError("settlement amounts must be non-negative and not both zero")
    key = f"razorpay:settlement:{settlement_id}"
    payload_hash = _hash(
        {"settlement_id": settlement_id, "amount": amount_paise, "fees": fees_paise}
    )
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return Posted(tx.id, False)
    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="settlement",
        external_ref=settlement_id,
        occurred_at=occurred_at,
    )
    if tid is None:
        tx = await _existing(db, key, payload_hash)
        assert tx is not None
        return Posted(tx.id, False)
    await _write(
        db,
        tid,
        [
            _Posting(BANK, "debit", amount_paise),
            _Posting(GATEWAY_FEES, "debit", fees_paise),
            _Posting(CLEARING, "credit", amount_paise + fees_paise),
        ],
    )
    return Posted(tid, True)


# ------------------------------------------------------------------ refunds


async def session_totals(db: AsyncSession, session_id: uuid.UUID) -> SessionTotals:
    """What a session charged, by bucket, and what has been refunded so far."""
    rows = (
        await db.execute(
            select(
                LedgerTransaction.kind,
                LedgerEntry.account_id,
                LedgerEntry.direction,
                func.sum(LedgerEntry.amount_paise),
            )
            .join(LedgerEntry, LedgerEntry.transaction_id == LedgerTransaction.id)
            .where(
                LedgerTransaction.session_id == session_id,
                LedgerTransaction.kind.in_(("consultation", "refund")),
            )
            .group_by(LedgerTransaction.kind, LedgerEntry.account_id, LedgerEntry.direction)
        )
    ).all()
    charged = {"real": 0, "promo": 0, "commission": 0, "astrologer": 0, "other": 0}
    refunded = dict(charged)
    for kind, account, direction, amount in rows:
        bucket = _bucket(account)
        if kind == "consultation":
            if (bucket in ("real", "promo")) == (direction == "debit"):
                charged[bucket] += int(amount)
        elif (bucket in ("real", "promo")) == (direction == "credit"):
            refunded[bucket] += int(amount)
    is_free = (
        await db.execute(
            select(func.count())
            .select_from(LedgerTransaction)
            .where(
                LedgerTransaction.session_id == session_id,
                LedgerTransaction.kind == "free_session_grant",
            )
        )
    ).scalar_one() > 0
    return SessionTotals(
        charged_paise=charged["real"] + charged["promo"],
        real_paise=charged["real"],
        promo_paise=charged["promo"],
        commission_paise=charged["commission"],
        astrologer_paise=charged["astrologer"],
        refunded_paise=refunded["real"] + refunded["promo"],
        refunded_real_paise=refunded["real"],
        refunded_promo_paise=refunded["promo"],
        refunded_commission_paise=refunded["commission"],
        refunded_astrologer_paise=refunded["astrologer"],
        is_free=is_free,
    )


async def find_refund(db: AsyncSession, key: str) -> RefundPosting | None:
    tx = (
        await db.execute(select(LedgerTransaction).where(LedgerTransaction.idempotency_key == key))
    ).scalar_one_or_none()
    return await _refund_from(db, tx) if tx is not None else None


async def _refund_from(db: AsyncSession, tx: LedgerTransaction) -> RefundPosting:
    sums = await _sums(db, tx.id)
    credit, debit = _by_bucket(sums, "credit"), _by_bucket(sums, "debit")
    lot_id = (
        await db.execute(select(PromoLot.id).where(PromoLot.source_transaction_id == tx.id))
    ).scalar_one_or_none()
    return RefundPosting(
        transaction_id=tx.id,
        amount_paise=credit["real"] + credit["promo"],
        real_paise=credit["real"],
        promo_paise=credit["promo"],
        commission_paise=debit["commission"],
        astrologer_paise=debit["astrologer"],
        lot_id=lot_id,
        created=False,
    )


async def post_refund(
    db: AsyncSession,
    *,
    key: str,
    rule: str,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    amount_paise: int,
) -> RefundPosting:
    """Refund part of a session's charges, reversing its buckets in proportion (ADR-0002,
    implementation notes): the user gets real back as real and promo back as a new general
    promo lot (promo_expiry_days); the astrologer's payable and the platform commission are
    debited in the proportion the session credited them. Never more than is left to refund."""
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    payload_hash = _hash({"rule": rule, "session_id": session_id, "amount": amount_paise})
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return await _refund_from(db, tx)
    await lock_user(db, user_id)
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return await _refund_from(db, tx)
    t = await session_totals(db, session_id)
    refundable = t.charged_paise - t.refunded_paise
    if amount_paise > refundable:
        raise RefundTooLarge(refundable)
    done = t.refunded_paise
    promo = proportional_part(
        done, amount_paise, t.promo_paise, t.charged_paise, t.refunded_promo_paise
    )
    commission = proportional_part(
        done, amount_paise, t.commission_paise, t.charged_paise, t.refunded_commission_paise
    )
    real, astrologer = amount_paise - promo, amount_paise - commission
    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="refund",
        user_id=user_id,
        session_id=session_id,
        astrologer_id=astrologer_id,
    )
    assert tid is not None  # we hold the user's lock and checked the key under it
    lot_id: uuid.UUID | None = None
    if promo > 0:
        lot = PromoLot(
            id=uuid.uuid4(),
            user_id=user_id,
            campaign="refund",
            amount_paise=promo,
            remaining_paise=promo,
            expires_at=_now() + dt.timedelta(days=billing_config.promo_expiry_days()),
            session_id=None,
            source_transaction_id=tid,
        )
        db.add(lot)
        await db.flush()
        lot_id = lot.id
    await _write(
        db,
        tid,
        [
            _Posting(real_account(user_id), "credit", real),
            _Posting(promo_account(user_id), "credit", promo, lot_id),
            _Posting(payable_account(astrologer_id), "debit", astrologer),
            _Posting(COMMISSION, "debit", commission),
        ],
    )
    return RefundPosting(
        transaction_id=tid,
        amount_paise=amount_paise,
        real_paise=real,
        promo_paise=promo,
        commission_paise=commission,
        astrologer_paise=astrologer,
        lot_id=lot_id,
        created=True,
    )


# ------------------------------------------------------------------ astrologer payouts


async def lock_payable(db: AsyncSession, astrologer_id: uuid.UUID) -> int:
    """Create (if needed) and lock the astrologer's payable projection row; returns its balance."""
    account = payable_account(astrologer_id)
    await db.execute(
        pg_insert(AccountBalance)
        .values(account_id=account, normal_side="credit", balance_paise=0, version=0)
        .on_conflict_do_nothing(index_elements=["account_id"])
    )
    balance = (
        await db.execute(
            select(AccountBalance.balance_paise)
            .where(AccountBalance.account_id == account)
            .with_for_update()
        )
    ).scalar_one()
    return int(balance)


async def post_payout(
    db: AsyncSession, *, payout_id: uuid.UUID, astrologer_id: uuid.UUID, amount_paise: int
) -> Posted:
    """A bank transfer to an astrologer (portal.md §3). Key `payout:{payout_id}`: debit
    `astrologer:{id}:payable`, credit `bank:payouts`. Locks the payable row and refuses more than
    its balance (PayoutExceedsPayable); a repeat returns the original posting."""
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    key = f"payout:{payout_id}"
    payload_hash = _hash(
        {"payout_id": payout_id, "astrologer_id": astrologer_id, "amount": amount_paise}
    )
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return Posted(tx.id, False)
    payable = await lock_payable(db, astrologer_id)
    # A concurrent call with the same key may have committed while we waited for the lock.
    if (tx := await _existing(db, key, payload_hash)) is not None:
        return Posted(tx.id, False)
    if amount_paise > payable:
        raise PayoutExceedsPayable(payable)
    tid = await _insert_txn(
        db,
        key=key,
        payload_hash=payload_hash,
        kind="payout",
        astrologer_id=astrologer_id,
        external_ref=str(payout_id),
    )
    assert tid is not None  # we hold the payable lock and checked the key under it
    await _write(
        db,
        tid,
        [
            _Posting(payable_account(astrologer_id), "debit", amount_paise),
            _Posting(BANK_PAYOUTS, "credit", amount_paise),
        ],
    )
    return Posted(tid, True)


# ------------------------------------------------------------------ history (wallet page)

API_KINDS = {
    "recharge": "recharge",
    "recharge_bonus": "recharge_bonus",
    "consultation": "consultation",
    "refund": "refund",
    "free_session_grant": "free_session_grant",
    "promo_expiry": "promo_expiry",
    "promo_grant": "adjustment",
    "adjustment": "adjustment",
}


async def history(
    db: AsyncSession, user_id: uuid.UUID, *, before: int | None, limit: int
) -> tuple[list[dict[str, Any]], int | None]:
    """The user's transactions, newest first, with each session's per-minute charges grouped
    into one `consultation` row. Amounts are signed from the user's view (credit positive).
    Returns (items, next cursor)."""
    where_before = "WHERE g.seq < :before" if before is not None else ""
    rows = (
        await db.execute(
            text(
                f"""
                WITH per_txn AS (
                  SELECT t.id, t.seq, t.kind, t.session_id, t.astrologer_id, t.created_at,
                    sum(CASE WHEN e.account_id = :real THEN
                      CASE WHEN e.direction = 'credit' THEN e.amount_paise
                      ELSE -e.amount_paise END ELSE 0 END) AS real_paise,
                    sum(CASE WHEN e.account_id = :promo THEN
                      CASE WHEN e.direction = 'credit' THEN e.amount_paise
                      ELSE -e.amount_paise END ELSE 0 END) AS promo_paise
                  FROM ledger_transactions t
                  JOIN ledger_entries e ON e.transaction_id = t.id
                    AND e.account_id IN (:real, :promo)
                  WHERE t.user_id = :uid
                  GROUP BY t.id
                ), grouped AS (
                  SELECT min(kind) AS kind, min(seq) AS seq, min(created_at) AS created_at,
                    sum(real_paise) AS real_paise, sum(promo_paise) AS promo_paise,
                    (array_agg(id ORDER BY seq))[1] AS id,
                    (array_agg(session_id ORDER BY seq))[1] AS session_id,
                    (array_agg(astrologer_id ORDER BY seq))[1] AS astrologer_id
                  FROM per_txn
                  GROUP BY CASE WHEN kind = 'consultation' THEN 'c:' || session_id::text
                    ELSE 't:' || id::text END
                )
                SELECT g.id, g.kind, g.seq, g.created_at, g.real_paise, g.promo_paise,
                  g.session_id, a.slug, a.display_name
                FROM grouped g LEFT JOIN astrologers a ON a.id = g.astrologer_id
                {where_before}
                ORDER BY g.seq DESC
                LIMIT :n
                """  # noqa: S608 - only a fixed fragment is interpolated
            ),
            {
                "uid": user_id,
                "real": real_account(user_id),
                "promo": promo_account(user_id),
                "n": limit + 1,
                **({"before": before} if before is not None else {}),
            },
        )
    ).all()
    items = [
        {
            "id": str(r.id),
            "kind": API_KINDS.get(r.kind, "adjustment"),
            "amount_paise": int(r.real_paise) + int(r.promo_paise),
            "real_paise": int(r.real_paise),
            "promo_paise": int(r.promo_paise),
            "created_at": r.created_at,
            "session_id": str(r.session_id) if r.session_id else None,
            "astrologer": {"slug": r.slug, "display_name": r.display_name} if r.slug else None,
        }
        for r in rows[:limit]
    ]
    next_cursor = int(rows[limit - 1].seq) if len(rows) > limit else None
    return items, next_cursor
