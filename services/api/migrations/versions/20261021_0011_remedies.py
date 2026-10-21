"""Remedies partner leads (docs/api/revenue.md §4).

Only `users` (0002) and `jobs` (0008) are relied on; nothing from 0009/0010.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUSES = ("new", "contacted", "closed", "spam")
LANGUAGES = ("en", "hi")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    op.create_table(
        "remedy_leads",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("remedy_id", sa.Text(), nullable=False),
        sa.Column("partner_id", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("preferred_date", sa.Date()),
        sa.Column("phone", sa.Text(), nullable=False),
        sa.Column("note_ciphertext", sa.LargeBinary()),
        sa.Column("note_nonce", sa.LargeBinary()),
        sa.Column("note_key_id", sa.Text()),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="new"),
        sa.Column("admin_note", sa.Text()),
        sa.Column("status_changed_at", sa.DateTime(timezone=True)),
        sa.Column("status_changed_by", sa.Text()),
        sa.Column("notified_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(_in("status", STATUSES), name="remedy_lead_status_known"),
        sa.CheckConstraint(_in("language", LANGUAGES), name="remedy_lead_language_known"),
        sa.CheckConstraint(
            "(note_ciphertext IS NULL) = (note_nonce IS NULL) "
            "AND (note_ciphertext IS NULL) = (note_key_id IS NULL)",
            name="remedy_lead_note_sealed",
        ),
        sa.CheckConstraint("char_length(admin_note) <= 500", name="remedy_lead_admin_note_len"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_remedy_leads_user_key"),
    )
    op.create_index("ix_remedy_leads_user_id", "remedy_leads", ["user_id"])
    op.create_index("ix_remedy_leads_status_created", "remedy_leads", ["status", "created_at"])


def downgrade() -> None:
    op.drop_table("remedy_leads")
