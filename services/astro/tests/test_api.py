import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from astro_engine.config import get_settings
from astro_engine.main import app

client = TestClient(app)
BIRTH = {"date": "2000-01-01", "time": "12:00", "place": {"lat": 28.6139, "lon": 77.209, "tz": "Asia/Kolkata"}}


def test_meta() -> None:
    body = client.get("/v1/meta").json()
    assert body["ephemeris_backend"] == "swiss_ephemeris"
    assert body["license"] == "AGPL-3.0-only"
    assert client.get("/v1/source").json()["source"].startswith("https://github.com/")


def test_kundli_endpoint() -> None:
    r = client.post("/v1/kundli", json={"birth": BIRTH})
    assert r.status_code == 200
    body = r.json()
    assert body["birth"]["utc"] == "2000-01-01T06:30:00Z"
    assert len(body["grahas"]) == 9


def test_kundli_rejects_nonexistent_time_with_code() -> None:
    birth = {"date": "2024-03-31", "time": "01:30", "place": {"lat": 51.5, "lon": -0.12, "tz": "Europe/London"}}
    r = client.post("/v1/kundli", json={"birth": birth})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "nonexistent_local_time"


def test_dasha_doshas_match_transits_panchang() -> None:
    assert client.post("/v1/dasha", json={"birth": BIRTH, "as_of": "2026-10-20"}).json()["current"]
    d = client.post("/v1/doshas", json={"birth": BIRTH}).json()
    assert {"mangal", "kaal_sarp", "sade_sati"} <= set(d)
    m = client.post("/v1/match", json={"groom": BIRTH, "bride": {**BIRTH, "date": "2001-06-15"}}).json()
    assert 0 <= m["total"] <= 36
    assert m["tables_review_status"] == "needs_astrologer_review"
    t = client.get("/v1/transits", params={"at": "2026-10-20T00:00:00Z", "moon_sign_index": 6}).json()
    assert all("house_from_moon" in g for g in t["grahas"])
    p = client.get("/v1/panchang", params={"lat": 28.6139, "lon": 77.209, "tz": "Asia/Kolkata", "date": "2025-10-20"})
    assert p.status_code == 200 and p.json()["vaara"]["en"] == "Monday"


def test_transits_rejects_naive_datetime() -> None:
    assert client.get("/v1/transits", params={"at": "2026-10-20T00:00:00"}).status_code == 422


def test_cities() -> None:
    body = client.get("/v1/cities", params={"q": "varanasi"}).json()
    top = body["results"][0]
    assert top["name"] == "Varanasi" and top["tz"] == "Asia/Kolkata"
    assert "GeoNames" in body["attribution"]
    assert client.get(f"/v1/cities/{top['id']}").json()["lat"] == top["lat"]
    assert client.get("/v1/cities/1").status_code == 404


def test_unreviewed_tables_blocked_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "app_env", "production")
    assert client.post("/v1/match", json={"groom": BIRTH, "bride": BIRTH}).json()["detail"]["code"] == "tables_not_reviewed"
    assert client.post("/v1/doshas", json={"birth": BIRTH}).status_code == 503
    assert client.post("/v1/kundli", json={"birth": BIRTH}).status_code == 200


def test_only_the_astro_service_imports_swiss_ephemeris() -> None:
    """AGPL boundary (ADR-0001 option C): no other part of the repo may link Swiss Ephemeris."""
    repo = Path(__file__).resolve().parents[3]
    astro = repo / "services" / "astro"
    offenders = []
    for path in repo.rglob("*.py"):
        if any(part in {".venv", "node_modules", ".git"} for part in path.parts):
            continue
        if astro in path.parents or (repo / "evals") in path.parents:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "import swisseph" in text or "from swisseph" in text:
            offenders.append(str(path.relative_to(repo)))
    assert offenders == []
    assert os.path.exists(astro / "LICENSE")


def test_ephemeris_files_used_from_every_worker_thread() -> None:
    """Swiss Ephemeris settings are thread-local; requests run on pool threads."""
    from concurrent.futures import ThreadPoolExecutor

    from astro_engine.ephemeris import get_backend

    def sun(_: int) -> float:
        return get_backend().body(2451545.0, "sun", "lahiri", "mean").tropical

    with ThreadPoolExecutor(8) as pool:
        values = set(pool.map(sun, range(32)))
    assert len(values) == 1
