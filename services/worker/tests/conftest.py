import asyncio
import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

os.environ.setdefault("APP_ENV", "test")

API_DIR = Path(__file__).resolve().parents[2] / "api"
FACTS_FILE = API_DIR / "tests" / "fixtures" / "facts_aries_daily.json"
TABLES = ("audit_log", "horoscope_entries", "saved_kundlis", "auth_sessions", "users")


def load_facts(sign: str = "aries") -> dict[str, Any]:
    facts: dict[str, Any] = json.loads(FACTS_FILE.read_text())
    facts["sign"] = sign
    return facts


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("DATABASE_URL"):
        return
    skip = pytest.mark.skip(reason="DATABASE_URL not set")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def migrated() -> None:
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=API_DIR, check=True)


async def _truncate(url: str) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
    await engine.dispose()


@pytest.fixture
def db_url(migrated: None) -> Iterator[str]:
    url = os.environ["DATABASE_URL"]
    asyncio.run(_truncate(url))
    yield url


# Test modules cannot import this conftest (two services each have a tests/ folder), so shared
# helpers are handed out as fixtures.
@pytest.fixture
def facts() -> dict[str, Any]:
    return load_facts()


@pytest.fixture
def generate_run(db_url: str) -> Any:
    import datetime as dt

    import httpx

    from astro_api.db import make_engine, make_sessionmaker
    from astro_worker.config import WorkerSettings
    from astro_worker.horoscopes import Report, generate
    from astro_worker.llm import FakeProvider

    def astro(status: int) -> httpx.AsyncClient:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/horoscope/facts"
            p = request.url.params
            assert p["period"] == "daily" and p["date"] == "2026-10-22"
            return httpx.Response(status, json=load_facts(p["sign"]))

        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def _run(force: bool, status: int, signs: tuple[str, ...]) -> Report:
        engine = make_engine(db_url)
        try:
            return await generate(
                period="daily",
                day=dt.date(2026, 10, 22),
                signs=list(signs),
                locales=["en", "hi"],
                force=force,
                provider=FakeProvider(WorkerSettings(app_env="test")),
                http=astro(status),
                astro_url="http://astro.test",
                sessionmaker=make_sessionmaker(engine),
            )
        finally:
            await engine.dispose()

    def run(
        *, force: bool = False, status: int = 200, signs: tuple[str, ...] = ("aries", "leo")
    ) -> Report:
        return asyncio.run(_run(force, status, signs))

    return run


@pytest.fixture
def db_query(db_url: str) -> Any:
    from astro_api.db import make_engine, make_sessionmaker

    async def _q(fn: Any) -> Any:
        engine = make_engine(db_url)
        maker = make_sessionmaker(engine)
        try:
            async with maker() as s:
                return await fn(s, maker)
        finally:
            await engine.dispose()

    return lambda fn: asyncio.run(_q(fn))
