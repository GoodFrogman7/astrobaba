"""AI assistant conversations and questions (ADR-0010).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-21

Independent of the reports tables in 0009: only users and saved_kundlis are referenced.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUSES = ("queued", "answered", "blocked", "failed")
REASONS = ("self_harm", "medical", "legal", "financial", "other")
LANGUAGES = ("en", "hi")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    op.create_table(
        "ai_conversations",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "kundli_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("saved_kundlis.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_ai_conversations_user_id", "ai_conversations", ["user_id"])
    op.create_index("ix_ai_conversations_kundli_id", "ai_conversations", ["kundli_id"])
    op.create_table(
        "ai_questions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("ai_conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("text_ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("text_nonce", sa.LargeBinary(), nullable=False),
        sa.Column("text_key_id", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("answer_ciphertext", sa.LargeBinary()),
        sa.Column("answer_nonce", sa.LargeBinary()),
        sa.Column("answer_key_id", sa.Text()),
        sa.Column("blocked_reason", sa.Text()),
        sa.Column("notice", sa.Text()),
        sa.Column("ai_label", sa.Text()),
        sa.Column("handoff", sa.Text()),
        sa.Column("price_paise", sa.Integer(), nullable=False),
        sa.Column("refunded", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("model", sa.Text()),
        sa.Column("prompt_version", sa.Text()),
        sa.Column("error_code", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("answered_at", sa.DateTime(timezone=True)),
        sa.Column("refunded_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_ai_questions_user_key"),
        sa.CheckConstraint(_in("status", STATUSES), name="ai_question_status_known"),
        sa.CheckConstraint(
            "blocked_reason IS NULL OR " + _in("blocked_reason", REASONS),
            name="ai_question_blocked_reason_known",
        ),
        sa.CheckConstraint(_in("language", LANGUAGES), name="ai_question_language_known"),
        sa.CheckConstraint("price_paise >= 0", name="ai_question_price_nonneg"),
        sa.CheckConstraint(
            "(status = 'blocked') = (blocked_reason IS NOT NULL)",
            name="ai_question_blocked_has_reason",
        ),
        sa.CheckConstraint(
            "(status = 'answered') = (answer_ciphertext IS NOT NULL)",
            name="ai_question_answered_has_answer",
        ),
        sa.CheckConstraint(
            "NOT refunded OR price_paise > 0", name="ai_question_refund_needs_charge"
        ),
    )
    op.create_index(
        "ix_ai_questions_conversation", "ai_questions", ["conversation_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_table("ai_questions")
    op.drop_table("ai_conversations")
