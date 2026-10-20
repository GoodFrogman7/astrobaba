from fastapi.testclient import TestClient

from astro_engine.main import app


def test_healthz() -> None:
    assert TestClient(app).get("/healthz").json()["status"] == "ok"


def test_meta_reports_backend_and_conventions() -> None:
    body = TestClient(app).get("/v1/meta").json()
    assert body["ephemeris_backend"] == "swiss_ephemeris"
    assert (body["default_ayanamsha"], body["default_node"], body["house_system"]) == (
        "lahiri",
        "mean",
        "whole_sign",
    )
    assert body["tables_review_status"]["matching"] == "needs_astrologer_review"
