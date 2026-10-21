"""Paid reports API (docs/api/revenue.md §2): products, order validation, the snapshot (engine
outputs exactly as returned), reports and downloads, render data, the sample, admin, privacy.
Money paths are in test_reports_money.py."""

import asyncio
import importlib.util
import json
import logging
import time
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import reports
from astro_api.config import Settings

pytestmark = pytest.mark.integration

USER = "+919833330001"
OTHER = "+919833330002"
FIXTURES = Path(__file__).parent / "fixtures"
PDF = b"%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n" + b"%" * 300 + b"\n%%EOF\n"


def recorder() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "record_report_engine", FIXTURES / "record_report_engine.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    rec = recorder()
    monkeypatch.setattr(reports, "ENGINE_TRANSPORT", rec.replay_transport())
    monkeypatch.setattr(reports, "snapshot_as_of", lambda: rec.AS_OF)
    return rec


@pytest.fixture
def me(login):  # type: ignore[no-untyped-def]
    return login(USER)


def settings_of(client: TestClient) -> Settings:
    s: Settings = client.app.state.settings  # type: ignore[attr-defined]
    return s


def sql(client: TestClient, query: str, **params: Any) -> list[Any]:
    async def run() -> list[Any]:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with eng.begin() as conn:
                result = await conn.execute(text(query), params)
                return list(result.all()) if result.returns_rows else []
        finally:
            await eng.dispose()

    return asyncio.run(run())


