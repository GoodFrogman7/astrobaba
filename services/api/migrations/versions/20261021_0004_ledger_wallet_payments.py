"""Ledger, wallet, promo lots, payment orders and webhooks (wallet work).

Append-only ledger: a trigger rejects UPDATE/DELETE on ledger_transactions and ledger_entries;
a deferred constraint trigger checks at commit that each transaction has entries and that its
debits equal its credits (ADR-0002 §1).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TXN_KINDS = (
    "recharge",
    "recharge_bonus",
    "consultation",
    "refund",
    "free_session_grant",
    "promo_grant",
    "promo_expiry",
    "settlement",
    "adjustment",
)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _ts(name: str, *, now: str | None = None, nullable: bool = True) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=sa.text(now) if now else None,
        nullable=nullable,
    )


def _uuid(name: str, *, nullable: bool = True, **kw: object) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(name, pg.UUID(as_uuid=True), nullable=nullable, **kw)  # type: ignore[arg-type]


REJECT_MUTATION = """
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables are append-only (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
"""

CHECK_BALANCED = """
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tid uuid;
  n integer;
  debits bigint;
  credits bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    tid := NEW.transaction_id;
  ELSE
    tid := NEW.id;
  END IF;
  SELECT count(*),
         coalesce(sum(amount_paise) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount_paise) FILTER (WHERE direction = 'credit'), 0)
    INTO n, debits, credits
    FROM ledger_entries WHERE transaction_id = tid;
  IF n = 0 THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', tid USING ERRCODE = 'check_violation';
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: debits % <> credits %',
      tid, debits, credits USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
