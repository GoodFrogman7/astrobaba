"""Refund rules engine (rules in data/marketplace/billing.json). Owned by the wallet work.

The session work calls `on_session_end` after a session ends (in its own transaction, after the
session row is committed); review creation calls `on_review`. Both are idempotent (key
`refund:{rule}:{session_id}`) and audited.

Postings (wallet.post_refund): a refund reverses the session's charges in proportion. Real comes
back as real, promo as a new general promo lot, and the astrologer's payable and the platform
commission give back their shares. Free sessions are never refunded: the user paid nothing.
Audit detail holds ids and amounts only.
"""

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config, wallet
from astro_api.audit import audit
from astro_api.config import get_settings
from astro_api.models import ConsultSession
from astro_api.models_ledger import Refund

SYSTEM_ACTOR = "system:refunds"
RULES = ("failed_connect", "astrologer_drop", "low_rating", "manual")


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


class RefundNotAllowed(Exception):
    def __init__(self, code: str, message: str, refundable_paise: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.refundable_paise = refundable_paise


def _key(rule: str, session_id: uuid.UUID) -> str:
    return f"refund:{rule}:{session_id}"


async def _apply(
    db: AsyncSession,
    *,
    rule: str,
    key: str,
    session_id: uuid.UUID,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    amount_paise: int,
    actor: str,
    note: str | None = None,
) -> tuple[RefundResult, Refund]:
    posting = await wallet.post_refund(
        db,
        key=key,
        rule=rule,
        session_id=session_id,
        user_id=user_id,
        astrologer_id=astrologer_id,
        amount_paise=amount_paise,
    )
    if posting.created:
        row = Refund(
            id=uuid.uuid4(),
            transaction_id=posting.transaction_id,
            rule=rule,
            session_id=session_id,
            user_id=user_id,
            astrologer_id=astrologer_id,
            amount_paise=posting.amount_paise,
            real_paise=posting.real_paise,
            promo_paise=posting.promo_paise,
            commission_paise=posting.commission_paise,
            astrologer_paise=posting.astrologer_paise,
            actor=actor,
            note=note,
            created_at=dt.datetime.now(dt.UTC),
        )
        db.add(row)
        await db.flush()
        audit(
            db,
            actor,
            "refund.create",
            "session",
            str(session_id),
            rule=rule,
            amount_paise=posting.amount_paise,
            real_paise=posting.real_paise,
            promo_paise=posting.promo_paise,
            transaction_id=str(posting.transaction_id),
            refund_id=str(row.id),
            user_id=str(user_id),
        )
    else:
        row = (
            await db.execute(select(Refund).where(Refund.transaction_id == posting.transaction_id))
        ).scalar_one()
    return RefundResult(rule, session_id, posting.amount_paise, posting.created), row


async def _existing(rule: str, db: AsyncSession, session_id: uuid.UUID) -> RefundResult | None:
    found = await wallet.find_refund(db, _key(rule, session_id))
    if found is None:
        return None
    return RefundResult(rule, session_id, found.amount_paise, False)


async def on_session_end(
    db: AsyncSession, facts: SessionFacts, *, minute_seconds: float | None = None
) -> list[RefundResult]:
    """Apply failed_connect / astrologer_drop rules. Caller commits.

    `minute_seconds` is the billed-minute length (Settings.billing_minute_seconds); it defaults
    to the environment's settings."""
    if facts.is_free:
        return []
    if facts.status == "failed" or facts.started_at is None:
        rule = "failed_connect"
        if not billing_config.refund_rule(rule).get("enabled", False):
            return []
        if (hit := await _existing(rule, db, facts.session_id)) is not None:
            return [hit]
        totals = await wallet.session_totals(db, facts.session_id)
        amount = totals.charged_paise - totals.refunded_paise
    elif facts.end_reason == "astrologer_dropped":
        rule = "astrologer_drop"
        if not billing_config.refund_rule(rule).get("enabled", False):
            return []
        if (hit := await _existing(rule, db, facts.session_id)) is not None:
            return [hit]
        minute = minute_seconds or get_settings().billing_minute_seconds
        served = 0
        if facts.astrologer_last_seen_at is not None:
            elapsed = (facts.astrologer_last_seen_at - facts.started_at).total_seconds()
            # The minute in progress when the astrologer was last seen counts as served.
            served = max(0, int(elapsed // minute) + 1) if elapsed >= 0 else 0
        minutes = max(0, facts.billed_minutes - served)
        totals = await wallet.session_totals(db, facts.session_id)
        amount = min(
            minutes * facts.price_per_min_paise, totals.charged_paise - totals.refunded_paise
        )
    else:
        return []
    if amount <= 0:
        return []
    result, _ = await _apply(
        db,
        rule=rule,
        key=_key(rule, facts.session_id),
        session_id=facts.session_id,
        user_id=facts.user_id,
        astrologer_id=facts.astrologer_id,
        amount_paise=amount,
        actor=SYSTEM_ACTOR,
    )
    return [result]


async def on_review(
    db: AsyncSession, *, session_id: uuid.UUID, rating: int, at: dt.datetime
) -> RefundResult | None:
    """Apply the low_rating rule. Caller commits."""
    rule = "low_rating"
    cfg = billing_config.refund_rule(rule)
    if not cfg.get("enabled", False) or rating > int(cfg["max_rating"]):
        return None
    if (hit := await _existing(rule, db, session_id)) is not None:
        return hit
    session = await db.get(ConsultSession, session_id)
    if session is None or session.ended_at is None:
        return None
    if at - session.ended_at > dt.timedelta(hours=float(cfg["window_hours"])):
        return None
    totals = await wallet.session_totals(db, session_id)
    if totals.is_free or totals.charged_paise == 0:
        return None
    # Count recent low-rating refunds under the user's wallet lock, so two reviews at once
    # cannot both pass the monthly limit.
    await wallet.lock_user(db, session.user_id)
    recent = (
        await db.execute(
            select(func.count())
            .select_from(Refund)
            .where(
                Refund.user_id == session.user_id,
                Refund.rule == rule,
                Refund.created_at > func.now() - text("interval '30 days'"),
            )
        )
    ).scalar_one()
    if recent >= int(cfg["max_per_user_per_30_days"]):
        return None
    amount = min(
        int(cfg["cap_paise"]),
        totals.charged_paise * int(cfg["refund_bps"]) // 10000,
        totals.charged_paise - totals.refunded_paise,
    )
    if amount <= 0:
        return None
    result, _ = await _apply(
        db,
        rule=rule,
        key=_key(rule, session_id),
        session_id=session_id,
        user_id=session.user_id,
        astrologer_id=session.astrologer_id,
        amount_paise=amount,
        actor=SYSTEM_ACTOR,
    )
    return result


async def manual_refund(
    db: AsyncSession,
    *,
    session_id: uuid.UUID,
    amount_paise: int,
    key: str,
    actor: str,
    note: str | None,
) -> Refund:
    """Admin goodwill refund of part of a session's charges (key
    `refund:manual:{session_id}:{key}`). Never more than is left to refund. Caller commits."""
    session = await db.get(ConsultSession, session_id)
    if session is None:
        raise RefundNotAllowed("not_found", "Session not found.")
    try:
        _, row = await _apply(
            db,
            rule="manual",
            key=f"refund:manual:{session_id}:{key}",
            session_id=session_id,
            user_id=session.user_id,
            astrologer_id=session.astrologer_id,
            amount_paise=amount_paise,
            actor=actor,
            note=note,
        )
    except wallet.RefundTooLarge as exc:
        raise RefundNotAllowed(
            "refund_exceeds_charges",
            "The refund is more than what is left to refund on this session.",
            exc.refundable_paise,
        ) from exc
    return row
