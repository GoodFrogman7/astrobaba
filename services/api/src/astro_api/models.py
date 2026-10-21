"""Tables (migrations 0002, 0003). Birth details, phone numbers and KYC documents are personal
data: never log them."""

import datetime as dt
import uuid
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

GENDERS = ("female", "male", "other")
PERIODS = ("daily", "weekly", "monthly")
HOROSCOPE_STATUSES = ("pending_review", "published", "rejected")
ASTROLOGER_STATUSES = (
    "applied",
    "kyc_submitted",
    "interview",
    "probation",
    "approved",
    "suspended",
    "rejected",
)
PUBLIC_STATUSES = ("probation", "approved")
VERIFICATION_STEPS = ("identity", "qualification", "interview", "probation")
VERIFICATION_STATUSES = ("pending", "passed", "failed")
DOCUMENT_KINDS = ("identity", "qualification", "other")
DOCUMENT_REVIEW = ("pending", "accepted", "rejected")
SESSION_KINDS = ("chat", "call")
SESSION_STATUSES = (
    "queued",
    "requested",
    "accepted",
    "active",
    "completed",
    "cancelled",
    "failed",
)
OPEN_SESSION_STATUSES = ("queued", "requested", "accepted", "active")
ENDED_SESSION_STATUSES = ("completed", "cancelled", "failed")
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
    # A call ended because LiveKit could not confirm presence: our outage, not either side's.
    "service_unavailable",
    "admin",
)
REVIEW_STATUSES = ("published", "flagged", "hidden")
DEFAULT_FLAGS = {"chat_enabled": True, "call_enabled": False, "show_in_directory": True}


# Phone of a deleted account (docs/api/trust.md §2): `deleted:{HMAC(phone)}:{user id}`.
TOMBSTONE_PREFIX = "deleted:"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    phone: Mapped[str] = mapped_column(CITEXT, unique=True)  # E.164
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_login_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    locale: Mapped[str] = mapped_column(Text, default="en", server_default="en")
    is_adult_confirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    device_ids: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    roles: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True)  # sha256 of the token
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    device_id: Mapped[str | None] = mapped_column(Text)