"""


def upgrade() -> None:
    op.create_table(
        "ledger_transactions",
        _uuid("id", nullable=False, primary_key=True),
        sa.Column("seq", sa.BigInteger, sa.Identity(), nullable=False, unique=True),
        sa.Column("idempotency_key", sa.Text, nullable=False, unique=True),
        sa.Column("payload_hash", sa.Text, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        _uuid("session_id"),
        _uuid("astrologer_id"),
        sa.Column("external_ref", sa.Text, nullable=True),
        sa.Column(
            "reverses_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("ledger_transactions.id"),
            nullable=True,
        ),
        _ts("occurred_at", now="now()", nullable=False),
        _ts("created_at", now="clock_timestamp()", nullable=False),
        sa.CheckConstraint(_in("kind", TXN_KINDS), name="kind_known"),
    )
    op.create_index("ix_ledger_transactions_user_seq", "ledger_transactions", ["user_id", "seq"])
    op.create_index("ix_ledger_transactions_session", "ledger_transactions", ["session_id"])
    op.create_index(
        "ix_ledger_transactions_kind_occurred", "ledger_transactions", ["kind", "occurred_at"]
    )
    op.create_index("ix_ledger_transactions_external_ref", "ledger_transactions", ["external_ref"])

    op.create_table(
        "promo_lots",
        _uuid("id", nullable=False, primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("campaign", sa.Text, nullable=False),
        sa.Column("amount_paise", sa.BigInteger, nullable=False),
        sa.Column("remaining_paise", sa.BigInteger, nullable=False),
        _ts("expires_at"),
        _uuid("session_id"),
        sa.Column(
            "source_transaction_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("ledger_transactions.id"),
            nullable=False,
            unique=True,
        ),
        _ts("created_at", now="now()", nullable=False),
        _ts("closed_at"),
        sa.CheckConstraint("amount_paise > 0", name="amount_positive"),
        sa.CheckConstraint(
            "remaining_paise >= 0 AND remaining_paise <= amount_paise", name="remaining_range"
        ),
    )
    op.create_index(
        "ix_promo_lots_user_open",
        "promo_lots",
        ["user_id", "expires_at"],
        postgresql_where=sa.text("remaining_paise > 0"),
    )
    op.create_index("ix_promo_lots_session", "promo_lots", ["session_id"])

    op.create_table(
        "ledger_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "transaction_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("ledger_transactions.id"),
            nullable=False,
        ),
        sa.Column("account_id", sa.Text, nullable=False),
        sa.Column("direction", sa.Text, nullable=False),
        sa.Column("amount_paise", sa.BigInteger, nullable=False),
        sa.Column(
            "promo_lot_id", pg.UUID(as_uuid=True), sa.ForeignKey("promo_lots.id"), nullable=True
        ),
        sa.CheckConstraint("amount_paise > 0", name="amount_positive"),
        sa.CheckConstraint("direction IN ('debit', 'credit')", name="direction_known"),
        sa.CheckConstraint(
            "account_id NOT LIKE 'user:%promo' OR promo_lot_id IS NOT NULL", name="promo_has_lot"
        ),
    )
    op.create_index("ix_ledger_entries_transaction_id", "ledger_entries", ["transaction_id"])
    op.create_index("ix_ledger_entries_account", "ledger_entries", ["account_id"])
    op.create_index("ix_ledger_entries_lot", "ledger_entries", ["promo_lot_id"])

    op.create_table(
        "account_balances",
        sa.Column("account_id", sa.Text, primary_key=True),
        sa.Column("normal_side", sa.Text, nullable=False),
        sa.Column("balance_paise", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("version", sa.BigInteger, nullable=False, server_default="0"),
        _ts("updated_at", now="now()", nullable=False),
        sa.CheckConstraint(
            "account_id NOT LIKE 'user:%' OR balance_paise >= 0", name="user_nonneg"
        ),
        sa.CheckConstraint("normal_side IN ('debit', 'credit')", name="normal_side_known"),
    )

    op.create_table(
        "recharge_orders",
        _uuid("id", nullable=False, primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("idempotency_key", sa.Text, nullable=False),
        sa.Column("amount_paise", sa.BigInteger, nullable=False),
        sa.Column("bonus_paise", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("currency", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="created"),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("provider_order_id", sa.Text, nullable=True, unique=True),
        sa.Column("provider_payment_id", sa.Text, nullable=True),
        sa.Column("checkout_payment_id", sa.Text, nullable=True),
        sa.Column("checkout_verified", sa.Boolean, nullable=True),
        _ts("checkout_at"),
        _ts("created_at", now="now()", nullable=False),
        _ts("paid_at"),
        _ts("failed_at"),
        sa.UniqueConstraint("user_id", "idempotency_key"),
        sa.CheckConstraint("amount_paise > 0", name="amount_positive"),
        sa.CheckConstraint("bonus_paise >= 0", name="bonus_nonneg"),
        sa.CheckConstraint("status IN ('created', 'paid', 'failed')", name="status_known"),
    )
    op.create_index("ix_recharge_orders_user_id", "recharge_orders", ["user_id"])

    op.create_table(
        "payment_events",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("event_id", sa.Text, nullable=False, unique=True),
        sa.Column("event_type", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("provider_order_id", sa.Text, nullable=True),
        sa.Column("provider_payment_id", sa.Text, nullable=True),
        sa.Column("amount_paise", sa.BigInteger, nullable=True),
        sa.Column("currency", sa.Text, nullable=True),
        sa.Column("payload", pg.JSONB, nullable=False),
        _ts("received_at", now="now()", nullable=False),
    )
    op.create_index("ix_payment_events_provider_order_id", "payment_events", ["provider_order_id"])

    op.create_table(
        "refunds",
        _uuid("id", nullable=False, primary_key=True),
        sa.Column(
            "transaction_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("ledger_transactions.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("rule", sa.Text, nullable=False),
        _uuid("session_id", nullable=False),
        sa.Column("user_id", pg.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        _uuid("astrologer_id"),
        sa.Column("amount_paise", sa.BigInteger, nullable=False),
        sa.Column("real_paise", sa.BigInteger, nullable=False),
        sa.Column("promo_paise", sa.BigInteger, nullable=False),
        sa.Column("commission_paise", sa.BigInteger, nullable=False),
        sa.Column("astrologer_paise", sa.BigInteger, nullable=False),
        sa.Column("actor", sa.Text, nullable=False),
        sa.Column("note", sa.Text, nullable=True),
        _ts("created_at", now="clock_timestamp()", nullable=False),
        sa.CheckConstraint("amount_paise > 0", name="amount_positive"),
    )
    op.create_index("ix_refunds_session_id", "refunds", ["session_id"])
    op.create_index("ix_refunds_user_rule_created", "refunds", ["user_id", "rule", "created_at"])
    op.create_index("ix_refunds_created", "refunds", ["created_at", "id"])

    op.create_table(
        "free_session_claims",
        _uuid("id", nullable=False, primary_key=True),
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        _uuid("session_id", nullable=False),
        sa.Column("device_hash", sa.Text, nullable=False),
        sa.Column("ip_hash", sa.Text, nullable=False),
        sa.Column("ip_day", sa.Date, nullable=False),
        sa.Column("abuse_score", sa.Integer, nullable=False, server_default="0"),
        sa.Column("reasons", pg.ARRAY(sa.Text), nullable=False, server_default="{}"),
        _ts("claimed_at", now="clock_timestamp()", nullable=False),
    )
    op.create_index("ix_free_session_claims_device_hash", "free_session_claims", ["device_hash"])
    op.create_index("ix_free_session_claims_ip_day", "free_session_claims", ["ip_hash", "ip_day"])

    op.create_table(
        "free_session_overrides",
        sa.Column(
            "user_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("action", sa.Text, nullable=True),
        sa.Column("resets", sa.Integer, nullable=False, server_default="0"),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("actor", sa.Text, nullable=False),
        _ts("updated_at", now="now()", nullable=False),
        sa.CheckConstraint("action IS NULL OR action IN ('allow', 'block')", name="action"),
    )

    op.create_table(
        "reconciliation_runs",
        _uuid("id", nullable=False, primary_key=True),
        sa.Column("run_date", sa.Date, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("drift_paise", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("checks", pg.JSONB, nullable=False, server_default="[]"),
        sa.Column("trigger", sa.Text, nullable=False),
        _ts("started_at", now="clock_timestamp()", nullable=False),
        _ts("finished_at"),
        sa.CheckConstraint("status IN ('running', 'ok', 'drift', 'error')", name="status_known"),
    )
    op.create_index("ix_reconciliation_runs_started", "reconciliation_runs", ["started_at"])

    op.execute(REJECT_MUTATION)
    op.execute(CHECK_BALANCED)
    for table in ("ledger_transactions", "ledger_entries"):
        op.execute(
            f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation()"
        )
        op.execute(
            f"CREATE CONSTRAINT TRIGGER {table}_balanced AFTER INSERT ON {table} "
            "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()"
        )


def downgrade() -> None:
    for table in (
        "reconciliation_runs",
        "free_session_overrides",
        "free_session_claims",
        "refunds",
        "payment_events",
        "recharge_orders",
        "account_balances",
        "ledger_entries",
        "promo_lots",
        "ledger_transactions",
    ):
        op.drop_table(table)
    op.execute("DROP FUNCTION IF EXISTS ledger_check_balanced()")
    op.execute("DROP FUNCTION IF EXISTS ledger_reject_mutation()")
