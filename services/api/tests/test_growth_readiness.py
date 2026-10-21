"""Launch readiness (docs/api/growth.md §5): the logic of every check, then the endpoint computing
them live from settings, data files, the engine and the database."""

import asyncio
import datetime as dt
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import growth_api as g
from astro_api.config import Settings, legal_version
from astro_api.horoscopes import SIGNS

NOW = dt.datetime(2026, 10, 21, 6, 0, tzinfo=dt.UTC)
SECRET = "sk-live-super-secret-value-0123456789abcdef"


def base_settings(**overrides: Any) -> Settings:
    return Settings(app_env="test", **overrides)


# ---------------------------------------------------------------- check logic (no services)


def test_legal_approved() -> None:
    assert g.legal_check("", "2026-10-21")["status"] == "fail"
    assert g.legal_check("2026-10-01", "2026-10-21")["status"] == "fail"
    ok = g.legal_check("2026-10-21", "2026-10-21")
    assert ok == {"id": "legal_approved", "status": "pass", "detail": ok["detail"]}


def test_helplines_verified() -> None:
    lines = [{"id": "a"}, {"id": "b"}]
    assert g.helplines_check({"verified_by_founder": False, "helplines": lines})["status"] == "fail"
    assert g.helplines_check({"verified_by_founder": True, "helplines": lines})["status"] == "pass"
    # A per-helpline flag overrides the file-level one.
    mixed = [{"id": "a", "verified_by_founder": True}, {"id": "b", "verified_by_founder": False}]
    check = g.helplines_check({"verified_by_founder": True, "helplines": mixed})
    assert check["status"] == "fail" and "b" in check["detail"]
    each = [{"id": "a", "verified_by_founder": True}, {"id": "b", "verified_by_founder": True}]
    assert g.helplines_check({"helplines": each})["status"] == "pass"
    assert g.helplines_check({"verified_by_founder": True, "helplines": []})["status"] == "fail"


def test_jyotish_tables_reviewed() -> None:
    assert g.tables_check(None)["status"] == "warn"
    pending = {
        "tables_review_status": {"matching": "verified", "doshas": "needs_astrologer_review"}
    }
    check = g.tables_check(pending)
    assert check["status"] == "fail" and "doshas" in check["detail"]
    done = {"tables_review_status": {"matching": "verified", "doshas": "verified"}}
    assert g.tables_check(done)["status"] == "pass"
    assert g.tables_check({"tables_review_status": {}})["status"] == "fail"


def test_supply_checks() -> None:
    assert g.supply_live_check(0, 30)["status"] == "fail"
    assert g.supply_live_check(12, 30)["status"] == "warn"
    assert g.supply_live_check(30, 30)["status"] == "pass"
    rows = [{"id": "hi", "live": 15, "target_min": 15}, {"id": "en", "live": 3, "target_min": 15}]
    check = g.supply_languages_check(rows)
    assert check["status"] == "fail" and "en" in check["detail"] and "hi" not in check["detail"]
    rows[1]["live"] = 20
    assert g.supply_languages_check(rows)["status"] == "pass"


def test_horoscopes_today() -> None:
    signs = SIGNS
    full = {(s, loc) for s in signs for loc in ("en", "hi")}
    assert g.horoscopes_check(full, ("en", "hi"))["status"] == "pass"
    missing = full - {("leo", "hi")}
    check = g.horoscopes_check(missing, ("en", "hi"))
    assert check["status"] == "fail" and "11/12" in check["detail"]
    assert g.horoscopes_check(missing, ("en",))["status"] == "pass"
    assert g.horoscopes_check(set(), ("en",))["status"] == "fail"


def test_provider_checks_never_leak_secrets() -> None:
    fake = base_settings()
    assert g.payments_check(fake)["status"] == "fail"
    assert g.sms_check(fake)["status"] == "fail"
    assert g.email_check(fake)["status"] == "fail"
    assert g.storage_check(fake)["status"] == "fail"
    live = base_settings(
        payments_provider="razorpay",
        razorpay_key_id="rzp_live_x",
        razorpay_key_secret=SecretStr(SECRET),
        razorpay_webhook_secret=SecretStr(SECRET),
        sms_provider="msg91",
        email_provider="smtp",
        smtp_url=SecretStr(f"smtps://user:{SECRET}@smtp.example.com:465"),
        documents_backend="s3",
    )
    checks = [g.payments_check(live), g.sms_check(live), g.email_check(live), g.storage_check(live)]
    assert [c["status"] for c in checks] == ["pass"] * 4
    no_keys = base_settings(payments_provider="razorpay")
    assert g.payments_check(no_keys)["status"] == "fail"
    for c in [*checks, g.payments_check(no_keys)]:
        assert SECRET not in json.dumps(c)


def test_reconciliation_recent() -> None:
    assert g.reconciliation_check(None, NOW)["status"] == "fail"
    recent = NOW - dt.timedelta(hours=10)
    assert g.reconciliation_check(("ok", 0, recent), NOW)["status"] == "pass"
    assert g.reconciliation_check(("ok", 150, recent), NOW)["status"] == "fail"
    assert g.reconciliation_check(("drift", 900, recent), NOW)["status"] == "fail"
    assert g.reconciliation_check(("error", 0, recent), NOW)["status"] == "fail"
    old = NOW - dt.timedelta(hours=37)
    assert g.reconciliation_check(("ok", 0, old), NOW)["status"] == "fail"


