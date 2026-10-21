"""Safety events, astrologer reports, moderation queue and strikes (docs/api/trust.md §3-§4,
ADR-0012).

Relies only on `users` (0002), `astrologers` (0003) and `consult_sessions` (0005); nothing from
0012. No column holds chat text.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-21
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copies of the values in models_safety / safety at the time of this migration.
CRISIS_KINDS = ("self_harm", "emergency")
REFUSALS = (
    "contact_details",
    "off_platform_payment",
    "cure_claim",
    "guarantee",
    "fear_selling",
    "remedy_sale",
)
REPORT_REASONS = ("harassment", "scam", "fear_selling", "medical_claims", "off_platform", "other")
REASONS = tuple(dict.fromkeys(REPORT_REASONS + CRISIS_KINDS + REFUSALS))
KINDS = ("report", "safety", "refused")
STATUSES = ("open", "closed")
ACTIONS = ("dismiss", "warn", "suspend")
STRIKE_ACTIONS = ("warn", "suspend")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def _uuid(name: str, target: str | None = None, ondelete: str | None = None) -> sa.Column[Any]:
    if target is None:
        return sa.Column(name, pg.UUID(as_uuid=True))
    return sa.Column(name, pg.UUID(as_uuid=True), sa.ForeignKey(target, ondelete=ondelete))


def _now(name: str) -> sa.Column[Any]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    op.create_table(
        "safety_events",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("consult_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("message_seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        _now("at"),
        sa.UniqueConstraint("session_id", "kind", name="uq_safety_events_session_kind"),
        sa.CheckConstraint(_in("kind", CRISIS_KINDS), name="safety_event_kind_known"),
        sa.CheckConstraint("message_seq > 0", name="safety_event_seq_pos"),
    )

    op.create_table(
        "moderation_events",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="open"),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column(
            "astrologer_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("astrologers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        _uuid("session_id", "consult_sessions.id", "SET NULL"),
        _uuid("safety_event_id", "safety_events.id", "CASCADE"),
        _uuid("reporter_user_id", "users.id", "SET NULL"),
        sa.Column("idempotency_key", sa.Text()),
        sa.Column("request_hash", sa.Text()),
        sa.Column("note_ciphertext", sa.LargeBinary()),
        sa.Column("note_nonce", sa.LargeBinary()),
        sa.Column("note_key_id", sa.Text()),
        sa.Column("count", sa.Integer(), nullable=False, server_default="1"),
        _now("created_at"),
        _now("last_at"),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("closed_by", sa.Text()),
        sa.Column("action", sa.Text()),
        sa.Column("action_note", sa.Text()),
        sa.CheckConstraint(_in("kind", KINDS), name="moderation_kind_known"),
        sa.CheckConstraint(_in("status", STATUSES), name="moderation_status_known"),
        sa.CheckConstraint(_in("reason", REASONS), name="moderation_reason_known"),
        sa.CheckConstraint(
            "action IS NULL OR " + _in("action", ACTIONS), name="moderation_action_known"
        ),
        sa.CheckConstraint("count >= 1", name="moderation_count_pos"),
        sa.CheckConstraint("char_length(action_note) <= 500", name="moderation_action_note_len"),
        sa.CheckConstraint(
            "(note_ciphertext IS NULL) = (note_nonce IS NULL) "
            "AND (note_ciphertext IS NULL) = (note_key_id IS NULL)",
            name="moderation_note_sealed",
        ),
        sa.CheckConstraint(
            "(status = 'closed') = (closed_at IS NOT NULL)", name="moderation_closed_at"
        ),
        sa.UniqueConstraint("safety_event_id", name="uq_moderation_events_safety_event"),
        sa.UniqueConstraint(
            "reporter_user_id", "idempotency_key", name="uq_moderation_events_reporter_key"
        ),
    )
    op.create_index("ix_moderation_events_astrologer_id", "moderation_events", ["astrologer_id"])
    op.create_index("ix_moderation_events_session_id", "moderation_events", ["session_id"])
    op.create_index(
        "ix_moderation_events_reporter_user_id", "moderation_events", ["reporter_user_id"]
    )
    op.create_index(
        "ix_moderation_events_queue", "moderation_events", ["status", "kind", "last_at"]
    )
    op.create_index(
        "uq_moderation_open_report",
        "moderation_events",
        ["reporter_user_id", "astrologer_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'report' AND status = 'open'"),
    )
    op.create_index(
        "uq_moderation_open_refusal",
        "moderation_events",
        ["astrologer_id", "session_id", "reason"],
        unique=True,
        postgresql_where=sa.text("kind = 'refused' AND status = 'open'"),
    )

    op.create_table(
        "astrologer_strikes",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "astrologer_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("astrologers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        _uuid("moderation_event_id", "moderation_events.id", "SET NULL"),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        _now("created_at"),
        sa.CheckConstraint(_in("action", STRIKE_ACTIONS), name="strike_action_known"),
        sa.CheckConstraint(_in("reason", REASONS), name="strike_reason_known"),
        sa.CheckConstraint("char_length(note) <= 500", name="strike_note_len"),
        sa.UniqueConstraint("moderation_event_id", name="uq_astrologer_strikes_event"),
    )
    op.create_index("ix_astrologer_strikes_astrologer_id", "astrologer_strikes", ["astrologer_id"])


def downgrade() -> None:
    op.drop_table("astrologer_strikes")
    op.drop_table("moderation_events")
    op.drop_table("safety_events")
