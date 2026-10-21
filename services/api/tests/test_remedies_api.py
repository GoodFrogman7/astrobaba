"""Remedies catalogue and partner leads (docs/api/revenue.md §4): consent, Idempotency-Key, the
daily limit, the note encrypted at rest, the notify job in the same transaction, a masked phone
in every view, and audited admin status changes."""

import asyncio
import datetime as dt
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api.chat_crypto import Sealed, cipher_from_settings
from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.models import AuditLog
from astro_api.models_jobs import Job
from astro_api.models_remedies import RemedyLead, note_aad

pytestmark = pytest.mark.integration

PHONE = "+919812345678"
NOTE = "Please call after 6 pm, Sunday works best"


def settings_of(client: TestClient) -> Settings:
    s: Settings = client.app.state.settings  # type: ignore[attr-defined]
    return s


def run_db(client: TestClient, fn: Any) -> Any:
    async def run() -> Any:
        engine = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                return await fn(db)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def lead_body(**overrides: Any) -> dict[str, Any]:
    tomorrow = (dt.datetime.now(dt.UTC) + dt.timedelta(days=2)).date().isoformat()
    body: dict[str, Any] = {
        "remedy_id": "ganesh-puja",
        "preferred_date": tomorrow,
        "language": "hi",
        "note": NOTE,
        "consent": True,
    }
    body.update(overrides)
    return body


def post_lead(
    client: TestClient, headers: dict[str, str], key: str | None = None, **overrides: Any
) -> Any:
    h = dict(headers)
    h["Idempotency-Key"] = key or uuid.uuid4().hex
    return client.post("/v1/remedies/leads", json=lead_body(**overrides), headers=h)


def test_catalogue_lists_entries_with_the_notice(client: TestClient) -> None:
    r = client.get("/v1/remedies")
    assert r.status_code == 200
    body = r.json()
    assert {i["id"] for i in body["items"]} >= {"ganesh-puja", "puja-enquiry-call"}
    item = body["items"][0]
    assert set(item) == {"id", "kind", "name", "description", "price_note", "review"}
    assert item["review"] == "needs_editorial_review"
    assert "no outcome is promised" in body["notice"]["en"]


def test_staging_shows_an_empty_catalogue_and_refuses_leads(client: TestClient, login: Any) -> None:
    client.app.state.settings = settings_of(client).model_copy(update={"app_env": "staging"})  # type: ignore[attr-defined]
    assert client.get("/v1/remedies").json()["items"] == []
    r = post_lead(client, login(PHONE))
    assert r.status_code == 404 and r.json()["detail"]["code"] == "remedy_not_found"


def test_lead_needs_sign_in_key_and_consent(client: TestClient, login: Any) -> None:
    assert client.post("/v1/remedies/leads", json=lead_body()).status_code == 401
    headers = login(PHONE)
    r = client.post("/v1/remedies/leads", json=lead_body(), headers=headers)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "idempotency_key_required"
    for consent in (False, None):
        body = lead_body()
        if consent is None:
            body.pop("consent")
        else:
            body["consent"] = consent
        r = client.post(
            "/v1/remedies/leads", json=body, headers={**headers, "Idempotency-Key": "k" * 12}
        )
        assert r.status_code == 422 and r.json()["detail"]["code"] == "consent_required"
    r = post_lead(client, headers, remedy_id="blue-sapphire")
    assert r.status_code == 404
    r = post_lead(client, headers, preferred_date="2020-01-01")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_preferred_date"
    assert post_lead(client, headers, note="x" * 501).status_code == 422
    assert post_lead(client, headers, language="ta").status_code == 422
    assert run_db(client, lambda db: _count_leads(db)) == 0


async def _count_leads(db: Any) -> int:
    return len((await db.execute(select(RemedyLead))).scalars().all())


