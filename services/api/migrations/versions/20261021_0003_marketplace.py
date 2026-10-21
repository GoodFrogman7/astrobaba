"""Marketplace: user roles, astrologers, verification steps, KYC documents, consult sessions,
reviews.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

gender = pg.ENUM("female", "male", "other", name="gender", create_type=False)
astrologer_status = pg.ENUM(
    "applied",
    "kyc_submitted",
    "interview",
    "probation",
    "approved",
    "suspended",
    "rejected",
    name="astrologer_status",
    create_type=False,
)
verification_step = pg.ENUM(
    "identity",
    "qualification",
    "interview",
    "probation",
    name="verification_step",
    create_type=False,
)
verification_status = pg.ENUM(
    "pending", "passed", "failed", name="verification_status", create_type=False
)
document_kind = pg.ENUM(
    "identity", "qualification", "other", name="document_kind", create_type=False
)
document_review = pg.ENUM(
    "pending", "accepted", "rejected", name="document_review_status", create_type=False
)
session_kind = pg.ENUM("chat", "call", name="session_kind", create_type=False)
session_status = pg.ENUM(
    "requested",
    "active",
    "completed",
    "cancelled",
    "failed",
    name="session_status",
    create_type=False,
)
review_status = pg.ENUM("published", "flagged", "hidden", name="review_status", create_type=False)
NEW_ENUMS = (
    astrologer_status,
    verification_step,
    verification_status,
    document_kind,
    document_review,
    session_kind,
    session_status,
    review_status,
)


def _ts(name: str, *, now: bool = False, nullable: bool = True) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=sa.func.now() if now else None,
        nullable=nullable,
    )


def _fk(name: str, table: str, *, nullable: bool = False, ondelete: str = "CASCADE") -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        name,
        pg.UUID(as_uuid=True),
        sa.ForeignKey(f"{table}.id", ondelete=ondelete),
        nullable=nullable,
    )


def upgrade() -> None:
    bind = op.get_bind()
    for enum in NEW_ENUMS:
        enum.create(bind, checkfirst=True)

    op.add_column(
        "users", sa.Column("roles", pg.ARRAY(sa.Text()), server_default="{}", nullable=False)
    )

    op.create_table(
        "astrologers",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _fk("user_id", "users"),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("bio", sa.Text(), nullable=False),
        sa.Column("bio_hi", sa.Text()),
        sa.Column("skills", pg.ARRAY(sa.Text()), nullable=False),
        sa.Column("languages", pg.ARRAY(sa.Text()), nullable=False),
        sa.Column("gender", gender, nullable=False),
        sa.Column("tier", sa.Text()),
        sa.Column("price_per_min_paise", sa.BigInteger()),
        sa.Column("requested_price_per_min_paise", sa.BigInteger(), nullable=False),
        sa.Column("experience_years", sa.Integer(), nullable=False),
        sa.Column("status", astrologer_status, nullable=False, server_default="applied"),
        sa.Column("status_before_suspension", sa.Text()),
        _ts("probation_until"),
        sa.Column(
            "flags",
            pg.JSONB(),
            nullable=False,
            server_default=sa.text(
                '\'{"chat_enabled": true, "call_enabled": false, '
                '"show_in_directory": true}\'::jsonb'
            ),
        ),
        sa.Column("is_seed", sa.Boolean(), server_default=sa.false(), nullable=False),
        _ts("accepts_terms_at", nullable=False),
        _ts("created_at", now=True, nullable=False),
        _ts("updated_at", now=True, nullable=False),
        _ts("approved_at"),
        sa.Column("suspended_reason", sa.Text()),
        sa.Column("rejected_reason", sa.Text()),
        sa.UniqueConstraint("user_id", name="astrologers_user_id_key"),
        sa.CheckConstraint(
            "price_per_min_paise IS NULL OR price_per_min_paise > 0", name="price_pos"
        ),
        sa.CheckConstraint("requested_price_per_min_paise > 0", name="requested_price_pos"),
        sa.CheckConstraint("experience_years BETWEEN 0 AND 80", name="experience_range"),
    )
    op.create_index("ix_astrologers_status", "astrologers", ["status"])
    op.create_index("ix_astrologers_tier", "astrologers", ["tier"])
    op.create_index("ix_astrologers_price", "astrologers", ["price_per_min_paise"])
    op.create_index("ix_astrologers_skills", "astrologers", ["skills"], postgresql_using="gin")
    op.create_index(
        "ix_astrologers_languages", "astrologers", ["languages"], postgresql_using="gin"
    )

    op.create_table(
        "astrologer_verifications",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        _fk("astrologer_id", "astrologers"),
        sa.Column("step", verification_step, nullable=False),
        sa.Column("status", verification_status, nullable=False, server_default="pending"),
        _fk("reviewer_user_id", "users", nullable=True, ondelete="SET NULL"),
        sa.Column("note", sa.Text()),
        _ts("at"),
        sa.UniqueConstraint("astrologer_id", "step"),
    )
    op.create_index(
        "ix_astrologer_verifications_astrologer_id", "astrologer_verifications", ["astrologer_id"]
    )

    op.create_table(
        "kyc_documents",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _fk("astrologer_id", "astrologers"),
        sa.Column("kind", document_kind, nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=False, unique=True),
        _ts("uploaded_at", now=True, nullable=False),
        sa.Column("review_status", document_review, nullable=False, server_default="pending"),
    )
    op.create_index("ix_kyc_documents_astrologer_id", "kyc_documents", ["astrologer_id"])

    op.create_table(
        "consult_sessions",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _fk("user_id", "users"),
        _fk("astrologer_id", "astrologers"),
        sa.Column("kind", session_kind, nullable=False),
        sa.Column("status", session_status, nullable=False, server_default="requested"),
        _ts("started_at"),
        _ts("ended_at"),
        _ts("created_at", now=True, nullable=False),
    )
    op.create_index("ix_consult_sessions_user_id", "consult_sessions", ["user_id"])
    op.create_index("ix_consult_sessions_astrologer_id", "consult_sessions", ["astrologer_id"])

    op.create_table(
        "reviews",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _fk("session_id", "consult_sessions"),
        _fk("astrologer_id", "astrologers"),
        _fk("user_id", "users"),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", review_status, nullable=False),
        sa.Column("reply_text", sa.Text()),
        _ts("reply_at"),
        sa.Column("report_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("auto_flag_reason", sa.Text()),
        sa.Column("moderation_note", sa.Text()),
        _fk("moderated_by", "users", nullable=True, ondelete="SET NULL"),
        _ts("moderated_at"),
        _ts("created_at", now=True, nullable=False),
        sa.UniqueConstraint("session_id", name="reviews_session_id_key"),
        sa.CheckConstraint("rating BETWEEN 1 AND 5", name="rating_range"),
    )
    op.create_index("ix_reviews_astrologer_id", "reviews", ["astrologer_id"])
    op.create_index("ix_reviews_user_id", "reviews", ["user_id"])
    op.create_index("ix_reviews_status", "reviews", ["status"])


def downgrade() -> None:
    for table in (
        "reviews",
        "consult_sessions",
        "kyc_documents",
        "astrologer_verifications",
        "astrologers",
    ):
        op.drop_table(table)
    op.drop_column("users", "roles")
    bind = op.get_bind()
    for enum in reversed(NEW_ENUMS):
        enum.drop(bind, checkfirst=True)