class SavedKundli(Base):
    __tablename__ = "saved_kundlis"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(Text)
    gender: Mapped[str | None] = mapped_column(Enum(*GENDERS, name="gender"))
    birth_date: Mapped[dt.date] = mapped_column(Date)
    birth_time: Mapped[dt.time | None] = mapped_column(Time)
    unknown_time: Mapped[bool] = mapped_column(Boolean)
    birth_datetime_utc: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    tz: Mapped[str] = mapped_column(Text)
    utc_offset: Mapped[str] = mapped_column(Text)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    place_label: Mapped[str | None] = mapped_column(Text)
    city_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class HoroscopeEntry(Base):
    __tablename__ = "horoscope_entries"
    __table_args__ = (UniqueConstraint("period", "sign", "ist_date", "locale"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    period: Mapped[str] = mapped_column(Enum(*PERIODS, name="horoscope_period"))
    sign: Mapped[str] = mapped_column(Text)
    ist_date: Mapped[dt.date] = mapped_column(Date)  # window start (IST)
    ist_date_end: Mapped[dt.date] = mapped_column(Date)  # window end (IST), inclusive
    locale: Mapped[str] = mapped_column(Text)
    sections: Mapped[dict[str, str]] = mapped_column(JSONB)
    scores: Mapped[dict[str, Any]] = mapped_column(JSONB)
    lucky: Mapped[dict[str, Any]] = mapped_column(JSONB)
    facts: Mapped[dict[str, Any]] = mapped_column(JSONB)
    model: Mapped[str] = mapped_column(Text)
    prompt_version: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        Enum(*HOROSCOPE_STATUSES, name="horoscope_status"), default="pending_review"
    )
    reviewed_by: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    actor: Mapped[str] = mapped_column(Text)
    action: Mapped[str] = mapped_column(Text)
    entity: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class Astrologer(Base):
    __tablename__ = "astrologers"
    __table_args__ = (
        CheckConstraint("price_per_min_paise IS NULL OR price_per_min_paise > 0", name="price_pos"),
        CheckConstraint("requested_price_per_min_paise > 0", name="requested_price_pos"),
        CheckConstraint("experience_years BETWEEN 0 AND 80", name="experience_range"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    display_name: Mapped[str] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    bio: Mapped[str] = mapped_column(Text)
    bio_hi: Mapped[str | None] = mapped_column(Text)
    skills: Mapped[list[str]] = mapped_column(ARRAY(Text))
    languages: Mapped[list[str]] = mapped_column(ARRAY(Text))
    gender: Mapped[str] = mapped_column(Enum(*GENDERS, name="gender"))
    tier: Mapped[str | None] = mapped_column(Text)
    price_per_min_paise: Mapped[int | None] = mapped_column(BigInteger)
    requested_price_per_min_paise: Mapped[int] = mapped_column(BigInteger)
    experience_years: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        Enum(*ASTROLOGER_STATUSES, name="astrologer_status"), default="applied"
    )
    status_before_suspension: Mapped[str | None] = mapped_column(Text)
    probation_until: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    flags: Mapped[dict[str, Any]] = mapped_column(JSONB, default=lambda: dict(DEFAULT_FLAGS))
    is_seed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    accepts_terms_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=_now
    )
    approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    suspended_reason: Mapped[str | None] = mapped_column(Text)
    rejected_reason: Mapped[str | None] = mapped_column(Text)


class AstrologerVerification(Base):
    __tablename__ = "astrologer_verifications"
    __table_args__ = (UniqueConstraint("astrologer_id", "step"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE"), index=True
    )
    step: Mapped[str] = mapped_column(Enum(*VERIFICATION_STEPS, name="verification_step"))
    status: Mapped[str] = mapped_column(
        Enum(*VERIFICATION_STATUSES, name="verification_status"), default="pending"
    )
    reviewer_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    note: Mapped[str | None] = mapped_column(Text)
    at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class KycDocument(Base):
    __tablename__ = "kyc_documents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(Enum(*DOCUMENT_KINDS, name="document_kind"))
    filename: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(Text)
    storage_key: Mapped[str] = mapped_column(Text, unique=True)
    uploaded_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    review_status: Mapped[str] = mapped_column(
        Enum(*DOCUMENT_REVIEW, name="document_review_status"), default="pending"
    )


class ConsultSession(Base):
    """A consultation (chat or call). State machine and metering: session_service.py, ADR-0007.

    Money facts (`price_per_min_paise`, `commission_bps`) are captured at creation so later price
    or rate changes never reprice a session. `billed_minutes` is the highest minute posted to the
    ledger (`session:{id}:minute:{n}`), updated in the same transaction as the charge; the next
    minute is due at `started_at + billed_minutes * minute`.
    """

    __tablename__ = "consult_sessions"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_consult_sessions_user_idem"),
        CheckConstraint("price_per_min_paise >= 0", name="session_price_nonneg"),
        CheckConstraint("commission_bps BETWEEN 0 AND 10000", name="session_commission_range"),
        CheckConstraint("billed_minutes >= 0 AND billed_paise >= 0", name="session_billed_nonneg"),
        CheckConstraint("last_seq >= 0", name="session_last_seq_nonneg"),
        CheckConstraint(
            "end_reason IS NULL OR end_reason IN ("
            + ", ".join(f"'{r}'" for r in END_REASONS)
            + ")",
            name="session_end_reason_known",
        ),
        # At most one open session per user (the API checks first; this is the backstop).
        Index(
            "uq_consult_sessions_one_open_per_user",
            "user_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'requested', 'accepted', 'active')"),
        ),
        Index("ix_consult_sessions_status_astrologer", "status", "astrologer_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(Enum(*SESSION_KINDS, name="session_kind"))
    status: Mapped[str] = mapped_column(
        Enum(*SESSION_STATUSES, name="session_status"), default="requested"
    )
    end_reason: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    # Queue order (set while queued); the request-timeout clock starts at requested_at.
    queued_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    requested_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    price_per_min_paise: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    commission_bps: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_free: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    free_minutes: Mapped[int | None] = mapped_column(Integer)
    billed_minutes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    billed_paise: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    request_hash: Mapped[str | None] = mapped_column(Text)
    # Highest chat message seq (system messages included).
    last_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Last time each side was seen while active (copied from Redis heartbeats by the meter).
    user_last_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    astrologer_last_seen_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # Set once the after-end steps (refund rules, presence, queue promotion) have run.
    settled_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class Review(Base):
    __tablename__ = "reviews"
    __table_args__ = (CheckConstraint("rating BETWEEN 1 AND 5", name="rating_range"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("consult_sessions.id", ondelete="CASCADE"), unique=True
    )
    astrologer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("astrologers.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    rating: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(Enum(*REVIEW_STATUSES, name="review_status"))
    reply_text: Mapped[str | None] = mapped_column(Text)
    reply_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    report_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Set when the text failed automatic moderation at creation: the review is held (not public)
    # until a moderator acts. Reported reviews are flagged too but stay visible meanwhile.
    auto_flag_reason: Mapped[str | None] = mapped_column(Text)
    moderation_note: Mapped[str | None] = mapped_column(Text)
    moderated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    moderated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# The other tables live in their own modules; importing them here registers them on Base.metadata.
from astro_api import (  # noqa: E402, F401
    models_ai,
    models_jobs,
    models_ledger,
    models_portal,
    models_privacy,
    models_remedies,
    models_reports,
    models_safety,
    models_sessions,
)
