"""`python -m astro_api.cli analytics-purge` (docs/api/growth.md §1.2): deletes analytics events
older than ANALYTICS_RETENTION_DAYS (default 400) and prints the count."""

import datetime as dt
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import cli
from astro_api.config import get_settings
from astro_api.models_analytics import AnalyticsEvent
from services.api.tests.privacy_support import run_db

pytestmark = pytest.mark.integration


@pytest.fixture
def cli_env(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    settings = client.app.state.settings  # type: ignore[attr-defined]
    monkeypatch.setenv("DATABASE_URL", settings.database_url.get_secret_value())
    monkeypatch.setenv("REDIS_URL", settings.redis_url.get_secret_value())
    monkeypatch.setenv("SECRET_KEY", settings.secret_key.get_secret_value())
    monkeypatch.delenv("ANALYTICS_RETENTION_DAYS", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _seed(client: TestClient, ages_days: list[float]) -> None:
    now = dt.datetime.now(dt.UTC)

    async def go(db: AsyncSession) -> None:
        for i, age in enumerate(ages_days):
            db.add(
                AnalyticsEvent(
                    event="page_view",
                    occurred_at=now - dt.timedelta(days=age),
                    anonymous_id=f"anon_purge_{i:04d}",
                    locale="en",
                    properties={"path": "/"},
                )
            )
        await db.commit()

    run_db(client, go)


def _left(client: TestClient) -> list[str]:
    async def go(db: AsyncSession) -> list[str]:
        q = select(AnalyticsEvent.anonymous_id).order_by(AnalyticsEvent.anonymous_id)
        return list((await db.execute(q)).scalars())

    result: list[str] = run_db(client, go)
    return result


def test_purge_uses_the_retention_setting(
    client: TestClient, cli_env: None, monkeypatch: pytest.MonkeyPatch, capsys: Any
) -> None:
    _seed(client, [400.5, 401, 399.5, 31, 0])
    assert cli.main(["analytics-purge"]) == 0
    assert capsys.readouterr().out.strip() == "analytics_events_purged=2"
    assert _left(client) == ["anon_purge_0002", "anon_purge_0003", "anon_purge_0004"]
    assert cli.main(["analytics-purge"]) == 0  # nothing more to do
    assert capsys.readouterr().out.strip() == "analytics_events_purged=0"

    monkeypatch.setenv("ANALYTICS_RETENTION_DAYS", "30")
    get_settings.cache_clear()
    assert cli.main(["analytics-purge"]) == 0
    assert capsys.readouterr().out.strip() == "analytics_events_purged=2"
    assert _left(client) == ["anon_purge_0004"]
