"""Consents, data exports, deletion requests (migration 0012, ADR-0011, docs/api/trust.md §1-§2).

`consents` is the proof of what a user accepted: append-only (a trigger rejects UPDATE and
DELETE), one row per (user, kind, version). The IP and device are stored only as HMAC-SHA256
keyed with SECRET_KEY, never raw.

`data_exports`: one JSON file per request, built by the `data_export` job and stored with the
documents storage under a random key; the file is removed when it expires (`account_cleanup`).

`deletion_requests`: a user asks, an admin executes. Execution anonymises the account in one
transaction and lists the files to remove in `pending_files` (storage keys only) for the
`account_cleanup` job.
"""

import datetime as dt
import uuid
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

CONSENT_KINDS = ("age_18", "terms", "privacy", "astrologer_terms")
EXPORT_STATUSES = ("queued", "ready", "failed", "expired")
DELETION_STATUSES = ("requested", "cancelled", "executed")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class Consent(Base):
    __tablename__ = "consents"
    __table_args__ = (
        CheckConstraint(_in("kind", CONSENT_KINDS), name="consent_kind_known"),
        UniqueConstraint("user_id", "kind", "version", name="uq_consents_user_kind_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    # Kept after account deletion (the anonymised user row stays): proof of consent.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(Text)
    version: Mapped[str] = mapped_column(Text)  # data/legal/policies.json `version`
    accepted_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("clock_timestamp()")
    )
    ip_hash: Mapped[str | None] = mapped_column(Text)
    device_hash: Mapped[str | None] = mapped_column(Text)


class DataExport(Base):
    __tablename__ = "data_exports"
    __table_args__ = (
        CheckConstraint(_in("status", EXPORT_STATUSES), name="data_export_status_known"),
        CheckConstraint(
            "status <> 'ready' OR (storage_key IS NOT NULL AND expires_at IS NOT NULL)",
            name="data_export_ready_has_file",
        ),
        Index("ix_data_exports_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(Text, default="queued", server_default="queued")
    storage_key: Mapped[str | None] = mapped_column(Text, unique=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    last_error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("clock_timestamp()")
    )
    ready_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # When the file is removed (account_cleanup job scheduled for this time).
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class DeletionRequest(Base):
    __tablename__ = "deletion_requests"
    __table_args__ = (
        CheckConstraint(_in("status", DELETION_STATUSES), name="deletion_status_known"),
        CheckConstraint(
            "status <> 'executed' OR (executed_at IS NOT NULL AND executed_by IS NOT NULL)",
            name="deletion_executed_complete",
        ),
        # At most one open request per user.
        Index(
            "uq_deletion_requests_one_open",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'requested'"),
        ),
        Index("ix_deletion_requests_status_requested", "status", "requested_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(Text, default="requested", server_default="requested")
    requested_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    cancelled_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    executed_by: Mapped[str | None] = mapped_column(Text)  # audit actor (user:{id}), never a phone
    # Files the cleanup job still has to remove: [{"kind": "report"|"export", "id", "key"}].
    pending_files: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )
    files_cleaned_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # The account had KYC documents: kept (retention to be decided with the lawyer) and listed
    # here for an admin review instead of being deleted.
    kyc_review_required: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