def test_lead_is_stored_encrypted_with_a_notify_job_and_replays(
    client: TestClient, login: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    headers = login(PHONE)
    r = post_lead(client, headers, key="lead-key-0001")
    assert r.status_code == 201, r.text
    lead_id = r.json()["id"]
    assert r.json() == {"id": lead_id, "status": "new"}

    # Same key and body: the same answer, still one lead and one job.
    again = post_lead(client, headers, key="lead-key-0001")
    assert again.status_code == 201 and again.json() == r.json()
    conflict = post_lead(client, headers, key="lead-key-0001", remedy_id="rudrabhishek")
    assert conflict.status_code == 409

    async def check(db: Any) -> None:
        leads = (await db.execute(select(RemedyLead))).scalars().all()
        assert len(leads) == 1
        lead = leads[0]
        assert str(lead.id) == lead_id and lead.phone == PHONE and lead.language == "hi"
        assert lead.partner_id == "demo-partner" and lead.status == "new"
        assert lead.consent_at is not None and lead.notified_at is None
        assert lead.note_ciphertext is not None and NOTE.encode() not in lead.note_ciphertext
        cipher = cipher_from_settings(settings_of(client))
        sealed = Sealed(lead.note_ciphertext, lead.note_nonce, lead.note_key_id)
        assert cipher.decrypt(sealed, note_aad(lead.id)) == NOTE
        jobs = (await db.execute(select(Job))).scalars().all()
        assert [(j.kind, j.key, j.payload) for j in jobs] == [
            ("remedy_lead_notify", f"lead:{lead_id}:notify", {"lead_id": lead_id})
        ]
        audits = (
            (await db.execute(select(AuditLog).where(AuditLog.entity == "remedy_lead")))
            .scalars()
            .all()
        )
        assert [a.action for a in audits] == ["remedy_lead.create"]
        assert PHONE not in str(audits[0].detail) and NOTE not in str(audits[0].detail)

    run_db(client, check)
    assert PHONE not in caplog.text and NOTE not in caplog.text


def test_blank_note_is_not_stored(client: TestClient, login: Any) -> None:
    r = post_lead(client, login(PHONE), note="   ", preferred_date=None)
    assert r.status_code == 201

    async def check(db: Any) -> None:
        lead = (await db.execute(select(RemedyLead))).scalar_one()
        assert lead.note_ciphertext is None and lead.preferred_date is None

    run_db(client, check)


def test_leads_are_limited_per_user_per_day(client: TestClient, login: Any) -> None:
    headers = login(PHONE)
    for _ in range(5):
        assert post_lead(client, headers).status_code == 201
    r = post_lead(client, headers)
    assert r.status_code == 429 and r.json()["detail"]["code"] == "rate_limited"
    assert int(r.headers["Retry-After"]) > 0
    # Someone else is not affected.
    assert post_lead(client, login("+919812345679")).status_code == 201


def test_admin_lists_masked_leads_and_updates_status(
    client: TestClient, login: Any, admin_headers: dict[str, str]
) -> None:
    user = login(PHONE)
    first = post_lead(client, user).json()["id"]
    second = post_lead(client, user, remedy_id="puja-enquiry-call", note=None).json()["id"]

    assert client.get("/v1/admin/remedies/leads", headers=user).status_code == 403
    r = client.get("/v1/admin/remedies/leads", headers=admin_headers)
    assert r.status_code == 200
    assert PHONE not in r.text and NOTE not in r.text
    items = r.json()["items"]
    assert [i["id"] for i in items] == [second, first]
    row = items[1]
    assert row["phone_masked"] == "+91•••••45678"
    assert row["has_note"] is True and items[0]["has_note"] is False
    assert row["remedy_name"]["en"] == "Ganesh puja" and row["status"] == "new"

    page = client.get("/v1/admin/remedies/leads?limit=1", headers=admin_headers).json()
    assert [i["id"] for i in page["items"]] == [second] and page["next_cursor"]
    nxt = client.get(
        f"/v1/admin/remedies/leads?limit=1&cursor={page['next_cursor']}", headers=admin_headers
    ).json()
    assert [i["id"] for i in nxt["items"]] == [first] and nxt["next_cursor"] is None

    url = f"/v1/admin/remedies/leads/{first}"
    assert client.post(url, json={"status": "contacted"}, headers=user).status_code == 403
    assert client.post(url, json={"status": "new"}, headers=admin_headers).status_code == 422
    assert (
        client.post(url, json={"status": "closed", "note": "x" * 501}, headers=admin_headers)
    ).status_code == 422
    missing = f"/v1/admin/remedies/leads/{uuid.uuid4()}"
    assert client.post(missing, json={"status": "spam"}, headers=admin_headers).status_code == 404

    r = client.post(
        url, json={"status": "contacted", "note": "Partner called back"}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "contacted" and r.json()["admin_note"] == "Partner called back"
    assert PHONE not in r.text
    client.post(url, json={"status": "closed"}, headers=admin_headers)

    contacted = client.get("/v1/admin/remedies/leads?status=closed", headers=admin_headers)
    assert [i["id"] for i in contacted.json()["items"]] == [first]
    new = client.get("/v1/admin/remedies/leads?status=new", headers=admin_headers)
    assert [i["id"] for i in new.json()["items"]] == [second]
    bad = client.get("/v1/admin/remedies/leads?status=deleted", headers=admin_headers)
    assert bad.status_code == 422

    async def audits(db: Any) -> list[tuple[str, dict[str, Any]]]:
        rows = (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.action == "remedy_lead.status")
                .order_by(AuditLog.id)
            )
        ).scalars()
        return [(a.entity_id, a.detail) for a in rows]

    assert run_db(client, audits) == [
        (first, {"from_status": "new", "to_status": "contacted"}),
        (first, {"from_status": "contacted", "to_status": "closed"}),
    ]
