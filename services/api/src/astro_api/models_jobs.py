"""Background jobs (migration 0008). Payloads hold ids only, never personal data."""

import datetime as dt
import uuid
from typing import Any
from uuid import uuid4

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

JOB_KINDS = (
    "report_render",
    "ai_answer",
    "remedy_lead_notify",
    "report_email",
    # Privacy (migration 0012): build a data export; remove files after deletion or expiry.
    "data_export",
    "account_cleanup",
)
JOB_STATUSES = ("queued", "running", "done", "failed")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(_in("kind", JOB_KINDS), name="job_kind_known"),
        CheckConstraint(_in("status", JOB_STATUSES), name="job_status_known"),
        CheckConstraint("attempts >= 0", name="job_attempts_nonneg"),
        Index("ix_jobs_due", "status", "run_after"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(Text)
    # Enqueueing is idempotent on this key (e.g. "report:{id}:render").
    key: Mapped[str] = mapped_column(Text, unique=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text, default="queued", server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    run_after: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    locked_until: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
