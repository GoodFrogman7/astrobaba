"""AI assistant conversations and questions (migration 0010, ADR-0010).

Question text and answers are personal data: they are stored only as AES-256-GCM ciphertext
(astro_api.chat_crypto, same key set as chat), never logged and never put in job payloads.
"""

import datetime as dt
import uuid
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

AI_QUESTION_STATUSES = ("queued", "answered", "blocked", "failed")
AI_BLOCKED_REASONS = ("self_harm", "medical", "legal", "financial", "other")
AI_LANGUAGES = ("en", "hi")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class AiConversation(Base):
    __tablename__ = "ai_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Deleting the saved kundli deletes its AI conversations (the answers are about that chart).
    kundli_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("saved_kundlis.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AiQuestion(Base):
    __tablename__ = "ai_questions"
    __table_args__ = (
        # Backs Idempotency-Key in Postgres, so a retry is safe even after a Redis flush.
        UniqueConstraint("user_id", "idempotency_key", name="uq_ai_questions_user_key"),
        CheckConstraint(_in("status", AI_QUESTION_STATUSES), name="ai_question_status_known"),
        CheckConstraint(
            "blocked_reason IS NULL OR " + _in("blocked_reason", AI_BLOCKED_REASONS),
            name="ai_question_blocked_reason_known",
        ),
        CheckConstraint(_in("language", AI_LANGUAGES), name="ai_question_language_known"),
        CheckConstraint("price_paise >= 0", name="ai_question_price_nonneg"),
        CheckConstraint(
            "(status = 'blocked') = (blocked_reason IS NOT NULL)",
            name="ai_question_blocked_has_reason",
        ),
        CheckConstraint(
            "(status = 'answered') = (answer_ciphertext IS NOT NULL)",
            name="ai_question_answered_has_answer",
        ),
        CheckConstraint("NOT refunded OR price_paise > 0", name="ai_question_refund_needs_charge"),
        Index("ix_ai_questions_conversation", "conversation_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ai_conversations.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    idempotency_key: Mapped[str] = mapped_column(Text)
    request_hash: Mapped[str] = mapped_column(Text)
    # The question, encrypted (AAD binds it to this row and field).
    text_ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    text_nonce: Mapped[bytes] = mapped_column(LargeBinary)
    text_key_id: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="queued", server_default="queued")
    # The answer, encrypted, only when answered. Stored plain of label and hand-off.
    answer_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    answer_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    answer_key_id: Mapped[str | None] = mapped_column(Text)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    # Fixed product copy (never user content) shown with a blocked or failed question.
    notice: Mapped[str | None] = mapped_column(Text)
    # Fixed AI label and human hand-off line in the question's language, set when it is decided.
    ai_label: Mapped[str | None] = mapped_column(Text)
    handoff: Mapped[str | None] = mapped_column(Text)
    # 0 when nothing was charged (a question blocked before charging).
    price_paise: Mapped[int] = mapped_column(Integer)
    refunded: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    model: Mapped[str | None] = mapped_column(Text)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(Text)  # short machine code, never content
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    answered_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
