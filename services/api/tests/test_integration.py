import pytest
from fastapi.testclient import TestClient

from astro_api.config import Settings
from astro_api.main import create_app


@pytest.mark.integration
def test_readyz_ok_with_real_postgres_and_redis() -> None:
    with TestClient(create_app(Settings())) as client:
        r = client.get("/readyz")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"
