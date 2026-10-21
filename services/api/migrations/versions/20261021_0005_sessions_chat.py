"""Consultation sessions, queue and encrypted chat messages (sessions work).

The `session_status` enum gains queued/accepted. Postgres cannot use a value added with
`ALTER TYPE ... ADD VALUE` in the same transaction (the partial index below needs them), so the
type is recreated instead: rename, create, convert the column, drop the old one. That keeps the
whole migration transactional and makes the downgrade the mirror image.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_STATUSES = ("requested", "active", "completed", "cancelled", "failed")
NEW_STATUSES = (
    "queued",
    "requested",
    "accepted",
    "active",
    "completed",
    "cancelled",
    "failed",
)
END_REASONS = (
    "user_ended",
    "astrologer_ended",
    "insufficient_funds",
    "free_minutes_used",
    "user_cancelled",
    "astrologer_declined",
    "request_timeout",
    "join_timeout",
    "user_dropped",
    "astrologer_dropped",
    "admin",
)
OPEN = "status IN ('queued', 'requested', 'accepted', 'active')"


def _replace_status_type(values: Sequence[str], using: str) -> None:
    labels = ", ".join(f"'{v}'" for v in values)
    op.execute("ALTER TABLE consult_sessions ALTER COLUMN status DROP DEFAULT")
    op.execute("ALTER TYPE session_status RENAME TO session_status_old")
    op.execute(f"CREATE TYPE session_status AS ENUM ({labels})")
    op.execute(
        f"ALTER TABLE consult_sessions ALTER COLUMN status TYPE session_status USING ({using})"
    )
    op.execute("DROP TYPE session_status_old")
    op.execute("ALTER TABLE consult_sessions ALTER COLUMN status SET DEFAULT 'requested'")


def _ts(name: str) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(name, sa.DateTime(timezone=True), nullable=True)


def upgrade() -> None:
    _replace_status_type(NEW_STATUSES, "status::text::session_status")

    for column in (
        sa.Column("end_reason", sa.Text()),
        _ts("queued_at"),
        _ts("requested_at"),
        _ts("accepted_at"),
        sa.Column("price_per_min_paise", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("commission_bps", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_free", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("free_minutes", sa.Integer()),
        sa.Column("billed_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("billed_paise", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("idempotency_key", sa.Text()),
        sa.Column("request_hash", sa.Text()),
        sa.Column("last_seq", sa.Integer(), nullable=False, server_default="0"),
        _ts("user_last_seen_at"),
        _ts("astrologer_last_seen_at"),
        _ts("settled_at"),
    ):
        op.add_column("consult_sessions", column)
    # Rows from Phase 3 have nothing left to settle.
    op.execute(
        "UPDATE consult_sessions SET settled_at = COALESCE(ended_at, created_at) "
        "WHERE status IN ('completed', 'cancelled', 'failed')"
    )
    op.create_unique_constraint(
        "uq_consult_sessions_user_idem", "consult_sessions", ["user_id", "idempotency_key"]
    )
    op.create_check_constraint(
        "session_price_nonneg", "consult_sessions", "price_per_min_paise >= 0"
    )
    op.create_check_constraint(
        "session_commission_range", "consult_sessions", "commission_bps BETWEEN 0 AND 10000"
    )
    op.create_check_constraint(
        "session_billed_nonneg", "consult_sessions", "billed_minutes >= 0 AND billed_paise >= 0"
    )
    op.create_check_constraint("session_last_seq_nonneg", "consult_sessions", "last_seq >= 0")
    op.create_check_constraint(
        "session_end_reason_known",
        "consult_sessions",
        "end_reason IS NULL OR end_reason IN (" + ", ".join(f"'{r}'" for r in END_REASONS) + ")",
    )
    op.create_index(
        "uq_consult_sessions_one_open_per_user",
        "consult_sessions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text(OPEN),
    )
    op.create_index(
        "ix_consult_sessions_status_astrologer", "consult_sessions", ["status", "astrologer_id"]
    )

    op.create_table(
        "chat_messages",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("consult_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("sender", sa.Text(), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("key_id", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("session_id", "seq", name="uq_chat_messages_session_seq"),
        sa.UniqueConstraint("session_id", "sender", "client_id", name="uq_chat_messages_client_id"),
        sa.CheckConstraint("sender IN ('user', 'astrologer', 'system')", name="chat_sender_known"),
        sa.CheckConstraint("seq > 0", name="chat_seq_pos"),
    )


def downgrade() -> None:
    op.drop_table("chat_messages")
    op.drop_index("ix_consult_sessions_status_astrologer", table_name="consult_sessions")
    op.drop_index("uq_consult_sessions_one_open_per_user", table_name="consult_sessions")
    for name in (
        "session_end_reason_known",
        "session_last_seq_nonneg",
        "session_billed_nonneg",
        "session_commission_range",
        "session_price_nonneg",
    ):
        op.drop_constraint(name, "consult_sessions", type_="check")
    op.drop_constraint("uq_consult_sessions_user_idem", "consult_sessions", type_="unique")
    for name in (
        "settled_at",
        "astrologer_last_seen_at",
        "user_last_seen_at",
        "last_seq",
        "request_hash",
        "idempotency_key",
        "billed_paise",
        "billed_minutes",
        "free_minutes",
        "is_free",
        "commission_bps",
        "price_per_min_paise",
        "accepted_at",
        "requested_at",
        "queued_at",
        "end_reason",
    ):
        op.drop_column("consult_sessions", name)
    # queued/accepted have no Phase 3 equivalent: they were open requests, so they map to
    # requested (an accepted session never started).
    _replace_status_type(
        OLD_STATUSES,
        "CASE WHEN status::text IN ('queued', 'accepted') THEN 'requested' "
        "ELSE status::text END::session_status",
    )
