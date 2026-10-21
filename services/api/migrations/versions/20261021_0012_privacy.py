"""Consents, data exports and deletion requests (privacy work, ADR-0011).

`consents` is append-only: a trigger rejects UPDATE and DELETE (TRUNCATE in tests is not a row
operation and is unaffected). The jobs kind CHECK gains `data_export` and `account_cleanup`.

Only `users` (0002) and `jobs` (0008) are relied on.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONSENT_KINDS = ("age_18", "terms", "privacy", "astrologer_terms")
EXPORT_STATUSES = ("queued", "ready", "failed", "expired")
DELETION_STATUSES = ("requested", "cancelled", "executed")
JOB_KINDS_BEFORE = ("report_render", "ai_answer", "remedy_lead_notify", "report_email")
JOB_KINDS_NEW = ("data_export", "account_cleanup")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def _user_fk() -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        "user_id",
        pg.UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )


def upgrade() -> None:
    op.create_table(
        "consents",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _user_fk(),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.Column("ip_hash", sa.Text()),
        sa.Column("device_hash", sa.Text()),
        sa.CheckConstraint(_in("kind", CONSENT_KINDS), name="consent_kind_known"),
        sa.UniqueConstraint("user_id", "kind", "version", name="uq_consents_user_kind_version"),
    )
    op.create_index("ix_consents_user_id", "consents", ["user_id"])
    op.execute(
        """
CREATE FUNCTION consents_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consents are append-only (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
"""
    )
    op.execute(
        "CREATE TRIGGER consents_append_only BEFORE UPDATE OR DELETE ON consents "
        "FOR EACH ROW EXECUTE FUNCTION consents_reject_mutation()"
    )

    op.create_table(
        "data_exports",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _user_fk(),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("storage_key", sa.Text(), unique=True),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("last_error_code", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.Column("ready_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(_in("status", EXPORT_STATUSES), name="data_export_status_known"),
        sa.CheckConstraint(
            "status <> 'ready' OR (storage_key IS NOT NULL AND expires_at IS NOT NULL)",
            name="data_export_ready_has_file",
        ),
    )
    op.create_index("ix_data_exports_user_created", "data_exports", ["user_id", "created_at"])

    op.create_table(
        "deletion_requests",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        _user_fk(),
        sa.Column("status", sa.Text(), nullable=False, server_default="requested"),
        sa.Column(
            "requested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.Column("executed_at", sa.DateTime(timezone=True)),
        sa.Column("executed_by", sa.Text()),
        sa.Column("pending_files", pg.JSONB(), nullable=False, server_default="[]"),
        sa.Column("files_cleaned_at", sa.DateTime(timezone=True)),
        sa.Column("kyc_review_required", sa.Boolean(), nullable=False, server_default="false"),
        sa.CheckConstraint(_in("status", DELETION_STATUSES), name="deletion_status_known"),
        sa.CheckConstraint(
            "status <> 'executed' OR (executed_at IS NOT NULL AND executed_by IS NOT NULL)",
            name="deletion_executed_complete",
        ),
    )
    op.create_index(
        "uq_deletion_requests_one_open",
        "deletion_requests",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'requested'"),
    )
    op.create_index(
        "ix_deletion_requests_status_requested", "deletion_requests", ["status", "requested_at"]
    )

    op.drop_constraint("job_kind_known", "jobs", type_="check")
    op.create_check_constraint(
        "job_kind_known", "jobs", _in("kind", (*JOB_KINDS_BEFORE, *JOB_KINDS_NEW))
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM jobs WHERE " + _in("kind", JOB_KINDS_NEW)  # noqa: S608 - fixed values
    )
    op.drop_constraint("job_kind_known", "jobs", type_="check")
    op.create_check_constraint("job_kind_known", "jobs", _in("kind", JOB_KINDS_BEFORE))
    op.drop_table("deletion_requests")
    op.drop_table("data_exports")
    op.drop_table("consents")
    op.execute("DROP FUNCTION IF EXISTS consents_reject_mutation()")
