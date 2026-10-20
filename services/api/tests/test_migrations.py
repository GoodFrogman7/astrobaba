import subprocess
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]


@pytest.mark.integration
def test_migrations_upgrade_and_downgrade_cleanly() -> None:
    def alembic(*args: str) -> None:
        subprocess.run(  # noqa: S603 - fixed argv
            [sys.executable, "-m", "alembic", *args], cwd=API_DIR, check=True
        )

    alembic("upgrade", "head")
    alembic("downgrade", "base")
    alembic("upgrade", "head")
