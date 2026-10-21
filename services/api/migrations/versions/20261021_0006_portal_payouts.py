"""Astrologer availability and monthly payouts (portal work, docs/api/portal.md §2-§3).

Also allows ledger transactions of kind `payout` (mark-paid posts `payout:{payout_id}`: debit
`astrologer:{id}:payable`, credit `bank:payouts`). The ledger is append-only, so a downgrade
cannot remove posted payout transactions: it restores the old kind list as NOT VALID, which
keeps existing rows and refuses new payout postings.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_KINDS = (
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
NEW_KINDS = (*OLD_KINDS, "payout")
STATUSES = ("draft", "approved", "paid", "void")


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _ts(name: str, *, nullable: bool = True) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.drop_constraint("kind_known", "ledger_transactions", type_="check")
    op.create_check_constraint("kind_known", "ledger_transactions", _in("kind", NEW_KINDS))

    op.create_table(
        "astrologer_availability",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "astrologer_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("astrologers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("weekday", sa.SmallInteger(), nullable=False),
        sa.Column("start_minute", sa.SmallInteger(), nullable=False),
        sa.Column("end_minute", sa.SmallInteger(), nullable=False),
        sa.CheckConstraint("weekday BETWEEN 0 AND 6", name="availability_weekday_range"),
        sa.CheckConstraint(
            "start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute",
            name="availability_time_range",
        ),
        sa.CheckConstraint(
            "start_minute % 15 = 0 AND end_minute % 15 = 0", name="availability_quarter_hours"
        ),
    )
    op.create_index(
        "ix_astrologer_availability_astrologer",
        "astrologer_availability",
        ["astrologer_id", "weekday", "start_minute"],
    )

    op.create_table(
        "payouts",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "astrologer_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("astrologers.id"),
            nullable=False,
        ),
        sa.Column("period", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("gross_paise", sa.BigInteger(), nullable=False),
        sa.Column("commission_paise", sa.BigInteger(), nullable=False),
        sa.Column("refunds_paise", sa.BigInteger(), nullable=False),
        sa.Column("carried_in_paise", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("net_paise", sa.BigInteger(), nullable=False),
        sa.Column("carried_forward_paise", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sessions", sa.Integer(), nullable=False),
        sa.Column("minutes", sa.Integer(), nullable=False),
        _ts("generated_at", nullable=False),
        _ts("approved_at"),
        sa.Column("approved_by", sa.Text()),
        _ts("paid_at"),
        sa.Column("paid_on", sa.Date()),
        sa.Column("paid_by", sa.Text()),
        sa.Column("reference", sa.Text()),
        sa.Column(
            "transaction_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("ledger_transactions.id"),
            unique=True,
        ),
        _ts("voided_at"),
        sa.Column("voided_by", sa.Text()),
        sa.Column("void_reason", sa.Text()),
        sa.Column("void_note", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("astrologer_id", "period", name="uq_payouts_astrologer_period"),
        sa.CheckConstraint(r"period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'", name="payout_period_format"),
        sa.CheckConstraint(_in("status", STATUSES), name="payout_status_known"),
        sa.CheckConstraint(
            "gross_paise >= 0 AND commission_paise >= 0 AND refunds_paise >= 0"
            " AND commission_paise <= gross_paise",
            name="payout_amounts_nonneg",
        ),
        sa.CheckConstraint(
            "net_paise = gross_paise - commission_paise - refunds_paise + carried_in_paise",
            name="payout_net_formula",
        ),
        sa.CheckConstraint("sessions >= 0 AND minutes >= 0", name="payout_counts_nonneg"),
        sa.CheckConstraint(
            "status = 'void' OR carried_forward_paise = 0", name="payout_carry_only_when_void"
        ),
        sa.CheckConstraint(
            "status <> 'paid' OR (net_paise > 0 AND reference IS NOT NULL AND paid_at IS NOT NULL"
            " AND paid_on IS NOT NULL AND transaction_id IS NOT NULL)",
            name="payout_paid_complete",
        ),
        sa.CheckConstraint(
            "status NOT IN ('approved', 'paid') OR approved_at IS NOT NULL",
            name="payout_approved_complete",
        ),
    )
    op.create_index("ix_payouts_astrologer_id", "payouts", ["astrologer_id"])
    op.create_index("ix_payouts_period_status", "payouts", ["period", "status"])


def downgrade() -> None:
    op.drop_index("ix_payouts_period_status", table_name="payouts")
    op.drop_index("ix_payouts_astrologer_id", table_name="payouts")
    op.drop_table("payouts")
    op.drop_index("ix_astrologer_availability_astrologer", table_name="astrologer_availability")
    op.drop_table("astrologer_availability")
    op.drop_constraint("kind_known", "ledger_transactions", type_="check")
    # NOT VALID: posted payout transactions stay (append-only ledger); new ones are refused.
    kinds = _in("kind", OLD_KINDS)
    op.execute(
        f"ALTER TABLE ledger_transactions ADD CONSTRAINT kind_known CHECK ({kinds}) NOT VALID"
    )
