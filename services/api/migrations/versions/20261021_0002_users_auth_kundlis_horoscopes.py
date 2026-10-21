"""Users, phone-OTP sessions, saved kundlis, horoscope QA queue, audit log.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

gender = pg.ENUM("female", "male", "other", name="gender", create_type=False)
period = pg.ENUM("daily", "weekly", "monthly", name="horoscope_period", create_type=False)
status = pg.ENUM(
    "pending_review", "published", "rejected", name="horoscope_status", create_type=False
)


def upgrade() -> None:
    bind = op.get_bind()
    for enum in (gender, period, status):
        enum.create(bind, checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("phone", pg.CITEXT(), nullable=False, unique=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.Column("locale", sa.Text(), server_default="en", nullable=False),
        sa.Column("is_adult_confirmed", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("device_ids", pg.ARRAY(sa.Text()), server_default="{}", nullable=False),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False, unique=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("device_id", sa.Text()),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_table(
        "saved_kundlis",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("gender", gender),
        sa.Column("birth_date", sa.Date(), nullable=False),
        sa.Column("birth_time", sa.Time()),
        sa.Column("unknown_time", sa.Boolean(), nullable=False),
        sa.Column("birth_datetime_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tz", sa.Text(), nullable=False),
        sa.Column("utc_offset", sa.Text(), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("place_label", sa.Text()),
        sa.Column("city_id", sa.Integer()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_saved_kundlis_user_id", "saved_kundlis", ["user_id"])
    op.create_table(
        "horoscope_entries",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("period", period, nullable=False),
        sa.Column("sign", sa.Text(), nullable=False),
        sa.Column("ist_date", sa.Date(), nullable=False),
        sa.Column("ist_date_end", sa.Date(), nullable=False),
        sa.Column("locale", sa.Text(), nullable=False),
        sa.Column("sections", pg.JSONB(), nullable=False),
        sa.Column("scores", pg.JSONB(), nullable=False),
        sa.Column("lucky", pg.JSONB(), nullable=False),
        sa.Column("facts", pg.JSONB(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("status", status, nullable=False, server_default="pending_review"),
        sa.Column("reviewed_by", sa.Text()),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("review_note", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("period", "sign", "ist_date", "locale"),
        sa.CheckConstraint("ist_date_end >= ist_date", name="ck_horoscope_window"),
    )
    op.create_index("ix_horoscope_entries_status", "horoscope_entries", ["status"])
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("entity", sa.Text(), nullable=False),
        sa.Column("entity_id", sa.Text()),
        sa.Column("detail", pg.JSONB(), server_default="{}", nullable=False),
    )


def downgrade() -> None:
    for table in ("audit_log", "horoscope_entries", "saved_kundlis", "auth_sessions", "users"):
        op.drop_table(table)
    bind = op.get_bind()
    for enum in (status, period, gender):
        enum.drop(bind, checkfirst=True)
