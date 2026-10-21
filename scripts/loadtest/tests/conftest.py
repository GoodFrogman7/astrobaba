"""Load-test tool tests. The seed-credit tests need Postgres (DATABASE_URL); they create their
own users and never truncate, so they are safe on a development database."""

import os
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

os.environ.setdefault("APP_ENV", "test")

API_DIR = Path(__file__).resolve().parents[3] / "services" / "api"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("DATABASE_URL"):
        return
    skip = pytest.mark.skip(reason="DATABASE_URL not set")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def migrated() -> None:
    # LOADTEST_ALEMBIC_TARGET pins a revision (e.g. while later migrations are in progress).
    target = os.environ.get("LOADTEST_ALEMBIC_TARGET", "head")
    argv = [sys.executable, "-m", "alembic", "upgrade", target]
    subprocess.run(argv, cwd=API_DIR, check=True)  # noqa: S603 - our interpreter, a revision id


@pytest.fixture
async def sessionmaker(migrated: None) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    from astro_api.db import make_engine, make_sessionmaker

    engine = make_engine(os.environ["DATABASE_URL"])
    try:
        yield make_sessionmaker(engine)
    finally:
        await engine.dispose()
