"""Tables (migration 0002). Birth details and phone numbers are personal data: never log them."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
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
