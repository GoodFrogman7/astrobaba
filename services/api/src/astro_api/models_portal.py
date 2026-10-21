"""Astrologer portal tables (migration 0006). Owned by the portal work.

`astrologer_availability`: the weekly schedule (informational; presence comes from the online
toggle). Times are IST minutes since midnight in 15-minute steps; `end_minute` may be 1440
("24:00") so an overnight shift is two slots.

`payouts`: one monthly statement per astrologer per IST month (UNIQUE). Figures come from the
ledger (astro_api.earnings); a row is a snapshot taken at generation. Money is integer paise.
`net_paise = gross - commission - refunds + carried_in` is enforced by a CHECK. Bank details are
not stored here (manual transfers in v1); the bank UTR goes in `reference` once paid.
"""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    SmallInteger,
    Text,
    UniqueConstraint,
    func,
    select,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

IST_ZONE = "Asia/Kolkata"
PAYOUT_STATUSES = ("draft", "approved", "paid", "void")
SLOT_STEP_MINUTES = 15
MAX_SLOTS = 21


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class AstrologerAvailability(Base):
    __tablename__ = "astrologer_availability"
    __table_args__ = (
        CheckConstraint("weekday BETWEEN 0 AND 6", name="availability_weekday_range"),
        CheckConstraint(
            "start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute",
            name="availability_time_range",
        ),
        CheckConstraint(
            "start_minute % 15 = 0 AND end_minute % 15 = 0", name="availability_quarter_hours"
        ),
        Index("ix_astrologer_availability_astrologer", "astrologer_id", "weekday", "start_minute"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE")
    )
    weekday: Mapped[int] = mapped_column(SmallInteger)  # 0 = Monday
    start_minute: Mapped[int] = mapped_column(SmallInteger)
    end_minute: Mapped[int] = mapped_column(SmallInteger)


class Payout(Base):
    __tablename__ = "payouts"
    __table_args__ = (
        UniqueConstraint("astrologer_id", "period", name="uq_payouts_astrologer_period"),
        CheckConstraint(r"period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'", name="payout_period_format"),
        CheckConstraint(
            "status IN (" + ", ".join(f"'{s}'" for s in PAYOUT_STATUSES) + ")",
            name="payout_status_known",
        ),
        CheckConstraint(
            "gross_paise >= 0 AND commission_paise >= 0 AND refunds_paise >= 0"
            " AND commission_paise <= gross_paise",
            name="payout_amounts_nonneg",
        ),
        CheckConstraint(
            "net_paise = gross_paise - commission_paise - refunds_paise + carried_in_paise",
            name="payout_net_formula",
        ),
        CheckConstraint("sessions >= 0 AND minutes >= 0", name="payout_counts_nonneg"),
        CheckConstraint(
            "status = 'void' OR carried_forward_paise = 0", name="payout_carry_only_when_void"
        ),
        CheckConstraint(
            "status <> 'paid' OR (net_paise > 0 AND reference IS NOT NULL AND paid_at IS NOT NULL"
            " AND paid_on IS NOT NULL AND transaction_id IS NOT NULL)",
            name="payout_paid_complete",
        ),
        CheckConstraint(
            "status NOT IN ('approved', 'paid') OR approved_at IS NOT NULL",
            name="payout_approved_complete",
        ),
        Index("ix_payouts_period_status", "period", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    astrologer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("astrologers.id"), index=True)
    period: Mapped[str] = mapped_column(Text)  # "YYYY-MM", IST month
    status: Mapped[str] = mapped_column(Text)
    gross_paise: Mapped[int] = mapped_column(BigInteger)
    commission_paise: Mapped[int] = mapped_column(BigInteger)
    refunds_paise: Mapped[int] = mapped_column(BigInteger)
    # Unpaid balance brought in from earlier periods (void payouts, earnings before the first
    # statement); may be negative when refunds after a payout left a debt.
    carried_in_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    net_paise: Mapped[int] = mapped_column(BigInteger)
    # Void only: the net that rolls into the next generation.
    carried_forward_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    sessions: Mapped[int] = mapped_column(Integer)
    minutes: Mapped[int] = mapped_column(Integer)
    generated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[str | None] = mapped_column(Text)
    paid_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    paid_on: Mapped[dt.date | None] = mapped_column(Date)
    paid_by: Mapped[str | None] = mapped_column(Text)
    reference: Mapped[str | None] = mapped_column(Text)  # bank UTR
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ledger_transactions.id"), unique=True
    )
    voided_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    voided_by: Mapped[str | None] = mapped_column(Text)
    # `below_minimum` (set by generation) or `admin`. The admin's free-text note is kept on the
    # row, never in audit detail or logs.
    void_reason: Mapped[str | None] = mapped_column(Text)
    void_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# ---------------------------------------------------------------- availability helpers
# Here (not in portal_api) so the public profile can use them without an import cycle.


def hhmm(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def slot_view(row: AstrologerAvailability) -> dict[str, Any]:
    return {"weekday": row.weekday, "start": hhmm(row.start_minute), "end": hhmm(row.end_minute)}


async def availability_view(db: AsyncSession, astrologer_id: uuid.UUID) -> dict[str, Any]:
    """`{timezone, slots}` ordered by weekday then start; empty schedule → `slots: []`."""
    rows = (
        await db.execute(
            select(AstrologerAvailability)
            .where(AstrologerAvailability.astrologer_id == astrologer_id)
            .order_by(AstrologerAvailability.weekday, AstrologerAvailability.start_minute)
        )
    ).scalars()
    return {"timezone": IST_ZONE, "slots": [slot_view(r) for r in rows]}
