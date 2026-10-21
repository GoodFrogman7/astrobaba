"""Astrologer invites and the content calendar (docs/api/growth.md §2, §4).

Relies only on `users` (0002) and `astrologers` (0003); nothing from 0014.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copies of the values in models_growth at the time of this migration.
CONTENT_KINDS = ("article", "horoscope", "tool_page", "social", "video", "other")
CONTENT_LOCALES = ("en", "hi", "both")
CONTENT_STATUSES = ("idea", "drafting", "review", "scheduled", "published")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    op.create_table(
        "astrologer_invites",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("code_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("note", sa.Text()),
        sa.Column(
            "created_by", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column(
            "used_by_astrologer_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("astrologers.id", ondelete="SET NULL"),
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("char_length(note) <= 200", name="invite_note_length"),
        sa.CheckConstraint("expires_at > created_at", name="invite_expiry_after_creation"),
    )
    op.create_index("ix_astrologer_invites_created", "astrologer_invites", ["created_at"])
    op.add_column(
        "astrologers",
        sa.Column(
            "invite_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey(
                "astrologer_invites.id", ondelete="SET NULL", name="astrologers_invite_id_fkey"
            ),
        ),
    )
    op.create_unique_constraint("astrologers_invite_id_key", "astrologers", ["invite_id"])

    op.create_table(
        "content_items",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("locale", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="idea"),
        sa.Column("due_date", sa.Date()),
        sa.Column("url", sa.Text()),
        sa.Column("notes", sa.Text()),
        sa.Column(
            "created_by", pg.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(_in("kind", CONTENT_KINDS), name="content_kind_known"),
        sa.CheckConstraint(_in("locale", CONTENT_LOCALES), name="content_locale_known"),
        sa.CheckConstraint(_in("status", CONTENT_STATUSES), name="content_status_known"),
        sa.CheckConstraint("char_length(title) BETWEEN 1 AND 160", name="content_title_length"),
        sa.CheckConstraint(
            "notes IS NULL OR char_length(notes) <= 1000", name="content_notes_length"
        ),
        sa.CheckConstraint(
            "status <> 'published' OR url IS NOT NULL", name="content_published_has_url"
        ),
    )
    op.create_index("ix_content_items_due", "content_items", ["due_date", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_content_items_due", table_name="content_items")
    op.drop_table("content_items")
    op.drop_constraint("astrologers_invite_id_key", "astrologers", type_="unique")
    op.drop_column("astrologers", "invite_id")
    op.drop_index("ix_astrologer_invites_created", table_name="astrologer_invites")
    op.drop_table("astrologer_invites")
