"""Consent enforcement matrix (docs/api/trust.md §1). Written before the endpoints were wired.

Every endpoint that moves money or starts a consultation needs the current user consents;
astrologer portal writes need `astrologer_terms`. Without them: `403 consent_required` with the
missing kinds. After accepting: the endpoint behaves exactly as before (never consent_required).
"""

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from astro_api import consent
from services.api.tests.privacy_support import USER_KINDS, accept, idem

pytestmark = pytest.mark.integration

PHONE = "+919822200001"


@pytest.fixture(autouse=True)
def ai_assistant_on(monkeypatch: pytest.MonkeyPatch) -> None:
    # The AI router is 404 while its flag is off; enforcement is checked with it on.
    monkeypatch.setenv("FLAG_AI_ASSISTANT", "true")


Call = Callable[[TestClient, dict[str, str]], Any]


def _lead_body() -> dict[str, Any]:
    day = (dt.datetime.now(dt.UTC) + dt.timedelta(days=2)).date().isoformat()
    return {"remedy_id": "ganesh-puja", "preferred_date": day, "language": "hi", "consent": True}


USER_ENDPOINTS: dict[str, tuple[Call, int | None]] = {
    # name: (call, status expected once consent is given; None = anything but consent_required)
    "recharge_order": (
        lambda c, h: c.post(
            "/v1/wallet/recharge-orders", json={"amount_paise": 50000}, headers=idem(h)
        ),
        201,
    ),
    "report_order": (
        lambda c, h: c.post(
            "/v1/reports/orders",
            json={
                "sku": "kundli_report",
                "language": "en",
                "kundli_ids": [str(uuid.uuid4())],
                "pay_with": "wallet",
            },
            headers=idem(h),
        ),
        None,
    ),
    "session_create": (
        lambda c, h: c.post(
            "/v1/sessions", json={"astrologer_id": str(uuid.uuid4())}, headers=idem(h)
        ),
        None,
    ),
    "ai_question": (
        lambda c, h: c.post(
            f"/v1/ai/conversations/{uuid.uuid4()}/questions", json={"text": "hi"}, headers=idem(h)
        ),
        None,
    ),
    "remedy_lead": (
        lambda c, h: c.post("/v1/remedies/leads", json=_lead_body(), headers=idem(h)),
        201,
    ),
}

ASTROLOGER_ENDPOINTS: dict[str, Call] = {
    "presence": lambda c, h: c.post(
        "/v1/astrologer/me/presence", json={"status": "online"}, headers=h
    ),
    "availability": lambda c, h: c.put(
        "/v1/astrologer/me/availability", json={"slots": []}, headers=h
    ),
    "consult_settings": lambda c, h: c.patch("/v1/astrologer/me/consult", json={}, headers=h),
    "session_accept": lambda c, h: c.post(f"/v1/sessions/{uuid.uuid4()}/accept", headers=h),
}


def _refused(r: Any, missing: list[str]) -> None:
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "consent_required"
    assert detail["missing"] == missing
    assert detail["version"] == consent.current_version()


def _not_refused(r: Any, expected: int | None) -> None:
    if expected is not None:
        assert r.status_code == expected, r.text
    detail = r.json().get("detail") if r.status_code >= 400 else None
    assert not (isinstance(detail, dict) and detail.get("code") == "consent_required"), r.text


@pytest.mark.parametrize("name", sorted(USER_ENDPOINTS))
def test_user_endpoints_need_current_consents(client: TestClient, login, name: str) -> None:  # type: ignore[no-untyped-def]
    call, expected = USER_ENDPOINTS[name]
    h = login(PHONE, consents=False)
    _refused(call(client, h), USER_KINDS)
    accept(client, h, ["age_18"])
    _refused(call(client, h), ["terms", "privacy"])
    accept(client, h, ["terms", "privacy"])
    _not_refused(call(client, h), expected)


@pytest.mark.parametrize("name", sorted(ASTROLOGER_ENDPOINTS))
def test_astrologer_writes_need_astrologer_terms(client: TestClient, login, name: str) -> None:  # type: ignore[no-untyped-def]
    call = ASTROLOGER_ENDPOINTS[name]
    h = login(PHONE, consents=False)
    accept(client, h, USER_KINDS)  # user consents alone are not enough
    _refused(call(client, h), ["astrologer_terms"])
    accept(client, h, ["astrologer_terms"])
    _not_refused(call(client, h), None)


def test_live_astrologer_presence_works_after_consent(
    client: TestClient,
    login: Any,
    make_live: Any,
) -> None:
    headers, _, _ = make_live("+919822200002")
    # A fresh session for the same astrologer, consents as the fixture left them (all current).
    r = client.post("/v1/astrologer/me/presence", json={"status": "online"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["presence"] == "online"


@pytest.mark.parametrize("name", sorted(USER_ENDPOINTS))
def test_new_policy_version_blocks_until_accepted_again(
    client: TestClient,
    login: Any,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    call, expected = USER_ENDPOINTS[name]
    h = login(PHONE)
    bumped = {**consent.policies(), "version": "2099-01-01"}
    monkeypatch.setattr(consent, "policies", lambda: bumped)
    _refused(call(client, h), USER_KINDS)
    accept(client, h, USER_KINDS, version="2099-01-01")
    _not_refused(call(client, h), expected)


def test_signed_out_is_401_not_403(client: TestClient) -> None:
    for name in sorted(USER_ENDPOINTS):
        assert USER_ENDPOINTS[name][0](client, {}).status_code == 401, name
    for name in sorted(ASTROLOGER_ENDPOINTS):
        assert ASTROLOGER_ENDPOINTS[name](client, {}).status_code == 401, name


def test_free_tools_browsing_and_reads_need_no_consent(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    h = login(PHONE, consents=False)
    for path in (
        "/v1/me",
        "/v1/wallet",
        "/v1/sessions",
        "/v1/reports",
        "/v1/remedies",
        "/v1/legal",
    ):
        r = client.get(path, headers=h)
        assert r.status_code != 403, (path, r.text)
