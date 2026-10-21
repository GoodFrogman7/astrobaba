"""Astrologer invites and the content calendar (docs/api/growth.md §2, §4).

Relies only on `users` (0002) and `astrologers` (0003); nothing from 0014.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-21
"""

from collections.abc import Sequence

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
