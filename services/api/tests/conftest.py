import os

import pytest

# Unit tests must not need real services; integration tests opt in via the marker.
os.environ.setdefault("APP_ENV", "test")


def services_available() -> bool:
    return bool(os.environ.get("DATABASE_URL")) and bool(os.environ.get("REDIS_URL"))


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if services_available():
        return
    skip = pytest.mark.skip(reason="DATABASE_URL/REDIS_URL not set")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)