def kundli(client: TestClient, headers: dict[str, str], spec: dict[str, Any]) -> str:
    body = {
        "name": spec["label"],
        "birth": {
            "date": spec["date"],
            "time": spec["time"],
            "place": {
                "lat": spec["lat"],
                "lon": spec["lon"],
                "tz": spec["tz"],
                "label": spec["place_name"],
            },
        },
    }
    r = client.post("/v1/kundlis", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def order(client: TestClient, headers: dict[str, str], **body: Any) -> Any:
    payload = {"sku": "kundli_report", "language": "en", "pay_with": "razorpay", **body}
    return client.post(
        "/v1/reports/orders", json=payload, headers={**headers, "Idempotency-Key": uuid.uuid4().hex}
    )


def paid_report(
    client: TestClient, headers: dict[str, str], kundli_ids: list[str], sku: str = "kundli_report"
) -> str:
    o = order(client, headers, sku=sku, kundli_ids=kundli_ids).json()
    r = client.post(
        f"/v1/dev/payments/{o['id']}/simulate", json={"outcome": "captured"}, headers=headers
    )
    assert r.json()["status"] == "processed", r.text
    report_id = client.get(f"/v1/reports/orders/{o['id']}", headers=headers).json()["report_id"]
    assert report_id
    return str(report_id)


def make_ready(client: TestClient, report_id: str, data: bytes = PDF) -> None:
    storage = client.app.state.storage  # type: ignore[attr-defined]
    key = uuid.uuid4().hex
    storage.put(key, data)
    sql(
        client,
        "UPDATE reports SET status='ready', storage_key=:k, pages=1, ready_at=now() WHERE id=:i",
        k=key,
        i=report_id,
    )


def recorded(rec: ModuleType, method: str, path: str) -> list[Any]:
    return [
        e["response"]
        for e in rec.load()["exchanges"]
        if e["request"][0] == method and e["request"][1] == path
    ]


def test_products_match_products_json(client: TestClient) -> None:
    items = {p["sku"]: p for p in client.get("/v1/reports/products").json()["items"]}
    assert items["kundli_report"] == {
        "sku": "kundli_report",
        "price_paise": 49900,
        "languages": ["en", "hi"],
        "pages_estimate": 18,
    }
    assert items["matching_report"]["price_paise"] == 39900


def test_order_validation(client: TestClient, me, login, engine) -> None:  # type: ignore[no-untyped-def]
    a = kundli(client, me, engine.PERSON_A)
    other = kundli(client, login(OTHER), engine.PERSON_B)
    assert order(client, {}, kundli_ids=[a]).status_code == 401
    r = client.post(
        "/v1/reports/orders",
        json={"sku": "kundli_report", "language": "en", "pay_with": "wallet", "kundli_ids": [a]},
        headers=me,
    )
    assert r.json()["detail"]["code"] == "idempotency_key_required"
    bad = order(client, me, sku="matching_report", kundli_ids=[a])
    assert (bad.status_code, bad.json()["detail"]["code"]) == (422, "wrong_kundli_count")
    same = order(client, me, sku="matching_report", kundli_ids=[a, a])
    assert same.json()["detail"]["code"] == "wrong_kundli_count"
    theirs = order(client, me, kundli_ids=[other])
    assert (theirs.status_code, theirs.json()["detail"]["code"]) == (404, "kundli_not_found")
    assert order(client, me, kundli_ids=[a], email="not-an-email").status_code == 422
    assert order(client, me, kundli_ids=[a], language="ta").status_code == 422
    assert sql(client, "SELECT count(*) FROM report_orders")[0][0] == 0


def test_engine_down_is_503_and_writes_nothing(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine, monkeypatch
) -> None:
    a = kundli(client, me, engine.PERSON_A)
    monkeypatch.setattr(
        reports,
        "ENGINE_TRANSPORT",
        httpx.MockTransport(lambda req: httpx.Response(503, json={"detail": {}})),
    )
    r = order(client, me, kundli_ids=[a])
    assert (r.status_code, r.json()["detail"]["code"]) == (503, "engine_unavailable")
    assert sql(client, "SELECT count(*) FROM report_orders")[0][0] == 0


def test_snapshot_is_the_engines_output_unchanged(client: TestClient, me, engine) -> None:  # type: ignore[no-untyped-def]
    a = kundli(client, me, engine.PERSON_A)
    b = kundli(client, me, engine.PERSON_B)
    report_id = paid_report(client, me, [a, b], sku="matching_report")
    snapshot, version = sql(
        client, "SELECT snapshot, engine_version FROM reports WHERE id = :i", i=report_id
    )[0]
    assert set(snapshot) == {"kundlis", "match", "meta"}
    assert snapshot["meta"] == recorded(engine, "GET", "/v1/meta")[0]
    assert version == snapshot["meta"]["version"]
    assert snapshot["match"] == recorded(engine, "POST", "/v1/match")[0]
    first, second = snapshot["kundlis"]
    assert set(first) == {
        "label", "birth", "kundli", "dasha", "doshas", "numerology", "panchang",
    }  # fmt: skip
    assert first["label"] == "Asha Verma" and second["label"] == "रवि शर्मा"
    assert first["birth"] == {
        "date": "1990-08-15",
        "time": "06:30",
        "place": {"name": "New Delhi", "lat": 28.62137, "lon": 77.2148, "tz": "Asia/Kolkata"},
    }
    for section, path in (
        ("kundli", "/v1/kundli"),
        ("dasha", "/v1/dasha"),
        ("doshas", "/v1/doshas"),
    ):
        assert first[section] in recorded(engine, "POST", path)
        assert second[section] in recorded(engine, "POST", path)
    assert first["panchang"] in recorded(engine, "GET", "/v1/panchang")
    assert first["numerology"] == recorded(engine, "POST", "/v1/numerology")[0]
    assert second["numerology"] is None  # not Latin letters: not computed, never guessed


def test_reports_downloads_and_render_data(  # type: ignore[no-untyped-def]
    client: TestClient, me, login, engine
) -> None:
    report_id = paid_report(client, me, [kundli(client, me, engine.PERSON_A)])
    listed = client.get("/v1/reports", headers=me).json()["items"]
    assert [r["id"] for r in listed] == [report_id]
    rep = client.get(f"/v1/reports/{report_id}", headers=me).json()
    assert rep["status"] == "queued" and rep["download_url"] is None and rep["pages"] is None
    assert rep["title"] == "Kundli report: Asha Verma"
    assert set(rep) == {
        "id", "sku", "language", "status", "title", "created_at", "ready_at", "pages",
        "download_url",
    }  # fmt: skip
    stranger = login(OTHER)
    assert client.get(f"/v1/reports/{report_id}", headers=stranger).status_code == 404
    assert client.get("/v1/reports", headers=stranger).json()["items"] == []
    assert client.get(f"/v1/reports/{report_id}/file", headers=me).status_code == 404

    make_ready(client, report_id)
    rep = client.get(f"/v1/reports/{report_id}", headers=me).json()
    assert rep["status"] == "ready" and rep["pages"] == 1
    url = rep["download_url"]
    assert url.startswith(f"/v1/reports/{report_id}/file?sig=")
    f = client.get(url)  # no session needed with the signed link
    assert f.status_code == 200 and f.content == PDF
    assert f.headers["content-type"] == "application/pdf"
    assert f.headers["cache-control"] == "private, no-store"
    assert f.headers["content-disposition"].startswith("attachment;")
    assert "Asha" not in f.headers["content-disposition"]
    assert client.get(f"/v1/reports/{report_id}/file", headers=me).status_code == 200
    assert client.get(f"/v1/reports/{report_id}/file", headers=stranger).status_code == 401
    assert client.get(f"/v1/reports/{report_id}/file").status_code == 401
    tampered = url[:-1] + ("0" if url[-1] != "0" else "1")
    assert client.get(tampered).status_code == 403
    rid = uuid.UUID(report_id)
    expired = (
        f"{int(time.time()) - 1}." + reports.sign(settings_of(client), "file", rid, 0).split(".")[1]
    )
    assert client.get(f"/v1/reports/{report_id}/file?sig={expired}").status_code == 403  # forged
    old_sig = reports.sign(settings_of(client), "file", rid, -10)
    gone = client.get(f"/v1/reports/{report_id}/file?sig={old_sig}")
    assert (gone.status_code, gone.json()["detail"]["code"]) == (410, "link_expired")
    # A file link for one report never opens another, and a render link is not a file link.
    render_sig = reports.sign(settings_of(client), "render", rid, 60)
    assert client.get(f"/v1/reports/{report_id}/file?sig={render_sig}").status_code == 403

    data = client.get(f"/v1/reports/render/{report_id}?sig={render_sig}")
    assert data.status_code == 200 and data.headers["cache-control"] == "private, no-store"
    body = data.json()
    assert set(body) == {"report", "snapshot"}
    assert set(body["report"]) == {"id", "sku", "language", "created_at", "engine_version"}
    assert body["report"]["id"] == report_id and body["report"]["sku"] == "kundli_report"
    assert body["snapshot"]["match"] is None and len(body["snapshot"]["kundlis"]) == 1
    file_sig = url.split("sig=")[1]
    assert client.get(f"/v1/reports/render/{report_id}?sig={file_sig}").status_code == 403
    assert client.get(f"/v1/reports/render/{report_id}").status_code == 403
    old_render = reports.sign(settings_of(client), "render", rid, -10)
    assert client.get(f"/v1/reports/render/{report_id}?sig={old_render}").status_code == 410
    unknown = uuid.uuid4()
    unknown_sig = reports.sign(settings_of(client), "render", unknown, 60)
    assert client.get(f"/v1/reports/render/{unknown}?sig={unknown_sig}").status_code == 404


def test_sample_is_built_once_rendered_by_the_queue_and_downloadable(  # type: ignore[no-untyped-def]
    client: TestClient, engine
) -> None:
    first = client.get("/v1/reports/sample", params={"sku": "kundli_report", "language": "en"})
    assert first.status_code == 202, first.text
    assert first.json() == {"status": "queued", "pages": None, "download_url": None}
    again = client.get("/v1/reports/sample", params={"sku": "kundli_report", "language": "en"})
    assert again.status_code == 202
    rows = sql(client, "SELECT id, user_id, order_id, snapshot FROM reports")
    assert len(rows) == 1
    report_id, user_id, order_id, snapshot = rows[0]
    assert user_id is None and order_id is None
    assert snapshot["kundlis"][0]["label"] == "Sample chart (a fictional person)"
    assert snapshot["kundlis"][0]["birth"]["place"]["name"] == "New Delhi"
    assert snapshot["kundlis"][0]["numerology"] is None
    jobs = sql(client, "SELECT key, payload FROM jobs")
    assert jobs == [(f"report:{report_id}:render", {"report_id": str(report_id)})]

    make_ready(client, str(report_id))
    ready = client.get("/v1/reports/sample", params={"sku": "kundli_report", "language": "en"})
    assert ready.status_code == 200 and ready.json()["status"] == "ready"
    assert client.get(ready.json()["download_url"]).content == PDF
    # Hindi is its own sample (place name in Hindi); matching has no fictional partner yet.
    hi = client.get("/v1/reports/sample", params={"sku": "kundli_report", "language": "hi"})
    assert hi.status_code == 202
    names = {
        r[0]
        for r in sql(
            client, "SELECT snapshot->'kundlis'->0->'birth'->'place'->>'name' FROM reports"
        )
    }
    assert names == {"New Delhi", "नई दिल्ली"}
    m = client.get("/v1/reports/sample", params={"sku": "matching_report", "language": "en"})
    assert (m.status_code, m.json()["detail"]["code"]) == (404, "sample_unavailable")
    assert (
        client.get("/v1/reports/sample", params={"sku": "x", "language": "en"}).status_code == 422
    )


def test_admin_list_and_retry(  # type: ignore[no-untyped-def]
    client: TestClient, me, admin_headers, engine
) -> None:
    report_id = paid_report(client, me, [kundli(client, me, engine.PERSON_A)])
    assert client.get("/v1/admin/reports", headers=me).status_code == 403
    sql(
        client,
        "UPDATE jobs SET attempts = 5, status = 'failed', last_error_code = 'render_timeout'",
    )
    sql(client, "UPDATE reports SET status = 'failed', failed_at = now()")
    items = client.get("/v1/admin/reports?status=failed", headers=admin_headers).json()["items"]
    assert len(items) == 1
    item = items[0]
    assert (item["id"], item["attempts"], item["last_error_code"]) == (
        report_id,
        5,
        "render_timeout",
    )
    assert item["pay_with"] == "razorpay" and item["sample"] is False
    owner = sql(client, "SELECT user_id FROM reports WHERE id = :i", i=report_id)[0][0]
    assert item["owner_id"] == str(owner) and item["refunded"] is False
    assert {
        "id", "owner_id", "sku", "language", "status", "attempts", "last_error_code",
        "refunded", "created_at", "ready_at",
    } <= set(item)  # fmt: skip
    assert "title" not in item and "snapshot" not in item
    assert "Asha" not in json.dumps(items) and "1990" not in json.dumps(items)
    assert client.get("/v1/admin/reports?status=ready", headers=admin_headers).json()["items"] == []
    assert client.get("/v1/admin/reports?status=nope", headers=admin_headers).status_code == 422

    retry = client.post(
        f"/v1/admin/reports/{report_id}/retry", json={"charge_again": False}, headers=admin_headers
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["job_key"] == f"report:{report_id}:render:1"
    assert retry.json()["status"] == "queued"
    queued = sql(client, "SELECT status FROM jobs WHERE key = :k", k=f"report:{report_id}:render:1")
    assert queued == [("queued",)]
    again = client.post(f"/v1/admin/reports/{report_id}/retry", json={}, headers=admin_headers)
    assert (again.status_code, again.json()["detail"]["code"]) == (409, "not_failed")
    charge = client.post(
        f"/v1/admin/reports/{report_id}/retry", json={"charge_again": True}, headers=admin_headers
    )
    assert charge.status_code == 422
    audit = sql(
        client, "SELECT action, entity_id, detail FROM audit_log WHERE action = 'report_retry'"
    )
    assert audit == [
        ("report_retry", report_id, {"render_n": 1, "refunded": False, "charge_again": False})
    ]
    items = client.get("/v1/admin/reports", headers=admin_headers).json()["items"]
    assert items[0]["attempts"] == 0 and items[0]["render_n"] == 1


def test_no_birth_details_or_email_in_logs(  # type: ignore[no-untyped-def]
    client: TestClient, me, engine, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    a = kundli(client, me, engine.PERSON_A)
    caplog.clear()
    r = order(client, me, kundli_ids=[a], email="asha@example.com")
    assert r.status_code == 201
    for secret in ("1990-08-15", "28.62137", "Asha", "asha@example.com"):
        assert secret not in caplog.text
    stored = sql(client, "SELECT email_ciphertext, email_key_id FROM report_orders")
    assert stored[0][0] is not None and b"asha" not in bytes(stored[0][0])


async def test_live_engine_snapshot() -> None:
    """Against the running engine (ASTRO_URL or localhost:8001); skips when it is not up."""
    rec = recorder()
    url = reports.engine_url(Settings(app_env="test"))
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        try:
            await http.get("/healthz")
        except httpx.HTTPError:
            pytest.skip("astro engine not reachable")
        snap = await reports.build_snapshot(
            http, "matching_report", [rec.birth(rec.PERSON_A), rec.birth(rec.PERSON_B)], rec.AS_OF
        )
    assert snap["meta"]["version"] and snap["match"] is not None
    assert [k["numerology"] is None for k in snap["kundlis"]] == [False, True]
    for k in snap["kundlis"]:
        assert {"grahas", "birth"} <= set(k["kundli"]) and "mahadashas" in k["dasha"]


WEB_FIXTURE = (
    Path(__file__).resolve().parents[3] / "apps/web/test/fixtures/report/fixture-kundli-en.json"
)


def shape(value: Any) -> Any:
    """Keys and value kinds, recursively (lists by their first item); null matches anything."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    if value is None:
        return None
    if isinstance(value, bool):
        return "bool"
    return "number" if isinstance(value, int | float) else type(value).__name__


def same_structure(ours: Any, theirs: Any, path: str = "$") -> list[str]:
    if ours is None or theirs is None:
        return []
    if isinstance(ours, dict) and isinstance(theirs, dict):
        problems = (
            [f"{path}: keys differ: {sorted(set(ours) ^ set(theirs))}"]
            if set(ours) != set(theirs)
            else []
        )
        for k in set(ours) & set(theirs):
            problems += same_structure(ours[k], theirs[k], f"{path}.{k}")
        return problems
    if isinstance(ours, list) and isinstance(theirs, list):
        if ours and theirs:
            return same_structure(ours[0], theirs[0], f"{path}[0]")
        return []
    return [] if ours == theirs else [f"{path}: {ours} != {theirs}"]


async def test_live_render_data_matches_the_print_page_fixture() -> None:
    """RenderData built from the live engine has the keys and structure the web print page is
    built against (apps/web/test/fixtures/report/fixture-kundli-en.json)."""
    import datetime as dt

    from astro_api.models_reports import Report

    rec = recorder()
    url = reports.engine_url(Settings(app_env="test"))
    async with httpx.AsyncClient(base_url=url, timeout=30) as http:
        try:
            await http.get("/healthz")
        except httpx.HTTPError:
            pytest.skip("astro engine not reachable")
        snap = await reports.build_snapshot(
            http, "kundli_report", [rec.birth(rec.PERSON_A)], rec.AS_OF
        )
    report = Report(
        id=uuid.uuid4(),
        sku="kundli_report",
        language="en",
        snapshot=snap,
        engine_version=reports.engine_version(snap),
        created_at=dt.datetime.now(dt.UTC),
    )
    ours = json.loads(json.dumps(reports.render_data(report)))
    theirs = json.loads(WEB_FIXTURE.read_text(encoding="utf-8"))
    theirs.pop("_comment", None)
    assert ours["report"]["id"] == str(report.id)
    assert ours["snapshot"]["kundlis"][0]["birth"]["place"]["name"]
    assert same_structure(shape(ours), shape(theirs)) == []
