"""End reason `service_unavailable`: a call that LiveKit could not confirm (our outage), so it is
never recorded as the astrologer dropping (ADR-0008).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BEFORE = (
    "user_ended",
    "astrologer_ended",
    "insufficient_funds",
    "free_minutes_used",
    "user_cancelled",
    "astrologer_declined",
    "request_timeout",
    "join_timeout",
    "user_dropped",
    "astrologer_dropped",
    "admin",
)
AFTER = (*BEFORE[:-1], "service_unavailable", "admin")


def _constraint(reasons: tuple[str, ...]) -> None:
    op.drop_constraint("session_end_reason_known", "consult_sessions", type_="check")
    op.create_check_constraint(
        "session_end_reason_known",
        "consult_sessions",
        "end_reason IS NULL OR end_reason IN (" + ", ".join(f"'{r}'" for r in reasons) + ")",
    )


def upgrade() -> None:
    _constraint(AFTER)


def downgrade() -> None:
    op.execute(
        "UPDATE consult_sessions SET end_reason = 'astrologer_dropped' "
        "WHERE end_reason = 'service_unavailable'"
    )
    _constraint(BEFORE)
