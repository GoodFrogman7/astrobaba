"""Safety events, astrologer reports, moderation and strikes (safety work).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-21
"""

from collections.abc import Sequence

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
