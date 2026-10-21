from fastapi.testclient import TestClient
from pydantic import SecretStr

from astro_api.config import Settings
from astro_api.main import create_app


def unreachable_settings() -> Settings:
    return Settings(
        app_env="test",
        database_url=SecretStr("postgresql+asyncpg://u:p@127.0.0.1:1/none"),
        redis_url=SecretStr("redis://127.0.0.1:1/0"),
        readiness_timeout_s=0.5,
    )


def test_healthz_is_up_without_dependencies() -> None:
    with TestClient(create_app(unreachable_settings())) as client:
        r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.headers["x-request-id"]


def test_readyz_reports_503_when_dependencies_are_down() -> None:
    with TestClient(create_app(unreachable_settings())) as client:
        r = client.get("/readyz")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "degraded"
    assert {c["name"] for c in body["checks"]} == {"postgres", "redis"}
    assert all(c["status"].startswith("error") for c in body["checks"])


def test_request_id_is_echoed() -> None:
    with TestClient(create_app(unreachable_settings())) as client:
        r = client.get("/healthz", headers={"X-Request-ID": "abc123"})
    assert r.headers["x-request-id"] == "abc123"


def test_flags_endpoint() -> None:
    with TestClient(create_app(unreachable_settings())) as client:
        r = client.get("/v1/flags")
    assert r.status_code == 200
    assert r.json()["hindi_locale"] is True
