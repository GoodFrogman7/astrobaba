"""Consents (docs/api/trust.md §1): the legal registry, the consent state, acceptance with the
current version only, append-only records with hashed IP/device, and age_18 → is_adult."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import consent
from astro_api.models_privacy import Consent
from services.api.tests.privacy_support import USER_KINDS, accept, legal_version, run_db, user_id

pytestmark = pytest.mark.integration

PHONE = "+919811100001"


def test_legal_registry_is_public(client: TestClient) -> None:
    r = client.get("/v1/legal")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == consent.current_version()
    assert body["status"] == "draft_pending_legal_review"
    assert "privacy" in body["documents"]
    assert {p["id"] for p in body["processors"]} >= {"aws", "razorpay"}
    assert set(body) >= {"operator", "grievance_officer", "retention"}
    # Nulls the founder still has to fill are shown as "to be published".
    assert body["operator"]["legal_name"] == "to be published"
    assert body["grievance_officer"]["email"] == "to be published"


def test_state_then_accept_current_version(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(PHONE, consents=False)
    r = client.get("/v1/me/consents", headers=h)
    assert r.status_code == 200
    assert r.json() == {
        "version": consent.current_version(),
        "required": USER_KINDS,
        "missing": USER_KINDS,
        "accepted": [],
        "current": False,
    }
    assert client.get("/v1/me", headers=h).json()["is_adult_confirmed"] is False

    r = accept(client, h, ["age_18", "terms"])
    assert r.status_code == 200, r.text
    assert r.json()["current"] is False
    assert r.json()["missing"] == ["privacy"]
    assert {a["kind"] for a in r.json()["accepted"]} == {"age_18", "terms"}
    assert client.get("/v1/me", headers=h).json()["is_adult_confirmed"] is True

    r = accept(client, h, ["privacy"])
    assert r.json()["current"] is True
    assert r.json()["missing"] == []
    # Accepting again records nothing new (one row per kind and version).
    accept(client, h, USER_KINDS)
    uid = user_id(client, h)

    async def count(db: AsyncSession) -> int:
        rows = (await db.execute(select(Consent).where(Consent.user_id == uid))).scalars()
        return len(list(rows))

    assert run_db(client, count) == 3


def test_stale_or_unknown_versions_and_kinds_are_refused(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(PHONE, consents=False)
    r = accept(client, h, ["terms"], version="2001-01-01")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "consent_version_stale"
    assert r.json()["detail"]["version"] == legal_version(client)
    assert accept(client, h, ["marketing"]).status_code == 422
    assert accept(client, h, []).status_code == 422
    assert client.get("/v1/me/consents").status_code == 401


def test_ip_and_device_are_stored_as_hmac_only(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(PHONE, consents=False)
    assert accept(client, h, ["terms"]).status_code == 200
    uid = user_id(client, h)

    async def row(db: AsyncSession) -> Consent:
        return (await db.execute(select(Consent).where(Consent.user_id == uid))).scalar_one()

    c = run_db(client, row)
    settings = client.app.state.settings  # type: ignore[attr-defined]
    assert c.ip_hash == consent.hmac_hex(settings, "consent_ip", "testclient")
    assert "testclient" not in (c.ip_hash or "")
    assert c.version == consent.current_version()


def test_device_hash_comes_from_the_auth_session(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(PHONE, consents=False)
    uid = user_id(client, h)

    async def set_device(db: AsyncSession) -> None:
        await db.execute(
            text("UPDATE auth_sessions SET device_id = 'device-abc-123' WHERE user_id = :u"),
            {"u": uid},
        )
        await db.commit()

    run_db(client, set_device)
    accept(client, h, ["privacy"])

    async def row(db: AsyncSession) -> Consent:
        return (await db.execute(select(Consent).where(Consent.user_id == uid))).scalar_one()

    settings = client.app.state.settings  # type: ignore[attr-defined]
    assert run_db(client, row).device_hash == consent.hmac_hex(
        settings, "consent_device", "device-abc-123"
    )


def test_consents_are_append_only(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(PHONE, consents=False)
    accept(client, h, USER_KINDS)
    uid = user_id(client, h)

    for sql in (
        "UPDATE consents SET version = 'x' WHERE user_id = :u",
        "DELETE FROM consents WHERE user_id = :u",
    ):

        async def mutate(db: AsyncSession, sql: str = sql) -> None:
            await db.execute(text(sql), {"u": uid})
            await db.commit()

        with pytest.raises(DBAPIError, match="append-only"):
            run_db(client, mutate)


def test_astrologers_also_need_astrologer_terms(
    client: TestClient,
    login: Any,
    make_live: Any,
) -> None:
    headers, _, _ = make_live("+919811100002")
    r = client.get("/v1/me/consents", headers=headers)
    assert r.json()["required"] == [*USER_KINDS, "astrologer_terms"]
    assert r.json()["missing"] == []
    assert r.json()["current"] is True  # the login fixture accepted every kind


def test_astrologer_without_astrologer_terms_is_not_current(
    client: TestClient,
    make_live: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    headers, _, _ = make_live("+919811100003")
    # A newer policy version accepted for the user kinds only: astrologer_terms is missing.
    bumped = {**consent.policies(), "version": "2099-02-02"}
    monkeypatch.setattr(consent, "policies", lambda: bumped)
    accept(client, headers, USER_KINDS, version="2099-02-02")
    body = client.get("/v1/me/consents", headers=headers).json()
    assert body["required"] == [*USER_KINDS, "astrologer_terms"]
    assert body["missing"] == ["astrologer_terms"]
    assert body["current"] is False


def test_new_policy_version_asks_again(
    client: TestClient,
    login: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    h = login(PHONE)
    assert client.get("/v1/me/consents", headers=h).json()["current"] is True
    bumped = {**consent.policies(), "version": "2099-01-01"}
    monkeypatch.setattr(consent, "policies", lambda: bumped)
    body = client.get("/v1/me/consents", headers=h).json()
    assert body["version"] == "2099-01-01"
    assert body["missing"] == USER_KINDS
    assert body["current"] is False
    assert accept(client, h, USER_KINDS, version="2099-01-01").json()["current"] is True


def test_unknown_user_id_in_state_is_harmless(client: TestClient) -> None:
    # The state helper never fails for an id with no rows (used by the export builder).
    async def go(db: AsyncSession) -> dict[str, object]:
        return await consent.state(db, uuid.uuid4())

    assert run_db(client, go)["accepted"] == []
