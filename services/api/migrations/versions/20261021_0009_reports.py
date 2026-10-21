"""Paid reports: orders, reports, files (ADR-0009, docs/api/revenue.md §2).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-21
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SKUS = ("kundli_report", "matching_report")
LANGUAGES = ("en", "hi")
PAY_WITH = ("wallet", "razorpay")
ORDER_STATUSES = ("created", "paid", "failed")
REPORT_STATUSES = ("queued", "rendering", "ready", "failed")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def _ts(name: str, *, now: bool = False) -> sa.Column[Any]:
    if now:
        return sa.Column(
            name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        )
    return sa.Column(name, sa.DateTime(timezone=True))


def upgrade() -> None:
    op.create_table(
        "report_orders",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("sku", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("kundli_ids", pg.ARRAY(pg.UUID(as_uuid=True)), nullable=False),
        sa.Column("pay_with", sa.Text(), nullable=False),
        sa.Column("price_paise", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text()),
        sa.Column("provider_order_id", sa.Text(), unique=True),
        sa.Column("provider_payment_id", sa.Text()),
        sa.Column("snapshot", pg.JSONB()),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("email_ciphertext", sa.LargeBinary()),
        sa.Column("email_nonce", sa.LargeBinary()),
        sa.Column("email_key_id", sa.Text()),
        sa.Column("checkout_payment_id", sa.Text()),
        sa.Column("checkout_verified", sa.Boolean()),
        _ts("checkout_at"),
        sa.Column("report_id", pg.UUID(as_uuid=True), unique=True),
        _ts("created_at", now=True),
        _ts("paid_at"),
        _ts("failed_at"),
        sa.UniqueConstraint("user_id", "idempotency_key"),
        sa.CheckConstraint("price_paise > 0", name="report_order_price_positive"),
        sa.CheckConstraint(_in("sku", SKUS), name="report_order_sku_known"),
        sa.CheckConstraint(_in("language", LANGUAGES), name="report_order_language_known"),
        sa.CheckConstraint(_in("pay_with", PAY_WITH), name="report_order_pay_with_known"),
        sa.CheckConstraint(_in("status", ORDER_STATUSES), name="report_order_status_known"),
    )
    op.create_index("ix_report_orders_user_id", "report_orders", ["user_id"])
    op.create_table(
        "reports",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column(
            "order_id", pg.UUID(as_uuid=True), sa.ForeignKey("report_orders.id"), unique=True
        ),
        sa.Column("sample_key", sa.Text(), unique=True),
        sa.Column("sku", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("snapshot", pg.JSONB(), nullable=False),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text()),
        sa.Column("pages", sa.Integer()),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("render_n", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("render_job_key", sa.Text(), nullable=False),
        sa.Column("last_error_code", sa.Text()),
        _ts("created_at", now=True),
        _ts("ready_at"),
        _ts("failed_at"),
        _ts("refunded_at"),
        _ts("emailed_at"),
        sa.CheckConstraint(_in("sku", SKUS), name="report_sku_known"),
        sa.CheckConstraint(_in("language", LANGUAGES), name="report_language_known"),
        sa.CheckConstraint(_in("status", REPORT_STATUSES), name="report_status_known"),
        sa.CheckConstraint(
            "(sample_key IS NULL) = (user_id IS NOT NULL) "
            "AND (sample_key IS NULL) = (order_id IS NOT NULL)",
            name="report_owner_or_sample",
        ),
        sa.CheckConstraint("render_n >= 0", name="report_render_n_nonneg"),
    )
    op.create_index("ix_reports_user_id", "reports", ["user_id"])
    op.create_index("ix_reports_status_created", "reports", ["status", "created_at"])


def downgrade() -> None:
    op.drop_table("reports")
    op.drop_table("report_orders")
