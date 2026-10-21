"""Ledger and wallet tables (migration 0004, ADR-0002). Owned by the wallet work.

`ledger_transactions` and `ledger_entries` are the record: append-only (a trigger rejects UPDATE
and DELETE) and balanced per transaction (a deferred constraint trigger checks at commit).
`account_balances` and `promo_lots` are projections updated in the same database transaction.
Integer paise everywhere. No personal data: ids and amounts only.
"""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

TXN_KINDS = (
    "recharge",
    "recharge_bonus",
    "consultation",
    "refund",
    "free_session_grant",
    "promo_grant",
    "promo_expiry",
    "settlement",
    "adjustment",
)
ORDER_STATUSES = ("created", "paid", "failed")
OVERRIDE_ACTIONS = ("allow", "block")
RUN_STATUSES = ("running", "ok", "drift", "error")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class LedgerTransaction(Base):
    """One business event. `idempotency_key` is deterministic (ADR-0002 §4)."""

    __tablename__ = "ledger_transactions"
    __table_args__ = (
        CheckConstraint(_in("kind", TXN_KINDS), name="kind_known"),
        Index("ix_ledger_transactions_user_seq", "user_id", "seq"),
        Index("ix_ledger_transactions_session", "session_id"),
        Index("ix_ledger_transactions_kind_occurred", "kind", "occurred_at"),
        Index("ix_ledger_transactions_external_ref", "external_ref"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), unique=True)
    idempotency_key: Mapped[str] = mapped_column(Text, unique=True)
    payload_hash: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    astrologer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Gateway payment or settlement id, for reconciliation.
    external_ref: Mapped[str | None] = mapped_column(Text)
    reverses_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ledger_transactions.id"))
    # When the business event happened (gateway time for payments); created_at is when we posted.
    occurred_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("clock_timestamp()")
    )


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("amount_paise > 0", name="amount_positive"),
        CheckConstraint("direction IN ('debit', 'credit')", name="direction_known"),
        CheckConstraint(
            "account_id NOT LIKE 'user:%promo' OR promo_lot_id IS NOT NULL", name="promo_has_lot"
        ),
        Index("ix_ledger_entries_account", "account_id"),
        Index("ix_ledger_entries_lot", "promo_lot_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ledger_transactions.id"), index=True
    )
    account_id: Mapped[str] = mapped_column(Text)
    direction: Mapped[str] = mapped_column(Text)
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    promo_lot_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("promo_lots.id"))


class AccountBalance(Base):
    """Projection of an account's entries (user and astrologer accounts). Balance is on the
    account's normal side: credits - debits for liabilities, debits - credits for assets."""

    __tablename__ = "account_balances"
    __table_args__ = (
        CheckConstraint("account_id NOT LIKE 'user:%' OR balance_paise >= 0", name="user_nonneg"),
        CheckConstraint("normal_side IN ('debit', 'credit')", name="normal_side_known"),
    )

    account_id: Mapped[str] = mapped_column(Text, primary_key=True)
    normal_side: Mapped[str] = mapped_column(Text)
    balance_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    version: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PromoLot(Base):
    """Promotional credit with exact expiry. `session_id` set = usable only by that session."""

    __tablename__ = "promo_lots"
    __table_args__ = (
        CheckConstraint("amount_paise > 0", name="amount_positive"),
        CheckConstraint(
            "remaining_paise >= 0 AND remaining_paise <= amount_paise", name="remaining_range"
        ),
        Index(
            "ix_promo_lots_user_open",
            "user_id",
            "expires_at",
            postgresql_where=text("remaining_paise > 0"),
        ),
        Index("ix_promo_lots_session", "session_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    campaign: Mapped[str] = mapped_column(Text)
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    remaining_paise: Mapped[int] = mapped_column(BigInteger)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    source_transaction_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ledger_transactions.id"), unique=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    closed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class RechargeOrder(Base):
    __tablename__ = "recharge_orders"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key"),
        CheckConstraint("amount_paise > 0", name="amount_positive"),
        CheckConstraint("bonus_paise >= 0", name="bonus_nonneg"),
        CheckConstraint(_in("status", ORDER_STATUSES), name="status_known"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(Text)
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    bonus_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    currency: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="created")
    provider: Mapped[str] = mapped_column(Text)
    provider_order_id: Mapped[str | None] = mapped_column(Text, unique=True)
    provider_payment_id: Mapped[str | None] = mapped_column(Text)
    # Checkout handler result (recorded, never credited).
    checkout_payment_id: Mapped[str | None] = mapped_column(Text)
    checkout_verified: Mapped[bool | None] = mapped_column(Boolean)
    checkout_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    paid_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class PaymentEvent(Base):
    """Webhook events by provider event id (unique). Payload: ids, amounts and statuses only."""

    __tablename__ = "payment_events"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    provider: Mapped[str] = mapped_column(Text)
    event_id: Mapped[str] = mapped_column(Text, unique=True)
    event_type: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    provider_order_id: Mapped[str | None] = mapped_column(Text, index=True)
    provider_payment_id: Mapped[str | None] = mapped_column(Text)
    amount_paise: Mapped[int | None] = mapped_column(BigInteger)
    currency: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    received_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Refund(Base):
    """One row per refund transaction, for the admin list. The ledger is the record."""

    __tablename__ = "refunds"
    __table_args__ = (
        CheckConstraint("amount_paise > 0", name="amount_positive"),
        Index("ix_refunds_user_rule_created", "user_id", "rule", "created_at"),
        Index("ix_refunds_created", "created_at", "id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ledger_transactions.id"), unique=True
    )
    rule: Mapped[str] = mapped_column(Text)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    astrologer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    real_paise: Mapped[int] = mapped_column(BigInteger)
    promo_paise: Mapped[int] = mapped_column(BigInteger)
    commission_paise: Mapped[int] = mapped_column(BigInteger)
    astrologer_paise: Mapped[int] = mapped_column(BigInteger)
    actor: Mapped[str] = mapped_column(Text)
    # Admin's free-text reason (manual refunds). Never copied to logs or audit detail.
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("clock_timestamp()")
    )


class FreeSessionClaim(Base):
    """A user's first free session. Device and IP are HMAC-SHA256 with SECRET_KEY, never raw."""

    __tablename__ = "free_session_claims"
    __table_args__ = (Index("ix_free_session_claims_ip_day", "ip_hash", "ip_day"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    device_hash: Mapped[str] = mapped_column(Text, index=True)
    ip_hash: Mapped[str] = mapped_column(Text)
    ip_day: Mapped[dt.date] = mapped_column(Date)  # IST date of the claim
    abuse_score: Mapped[int] = mapped_column(Integer, default=0)
    reasons: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    claimed_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("clock_timestamp()")
    )


class FreeSessionOverride(Base):
    """Admin decision for a user (allow skips heuristics, block refuses). `resets` counts admin
    resets; it is part of the free-session grant key so a reset user can be granted again."""

    __tablename__ = "free_session_overrides"
    __table_args__ = (
        CheckConstraint(f"action IS NULL OR {_in('action', OVERRIDE_ACTIONS)}", name="action"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    action: Mapped[str | None] = mapped_column(Text)
    resets: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ReconciliationRun(Base):
    __tablename__ = "reconciliation_runs"
    __table_args__ = (
        CheckConstraint(_in("status", RUN_STATUSES), name="status_known"),
        Index("ix_reconciliation_runs_started", "started_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    run_date: Mapped[dt.date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(Text)
    drift_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    checks: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    trigger: Mapped[str] = mapped_column(Text)
    started_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("clock_timestamp()")
    )
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
