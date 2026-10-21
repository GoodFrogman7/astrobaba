"""Data export (docs/api/trust.md §2): one per 24 h, built into a JSON file of everything held
about the user (own chat messages decrypted, the astrologer by display name, never another
client's data), stored under a random key, downloaded with a 10-minute signed link, removed
when it expires."""

import datetime as dt
import json
import time
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import privacy
from astro_api.models_jobs import Job
from astro_api.models_privacy import DataExport
from services.api.tests.privacy_support import (
    AI_ANSWER,
    AI_TEXT,
    ASTRO_MESSAGE,
    LEAD_NOTE,
    MY_MESSAGE,
    OTHER_MESSAGE,
    OTHER_PHONE,
    REPORT_NOTE,
    USER_PHONE,
    make_world,
    run_db,
)

pytestmark = pytest.mark.integration


def _complete(client: TestClient, export_id: str) -> bool:
    settings = client.app.state.settings  # type: ignore[attr-defined]
    storage = client.app.state.storage  # type: ignore[attr-defined]
    done: bool = run_db(
        client, lambda db: privacy.complete_export(db, settings, storage, uuid.UUID(export_id))
    )
    return done


def _download(client: TestClient, url: str, headers: dict[str, str] | None = None) -> Any:
    return client.get(url, headers=headers or {})


def test_request_build_download(client: TestClient, login, make_live) -> None:  # type: ignore[no-untyped-def]
    _, aid, _ = make_live("+919844400099")
    h = login(USER_PHONE)
    other = login(OTHER_PHONE)
    w = make_world(client, aid)

    r = client.post("/v1/me/export", headers=h)
    assert r.status_code == 202, r.text
    eid = r.json()["id"]
    assert r.json()["status"] == "queued"
    listed = client.get("/v1/me/exports", headers=h).json()
    assert listed == [
        {
            "id": eid,
            "status": "queued",
            "created_at": listed[0]["created_at"],
            "expires_at": None,
            "download_url": None,
        }
    ]

    async def job(db: AsyncSession) -> tuple[str, dict[str, Any]]:
        row = (await db.execute(select(Job).where(Job.key == f"export:{eid}:build"))).scalar_one()
        return row.kind, row.payload

    assert run_db(client, job) == ("data_export", {"export_id": eid})

    # One per 24 hours.
    r = client.post("/v1/me/export", headers=h)
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "export_rate_limited"
    assert 0 < int(r.headers["Retry-After"]) <= 24 * 3600

    assert _complete(client, eid) is True
    assert _complete(client, eid) is False  # idempotent
    item = client.get("/v1/me/exports", headers=h).json()[0]
    assert item["status"] == "ready"
    url = item["download_url"]
    assert url.startswith(f"/v1/me/exports/{eid}/file?sig=")

    r = _download(client, url)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert "attachment" in r.headers["content-disposition"]
    assert r.headers["cache-control"] == "private, no-store"
    raw = r.content.decode()
    data = json.loads(raw)
    assert data["format"] == "astro-data-export/1"
    assert data["profile"]["id"] == str(w.user_id)
    assert data["profile"]["phone"] == USER_PHONE
    assert {c["kind"] for c in data["consents"]} == {
        "age_18",
        "terms",
        "privacy",
        "astrologer_terms",
    }
    assert data["saved_kundlis"][0]["name"] == "Ravi Kumar"
    [consultation] = data["consultations"]
    assert consultation["astrologer"]["display_name"] == "Asha Verma"
    assert [(m["from"], m["text"]) for m in consultation["messages"]] == [
        ("you", MY_MESSAGE),
        ("Asha Verma", ASTRO_MESSAGE),
        ("system", "session_ended"),
    ]
    assert data["reviews"][0]["rating"] == 5
    assert data["ai_questions"][0]["question"] == AI_TEXT
    assert data["ai_questions"][0]["answer"] == AI_ANSWER
    assert data["ai_questions"][0]["label"] == "AI"
    assert data["remedy_leads"][0]["note"] == LEAD_NOTE
    [filed] = data["astrologer_reports_filed"]
    assert (filed["astrologer"], filed["reason"], filed["note"]) == (
        "Asha Verma",
        "off_platform",
        REPORT_NOTE,
    )
    assert consultation["safety_flags"] == []
    assert data["reports"]["reports"][0]["id"] == str(w.report_id)
    assert data["wallet"]["balance"] == {"real_paise": 0, "promo_paise": 4000}
    assert {i["kind"] for i in data["wallet"]["history"]} >= {"consultation"}
    assert data["privacy"]["free_session"]["session_id"] == str(w.session_id)
    assert data["astrologer"] is None
    # Never another client's data.
    for secret in (OTHER_MESSAGE, OTHER_PHONE, str(w.other_id), str(w.other_session_id)):
        assert secret not in raw

    # The link: tampered → 403, expired → 410, owner's session works, another user's does not.
    assert _download(client, url[:-2] + "00").status_code == 403
    settings = client.app.state.settings  # type: ignore[attr-defined]
    expired = privacy.sign_export(settings, uuid.UUID(eid), ttl_s=-5)
    r = _download(client, f"/v1/me/exports/{eid}/file?sig={expired}")
    assert r.status_code == 410
    assert _download(client, f"/v1/me/exports/{eid}/file").status_code == 401
    assert _download(client, f"/v1/me/exports/{eid}/file", h).status_code == 200
    assert _download(client, f"/v1/me/exports/{eid}/file", other).status_code == 401

    # Removal when due: scheduled at expiry, refused before, done after.
    async def expiry(db: AsyncSession) -> Job:
        return (await db.execute(select(Job).where(Job.key == f"export:{eid}:expire"))).scalar_one()

    exp_job = run_db(client, expiry)
    assert exp_job.kind == "account_cleanup" and exp_job.payload == {"export_id": eid}
    assert exp_job.run_after > dt.datetime.now(dt.UTC) + dt.timedelta(days=6)
    storage = client.app.state.storage  # type: ignore[attr-defined]
    assert run_db(client, lambda db: privacy.expire_export(db, storage, uuid.UUID(eid))) is False
    later = dt.datetime.now(dt.UTC) + dt.timedelta(days=8)
    assert (
        run_db(client, lambda db: privacy.expire_export(db, storage, uuid.UUID(eid), now=later))
        is True
    )
    item = client.get("/v1/me/exports", headers=h).json()[0]
    assert item["status"] == "expired" and item["download_url"] is None
    assert _download(client, url).status_code == 404


