"""Astrologer invites and content calendar tables (docs/api/growth.md §2.1, §4.1; migration 0015).

`astrologer_invites`: an invite code is stored only as HMAC-SHA256 keyed with SECRET_KEY
(`code_hash`); the code itself is shown once, on creation. Status is derived, never stored:
revoked > used > expired > open. `note` is admin-only.

`content_items`: the founder's content calendar (planning rows, no published content).
"""

import datetime as dt
import uuid
from uuid import uuid4

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

INVITE_STATUSES = ("open", "used", "expired", "revoked")
INVITE_NOTE_MAX = 200
CONTENT_KINDS = ("article", "horoscope", "tool_page", "social", "video", "other")
CONTENT_LOCALES = ("en", "hi", "both")
CONTENT_STATUSES = ("idea", "drafting", "review", "scheduled", "published")
CONTENT_TITLE_MAX = 160
CONTENT_NOTES_MAX = 1000
CONTENT_URL_MAX = 2000


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class AstrologerInvite(Base):
    __tablename__ = "astrologer_invites"
    __table_args__ = (
        CheckConstraint(f"char_length(note) <= {INVITE_NOTE_MAX}", name="invite_note_length"),
        CheckConstraint("expires_at > created_at", name="invite_expiry_after_creation"),
        Index("ix_astrologer_invites_created", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    code_hash: Mapped[str] = mapped_column(Text, unique=True)
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    used_by_astrologer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("astrologers.id", ondelete="SET NULL")
    )
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    def status_at(self, now: dt.datetime) -> str:
        if self.revoked_at is not None:
            return "revoked"
        if self.used_at is not None:
            return "used"
        if self.expires_at <= now:
            return "expired"
        return "open"


class ContentItem(Base):
    __tablename__ = "content_items"
    __table_args__ = (
        CheckConstraint(_in("kind", CONTENT_KINDS), name="content_kind_known"),
        CheckConstraint(_in("locale", CONTENT_LOCALES), name="content_locale_known"),
        CheckConstraint(_in("status", CONTENT_STATUSES), name="content_status_known"),
        CheckConstraint(
            f"char_length(title) BETWEEN 1 AND {CONTENT_TITLE_MAX}", name="content_title_length"
        ),
        CheckConstraint(
            f"notes IS NULL OR char_length(notes) <= {CONTENT_NOTES_MAX}",
            name="content_notes_length",
        ),
        CheckConstraint(
            "status <> 'published' OR url IS NOT NULL", name="content_published_has_url"
        ),
        Index("ix_content_items_due", "due_date", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    title: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    locale: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="idea", server_default="idea")
    due_date: Mapped[dt.date | None] = mapped_column(Date)
    url: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
