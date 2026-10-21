"""Tables (migrations 0002, 0003). Birth details, phone numbers and KYC documents are personal
data: never log them."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    Time,
    UniqueConstraint,
    func,
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
SESSION_STATUSES = ("requested", "active", "completed", "cancelled", "failed")
REVIEW_STATUSES = ("published", "flagged", "hidden")
DEFAULT_FLAGS = {"chat_enabled": True, "call_enabled": False, "show_in_directory": True}


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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
    """Minimal consultation record (Phase 3: reviews need a completed session). Phase 4 adds
    billing and chat."""

    __tablename__ = "consult_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Review(Base):
    __tablename__ = "reviews"
    __table_args__ = (CheckConstraint("rating BETWEEN 1 AND 5", name="rating_range"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
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