def test_failed_export_does_not_count_and_signature_is_bound_to_the_export(
    client: TestClient,
    login: Any,
) -> None:
    h = login(USER_PHONE)
    eid = client.post("/v1/me/export", headers=h).json()["id"]
    run_db(client, lambda db: privacy.fail_export(db, uuid.UUID(eid), "boom"))
    assert client.get("/v1/me/exports", headers=h).json()[0]["status"] == "failed"
    r = client.post("/v1/me/export", headers=h)
    assert r.status_code == 202
    second = r.json()["id"]
    assert _complete(client, second)
    settings = client.app.state.settings  # type: ignore[attr-defined]
    sig = privacy.sign_export(settings, uuid.UUID(second))
    # The same signature does not open another export.
    assert _download(client, f"/v1/me/exports/{eid}/file?sig={sig}").status_code == 403
    assert privacy.check_export_sig(settings, uuid.UUID(second), sig) == "ok"
    assert privacy.check_export_sig(settings, uuid.UUID(second), f"{int(time.time())}.x") == (
        "invalid"
    )


def test_window_is_24_hours(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(USER_PHONE)
    eid = client.post("/v1/me/export", headers=h).json()["id"]

    async def age(db: AsyncSession) -> None:
        await db.execute(
            text("UPDATE data_exports SET created_at = now() - interval '25 hours' WHERE id = :i"),
            {"i": uuid.UUID(eid)},
        )
        await db.commit()

    run_db(client, age)
    assert client.post("/v1/me/export", headers=h).status_code == 202


def test_astrologer_export_lists_kyc_and_never_clients(
    client: TestClient,
    login: Any,
    make_live: Any,
    consult: Any,
) -> None:
    headers, aid, _ = make_live("+919844400098")
    login(USER_PHONE)
    sid = consult(USER_PHONE, aid)
    eid = client.post("/v1/me/export", headers=headers).json()["id"]
    assert _complete(client, eid)
    url = client.get("/v1/me/exports", headers=headers).json()[0]["download_url"]
    raw = client.get(url).content.decode()
    data = json.loads(raw)
    a = data["astrologer"]
    assert a["application"]["id"] == aid
    assert a["application"]["display_name"] == "Asha Verma"
    assert {d["kind"] for d in a["kyc_documents"]} == {"identity", "qualification"}
    assert all("storage_key" not in d and "content" not in d for d in a["kyc_documents"])
    assert a["consultations_served"][0]["id"] == sid
    assert "earnings" in a and "payouts" in a and "availability" in a
    assert USER_PHONE not in raw

    async def client_id(db: AsyncSession) -> str:
        row = await db.execute(text("SELECT id FROM users WHERE phone = :p"), {"p": USER_PHONE})
        return str(row.scalar_one())

    assert run_db(client, client_id) not in raw


def test_export_rows_need_sign_in(client: TestClient) -> None:
    assert client.post("/v1/me/export").status_code == 401
    assert client.get("/v1/me/exports").status_code == 401

    async def none(db: AsyncSession) -> int:
        return len(list((await db.execute(select(DataExport))).scalars()))

    assert run_db(client, none) == 0
