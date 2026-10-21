"""Paid kundli and matching reports: orders, snapshots, files (migration 0009, ADR-0009).

`report_orders` is the purchase (wallet or Razorpay); `reports` is what was bought: a frozen
snapshot of engine outputs plus the rendered PDF's storage key. Samples are reports with no
owner (`user_id` NULL) and a `sample_key`. Birth details live only inside `snapshot` (and the
user's own saved kundlis); the optional email is stored encrypted and erased once used.
"""

import datetime as dt
import uuid
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
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
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

REPORT_SKUS = ("kundli_report", "matching_report")
REPORT_LANGUAGES = ("en", "hi")
PAY_WITH = ("wallet", "razorpay")
ORDER_STATUSES = ("created", "paid", "failed")
REPORT_STATUSES = ("queued", "rendering", "ready", "failed")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


class ReportOrder(Base):
    __tablename__ = "report_orders"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key"),
        CheckConstraint("price_paise > 0", name="report_order_price_positive"),
        CheckConstraint(_in("sku", REPORT_SKUS), name="report_order_sku_known"),
        CheckConstraint(_in("language", REPORT_LANGUAGES), name="report_order_language_known"),
        CheckConstraint(_in("pay_with", PAY_WITH), name="report_order_pay_with_known"),
        CheckConstraint(_in("status", ORDER_STATUSES), name="report_order_status_known"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(Text)
    sku: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(Text)
    # The saved kundlis the snapshot was built from (no FK: a user may delete a kundli later).
    kundli_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(UUID(as_uuid=True)))
    pay_with: Mapped[str] = mapped_column(Text)
    price_paise: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="created")
    provider: Mapped[str | None] = mapped_column(Text)
    provider_order_id: Mapped[str | None] = mapped_column(Text, unique=True)
    provider_payment_id: Mapped[str | None] = mapped_column(Text)
    # Built when the order is created (so payment never waits on the engine); moved to the
    # report when it is paid and cleared here.
    snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    engine_version: Mapped[str] = mapped_column(Text)
    # Optional email for the "report ready" message: AES-256-GCM (chat key), AAD
    # `report_order:{id}:email`; erased once sent (or once it can no longer be sent).
    email_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)
    email_nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    email_key_id: Mapped[str | None] = mapped_column(Text)
    # Razorpay Checkout handler result: verified and recorded, never credited (webhook only).
    checkout_payment_id: Mapped[str | None] = mapped_column(Text)
    checkout_verified: Mapped[bool | None] = mapped_column(Boolean)
    checkout_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    report_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    paid_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        CheckConstraint(_in("sku", REPORT_SKUS), name="report_sku_known"),
        CheckConstraint(_in("language", REPORT_LANGUAGES), name="report_language_known"),
        CheckConstraint(_in("status", REPORT_STATUSES), name="report_status_known"),
        # A report is either bought (owner and order) or a public sample (neither).
        CheckConstraint(
            "(sample_key IS NULL) = (user_id IS NOT NULL) "
            "AND (sample_key IS NULL) = (order_id IS NOT NULL)",
            name="report_owner_or_sample",
        ),
        CheckConstraint("render_n >= 0", name="report_render_n_nonneg"),
        Index("ix_reports_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    order_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("report_orders.id"), unique=True)
    sample_key: Mapped[str | None] = mapped_column(Text, unique=True)
    sku: Mapped[str] = mapped_column(Text)
    language: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="queued")
    # Engine outputs exactly as returned (RenderData.snapshot). Never changes.
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)
    engine_version: Mapped[str] = mapped_column(Text)
    storage_key: Mapped[str | None] = mapped_column(Text)
    pages: Mapped[int | None] = mapped_column(Integer)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    # Render generation: 0 for the first job (`report:{id}:render`), n for an admin retry
    # (`report:{id}:render:{n}`). `render_job_key` names the current job.
    render_n: Mapped[int] = mapped_column(Integer, default=0)
    render_job_key: Mapped[str] = mapped_column(Text)
    last_error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    ready_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    emailed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
