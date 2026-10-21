"""Background jobs table (ADR-0009) and ledger kinds for one-time purchases.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS = ("report_render", "ai_answer", "remedy_lead_notify", "report_email")
LEDGER_KINDS_BEFORE = (
    "recharge",
    "recharge_bonus",
    "consultation",
    "refund",
    "free_session_grant",
    "promo_grant",
    "promo_expiry",
    "settlement",
    "adjustment",
    "payout",
)
LEDGER_KINDS = (*LEDGER_KINDS_BEFORE, "purchase", "purchase_refund")
STATUSES = ("queued", "running", "done", "failed")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    op.drop_constraint("kind_known", "ledger_transactions", type_="check")
    op.create_check_constraint("kind_known", "ledger_transactions", _in("kind", LEDGER_KINDS))
    op.create_table(
        "jobs",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False, unique=True),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "run_after", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("locked_until", sa.DateTime(timezone=True)),
        sa.Column("last_error_code", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(_in("kind", KINDS), name="job_kind_known"),
        sa.CheckConstraint(_in("status", STATUSES), name="job_status_known"),
        sa.CheckConstraint("attempts >= 0", name="job_attempts_nonneg"),
    )
    op.create_index("ix_jobs_due", "jobs", ["status", "run_after"])


def downgrade() -> None:
    op.drop_table("jobs")
    op.drop_constraint("kind_known", "ledger_transactions", type_="check")
    # NOT VALID: posted purchases stay (append-only ledger); new ones are refused.
    kinds = _in("kind", LEDGER_KINDS_BEFORE)
    op.execute(
        f"ALTER TABLE ledger_transactions ADD CONSTRAINT kind_known CHECK ({kinds}) NOT VALID"
    )