def test_jobs_and_analytics() -> None:
    assert g.jobs_check(0)["status"] == "pass"
    assert g.jobs_check(3)["status"] == "warn"
    assert g.analytics_check(None)["status"] == "warn"  # table not there yet
    assert g.analytics_check(0)["status"] == "warn"
    assert g.analytics_check(5)["status"] == "pass"


def test_voice_ready() -> None:
    dev = base_settings()
    assert g.voice_check(False, dev)["status"] == "pass"
    assert g.voice_check(True, dev)["status"] == "fail"
    live = base_settings(
        livekit_api_key="APIxyz",
        livekit_api_secret=SecretStr(SECRET),
        livekit_public_url="wss://livekit.example.com",
    )
    check = g.voice_check(True, live)
    assert check["status"] == "pass" and SECRET not in check["detail"]


def test_ai_ready() -> None:
    none = g.LlmKeys(_env_file=None, llm_provider="gemini")
    assert g.ai_check(False, none)["status"] == "pass"
    assert g.ai_check(True, none)["status"] == "fail"
    fake = g.LlmKeys(_env_file=None, llm_provider="fake", gemini_api_key=SecretStr(SECRET))
    assert g.ai_check(True, fake)["status"] == "fail"
    ok = g.LlmKeys(_env_file=None, llm_provider="anthropic", anthropic_api_key=SecretStr(SECRET))
    check = g.ai_check(True, ok)
    assert check["status"] == "pass" and SECRET not in check["detail"]
    wrong = g.LlmKeys(_env_file=None, llm_provider="anthropic", gemini_api_key=SecretStr(SECRET))
    assert g.ai_check(True, wrong)["status"] == "fail"


# ---------------------------------------------------------------- endpoint (integration)


def _sql(settings: Settings, query: str, **params: Any) -> None:
    async def run() -> None:
        eng = create_async_engine(settings.database_url.get_secret_value())
        try:
            async with eng.begin() as conn:
                await conn.execute(text(query), params)
        finally:
            await eng.dispose()

    asyncio.run(run())


def _meta(statuses: dict[str, str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/meta"
        return httpx.Response(200, json={"version": "test", "tables_review_status": statuses})

    return httpx.MockTransport(handler)


def _down() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("engine down", request=request)

    return httpx.MockTransport(handler)


@pytest.mark.integration
def test_endpoint_lists_every_check_in_order(
    client: TestClient, admin_headers: dict[str, str], login: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(g, "ENGINE_TRANSPORT", _down())
    monkeypatch.setenv("FLAG_VOICE_CALLS", "false")
    monkeypatch.setenv("FLAG_AI_ASSISTANT", "false")
    r = client.get("/v1/admin/launch-readiness", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"generated_at", "checks"}
    ids = [c["id"] for c in body["checks"]]
    assert ids == list(g.READINESS_CHECKS)
    status = {c["id"]: c["status"] for c in body["checks"]}
    assert status["jyotish_tables_reviewed"] == "warn"  # engine unreachable
    assert status["supply_live"] == "fail"
    assert status["horoscopes_today"] == "fail"
    assert status["payments_live"] == "fail"  # test settings: fake provider
    assert status["reconciliation_recent"] == "fail"
    assert status["jobs_healthy"] == "pass"
    assert status["analytics_flowing"] == "warn"
    assert status["voice_ready"] == "pass" and status["ai_ready"] == "pass"
    assert all(set(c) == {"id", "status", "detail"} and c["detail"] for c in body["checks"])
    secret = client.app.state.settings.secret_key.get_secret_value()  # type: ignore[attr-defined]
    assert secret not in r.text

    assert (
        client.get("/v1/admin/launch-readiness", headers=login("+919855550001")).status_code == 403
    )


@pytest.mark.integration
def test_endpoint_reads_live_facts(
    client: TestClient, admin_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    monkeypatch.setattr(settings, "legal_approved_version", legal_version())
    monkeypatch.setattr(
        g, "ENGINE_TRANSPORT", _meta({"matching": "verified", "doshas": "verified"})
    )
    today = g.ist_today()
    for sign in SIGNS:
        for locale in ("en", "hi"):
            _sql(
                settings,
                "INSERT INTO horoscope_entries (id, period, sign, ist_date, ist_date_end, locale, "
                "sections, scores, lucky, facts, model, prompt_version, status, created_at) "
                "VALUES (gen_random_uuid(), 'daily', :s, :d, :d, :l, '{}', '{}', '{}', '{}', "
                "'fake', 'v1', 'published', now())",
                s=sign,
                d=today,
                l=locale,
            )
    _sql(
        settings,
        "INSERT INTO reconciliation_runs (id, run_date, status, drift_paise, checks, trigger, "
        "started_at, finished_at) VALUES (gen_random_uuid(), :d, 'ok', 0, '[]', 'cli', "
        "now() - interval '2 hours', now() - interval '2 hours')",
        d=today,
    )
    _sql(
        settings,
        "INSERT INTO jobs (id, kind, key, payload, status, finished_at) "
        "VALUES (gen_random_uuid(), 'report_render', 'k1', '{}', 'failed', now())",
    )
    r = client.get("/v1/admin/launch-readiness", headers=admin_headers)
    status = {c["id"]: c["status"] for c in r.json()["checks"]}
    assert status["legal_approved"] == "pass"
    assert status["jyotish_tables_reviewed"] == "pass"
    assert status["horoscopes_today"] == "pass"
    assert status["reconciliation_recent"] == "pass"
    assert status["jobs_healthy"] == "warn"
