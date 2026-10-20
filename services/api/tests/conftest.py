import asyncio
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

# Unit tests must not need real services; integration tests opt in via the marker.
os.environ.setdefault("APP_ENV", "test")

API_DIR = Path(__file__).resolve().parents[1]
TABLES = ("audit_log", "horoscope_entries", "saved_kundlis", "auth_sessions", "users")
ADMIN_TOKEN = "test-admin-token-0123456789abcdef"


def services_available() -> bool:
    return bool(os.environ.get("DATABASE_URL")) and bool(os.environ.get("REDIS_URL"))


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if services_available():
        return
    skip = pytest.mark.skip(reason="DATABASE_URL/REDIS_URL not set")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


def _test_redis_url() -> str:
    """Integration tests use Redis database 15 so they never touch development data."""
    base = os.environ["REDIS_URL"].rsplit("/", 1)[0]
    return f"{base}/15"


@pytest.fixture(scope="session")
def migrated() -> None:
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=API_DIR, check=True)


@pytest.fixture
def settings(migrated: None):  # type: ignore[no-untyped-def]
    from astro_api.config import Settings

    return Settings(
        app_env="test",
        database_url=SecretStr(os.environ["DATABASE_URL"]),
        redis_url=SecretStr(_test_redis_url()),
        admin_token=SecretStr(ADMIN_TOKEN),
        secret_key=SecretStr("test-secret-key-for-hmac-0123456789"),
    )


async def _truncate(url: str) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE"))
    await engine.dispose()


@pytest.fixture
def clean(settings):  # type: ignore[no-untyped-def]
    import redis

    from astro_api.sms import ConsoleSms

    asyncio.run(_truncate(settings.database_url.get_secret_value()))
    r = redis.Redis.from_url(settings.redis_url.get_secret_value())
    r.flushdb()
    r.close()
    ConsoleSms.outbox.clear()
    return settings


@pytest.fixture
def client(clean) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    from astro_api.main import create_app

    with TestClient(create_app(clean)) as c:
        yield c


@pytest.fixture
def admin_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {ADMIN_TOKEN}"}
