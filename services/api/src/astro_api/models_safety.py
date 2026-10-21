"""Safety events, the moderation queue and astrologer strikes (migration 0013, ADR-0012,
docs/api/trust.md §3-§4).

No table here holds chat text. A safety event points at the flagged message by
(session_id, message_seq); refused astrologer messages are never stored, only their reason code.
A report's note is AES-256-GCM ciphertext (chat key set) bound to the row by `report_note_aad`.
"""

import datetime as dt
import uuid
from uuid import uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base
from astro_api.safety import CRISIS_KINDS, REFUSALS

MODERATION_KINDS = ("report", "safety", "refused")
MODERATION_STATUSES = ("open", "closed")
MODERATION_ACTIONS = ("dismiss", "warn", "suspend")
STRIKE_ACTIONS = ("warn", "suspend")
# Same values as packages/shared ASTROLOGER_REPORT_REASONS (test-enforced).
REPORT_REASONS = ("harassment", "scam", "fear_selling", "medical_claims", "off_platform", "other")
MODERATION_REASONS = REPORT_REASONS + CRISIS_KINDS + REFUSALS
NOTE_MAX = 500


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in dict.fromkeys(values)) + ")"


def report_note_aad(item_id: uuid.UUID) -> bytes:
    """Binds a sealed report note to its row, so a ciphertext cannot be moved to another one."""
    return f"astrologer_report:{item_id}:note".encode()


class SafetyEvent(Base):
    """A session flagged for crisis language from the client: one row per (session, kind), at
    the first flagged message. Its existence pauses upsell for the session."""

    __tablename__ = "safety_events"
    __table_args__ = (
        UniqueConstraint("session_id", "kind", name="uq_safety_events_session_kind"),
        CheckConstraint(_in("kind", CRISIS_KINDS), name="safety_event_kind_known"),
        CheckConstraint("message_seq > 0", name="safety_event_seq_pos"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("consult_sessions.id", ondelete="CASCADE")
    )
    message_seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(Text)
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModerationEvent(Base):
    """One item of the admin moderation queue.

    - `report`: a client reported an astrologer (reason, optional encrypted note). One open
      report per (reporter, astrologer); `Idempotency-Key` backed by UNIQUE(reporter, key).
    - `safety`: a session was flagged (reason = crisis kind); the flagged message can be
      revealed by an admin, audited.
    - `refused`: the astrologer's message broke a conduct rule and was not sent (reason = rule
      id). Repeats of the same rule in the same session add to `count` of the open item.
    """

    __tablename__ = "moderation_events"
    __table_args__ = (
        CheckConstraint(_in("kind", MODERATION_KINDS), name="moderation_kind_known"),
        CheckConstraint(_in("status", MODERATION_STATUSES), name="moderation_status_known"),
        CheckConstraint(_in("reason", MODERATION_REASONS), name="moderation_reason_known"),
        CheckConstraint(
            "action IS NULL OR " + _in("action", MODERATION_ACTIONS), name="moderation_action_known"
        ),
        CheckConstraint("count >= 1", name="moderation_count_pos"),
        CheckConstraint(
            f"char_length(action_note) <= {NOTE_MAX}", name="moderation_action_note_len"
        ),
        CheckConstraint(
            "(note_ciphertext IS NULL) = (note_nonce IS NULL) "
            "AND (note_ciphertext IS NULL) = (note_key_id IS NULL)",
            name="moderation_note_sealed",
        ),
        CheckConstraint(
            "(status = 'closed') = (closed_at IS NOT NULL)", name="moderation_closed_at"
        ),
        UniqueConstraint(
            "reporter_user_id", "idempotency_key", name="uq_moderation_events_reporter_key"
        ),
        Index(
            "uq_moderation_open_report",
            "reporter_user_id",
            "astrologer_id",
            unique=True,
            postgresql_where=text("kind = 'report' AND status = 'open'"),
        ),
        Index(
            "uq_moderation_open_refusal",
            "astrologer_id",
            "session_id",
            "reason",
            unique=True,
            postgresql_where=text("kind = 'refused' AND status = 'open'"),
        ),
        Index("ix_moderation_events_queue", "status", "kind", "last_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="open", server_default="open")
    reason: Mapped[str] = mapped_column(Text)
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE"), index=True
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("consult_sessions.id", ondelete="SET NULL"), index=True
    )
    safety_event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("safety_events.id", ondelete="CASCADE"), unique=True
    )
    reporter_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    request_hash: Mapped[str | None] = mapped_column(Text)
    note_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    note_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    note_key_id: Mapped[str | None] = mapped_column(Text)
    count: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[str | None] = mapped_column(Text)  # audit actor, e.g. user:{id}
    action: Mapped[str | None] = mapped_column(Text)
    # Resolution note; for warn/suspend it is also the strike note the astrologer sees.
    action_note: Mapped[str | None] = mapped_column(Text)


class AstrologerStrike(Base):
    """A warning (or suspension) recorded against an astrologer from a moderation item. The
    astrologer sees `note` in the portal: the admin's note, or the broken rule's text when the
    admin wrote none. Admins are told the note is shown to the astrologer."""

    __tablename__ = "astrologer_strikes"
    __table_args__ = (
        CheckConstraint(_in("action", STRIKE_ACTIONS), name="strike_action_known"),
        CheckConstraint(_in("reason", MODERATION_REASONS), name="strike_reason_known"),
        CheckConstraint(f"char_length(note) <= {NOTE_MAX}", name="strike_note_len"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE"), index=True
    )
    moderation_event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("moderation_events.id", ondelete="SET NULL"), unique=True
    )
    kind: Mapped[str] = mapped_column(Text)  # the moderation item's kind
    reason: Mapped[str] = mapped_column(Text)
    action: Mapped[str] = mapped_column(Text)
    note: Mapped[str] = mapped_column(Text)  # shown to the astrologer
    created_by: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
