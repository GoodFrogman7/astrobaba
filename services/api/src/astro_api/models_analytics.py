"""Analytics events table (docs/api/growth.md §1.2, migration 0014, ADR-0013).

Pseudonymous product events from the closed schema in packages/shared/analytics/events.json.
No column holds an IP, a user agent or free text; `properties` only ever holds values that
passed `validate_event`. Rows are purged after `ANALYTICS_RETENTION_DAYS`
(`python -m astro_api.cli analytics-purge`) and deleted with the account (privacy.py).
"""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base


class AnalyticsEvent(Base):
    __tablename__ = "analytics_events"
    __table_args__ = (
        Index("ix_analytics_events_anonymous_id_occurred_at", "anonymous_id", "occurred_at"),
        Index("ix_analytics_events_event_occurred_at", "event", "occurred_at"),
        Index("ix_analytics_events_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    event: Mapped[str] = mapped_column(Text)
    # The client's `ts`, or the receive time when `ts` is more than 24 h off.
    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    anonymous_id: Mapped[str] = mapped_column(Text)
    # Only ever from the bearer token of the forwarding request, never from the envelope.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    locale: Mapped[str] = mapped_column(Text)
    properties: Mapped[dict[str, Any]] = mapped_column(JSONB)
