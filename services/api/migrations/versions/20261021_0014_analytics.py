"""First-party analytics events (docs/api/growth.md §1, ADR-0013).

Relies only on `users` (0002). No column holds an IP, a user agent or free text.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "analytics_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        sa.Column("event", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("anonymous_id", sa.Text(), nullable=False),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("locale", sa.Text(), nullable=False),
        sa.Column("properties", pg.JSONB(), nullable=False),
    )
    op.create_index(
        "ix_analytics_events_anonymous_id_occurred_at",
        "analytics_events",
        ["anonymous_id", "occurred_at"],
    )
    op.create_index(
        "ix_analytics_events_event_occurred_at", "analytics_events", ["event", "occurred_at"]
    )
    op.create_index("ix_analytics_events_user_id", "analytics_events", ["user_id"])


def downgrade() -> None:
    op.drop_table("analytics_events")
