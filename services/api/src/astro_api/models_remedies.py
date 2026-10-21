"""Remedies catalogue leads routed to partners (migration 0011, docs/api/revenue.md §4).

The catalogue itself is static data (data/marketplace/remedies.json); only leads live here. A
lead keeps the phone number the user agreed to share, for the partner hand-off only (every view
masks it), and the optional note encrypted with the chat key (AES-256-GCM, AAD
`remedy_lead:{id}`).
"""

import datetime as dt
import uuid
from uuid import uuid4

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

LEAD_STATUSES = ("new", "contacted", "closed", "spam")
LEAD_LANGUAGES = ("en", "hi")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class RemedyLead(Base):
    __tablename__ = "remedy_leads"
    __table_args__ = (
        CheckConstraint(_in("status", LEAD_STATUSES), name="remedy_lead_status_known"),
        CheckConstraint(_in("language", LEAD_LANGUAGES), name="remedy_lead_language_known"),
        CheckConstraint(
            "(note_ciphertext IS NULL) = (note_nonce IS NULL) "
            "AND (note_ciphertext IS NULL) = (note_key_id IS NULL)",
            name="remedy_lead_note_sealed",
        ),
        CheckConstraint("char_length(admin_note) <= 500", name="remedy_lead_admin_note_len"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_remedy_leads_user_key"),
        Index("ix_remedy_leads_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    idempotency_key: Mapped[str] = mapped_column(Text)
    remedy_id: Mapped[str] = mapped_column(Text)
    partner_id: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(Text)
    preferred_date: Mapped[dt.date | None] = mapped_column(Date)
    # E.164, for the partner hand-off only; masked in every API view and never logged.
    phone: Mapped[str] = mapped_column(Text)
    note_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    note_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    note_key_id: Mapped[str | None] = mapped_column(Text)
    consent_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, default="new", server_default="new")
    admin_note: Mapped[str | None] = mapped_column(Text)
    status_changed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    status_changed_by: Mapped[str | None] = mapped_column(Text)  # audit actor, never a phone
    notified_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


def note_aad(lead_id: uuid.UUID) -> bytes:
    """Binds a sealed note to its lead, so a ciphertext cannot be moved to another row."""
    return f"remedy_lead:{lead_id}".encode()
