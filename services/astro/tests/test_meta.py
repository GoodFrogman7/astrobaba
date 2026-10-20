from fastapi.testclient import TestClient

from astro_engine.main import app


def test_healthz() -> None:
    assert TestClient(app).get("/healthz").json()["status"] == "ok"


def test_meta_reports_no_backend_until_phase_1() -> None:
    body = TestClient(app).get("/v1/meta").json()
    assert body["ephemeris_backend"] is None
    assert body["default_ayanamsha"] == "lahiri"
