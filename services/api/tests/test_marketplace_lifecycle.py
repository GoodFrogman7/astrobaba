"""Astrologer lifecycle: application → KYC → verification → probation → approved, plus
suspension, rejection, illegal transitions and admin role checks."""

from typing import Any

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


@pytest.fixture
def app_body():  # type: ignore[no-untyped-def]
    def body(**overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "display_name": "Asha Verma",
            "bio": "Vedic astrologer with a calm, practical approach to chart reading.",
            "skills": ["vedic", "numerology"],
            "languages": ["hi", "en"],
            "gender": "female",
            "experience_years": 12,
            "requested_price_per_min_paise": 2500,
            "accepts_terms": True,
        }
        base.update(overrides)
        return base

    return body


PDF = b"%PDF-1.4\n% test document\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def upload(client: TestClient, headers: dict[str, str], kind: str, data: bytes = PDF) -> Any:
    return client.post(
        "/v1/astrologer/me/documents",
        files={"file": ("doc.pdf", data, "application/pdf")},
        data={"kind": kind},
        headers=headers,
    )


def verify(
    client: TestClient, admin: dict[str, str], aid: str, step: str, status: str = "passed"
) -> Any:
    return client.post(
        f"/v1/admin/astrologers/{aid}/verifications/{step}",
        json={"status": status, "note": "checked"},
        headers=admin,
    )


def test_full_lifecycle(client: TestClient, login, admin_headers, app_body) -> None:  # type: ignore[no-untyped-def]
    me = login("+919811110001")
    r = client.post("/v1/astrologer/application", json=app_body(), headers=me)
    assert r.status_code == 201, r.text
    body = r.json()
    aid, slug = body["id"], body["slug"]
    assert slug == "asha-verma" and body["status"] == "applied"
    assert [v["step"] for v in body["verifications"]] == [
        "identity",
        "qualification",
        "interview",
        "probation",
    ]
    assert client.get(f"/v1/astrologers/{slug}").status_code == 404

    assert upload(client, me, "identity").json()["astrologer_status"] == "applied"
    assert upload(client, me, "qualification", PNG).json()["astrologer_status"] == "kyc_submitted"

    assert verify(client, admin_headers, aid, "identity").json()["status"] == "kyc_submitted"
    assert verify(client, admin_headers, aid, "qualification").json()["status"] == "interview"
    detail = client.get(f"/v1/admin/astrologers/{aid}", headers=admin_headers).json()
    assert {d["review_status"] for d in detail["documents"]} == {"accepted"}
    assert verify(client, admin_headers, aid, "interview").json()["status"] == "interview"

    r = client.post(
        f"/v1/admin/astrologers/{aid}/approve",
        json={"tier": "rising", "price_per_min_paise": 2000},
        headers=admin_headers,
    )
    assert r.status_code == 200 and r.json()["status"] == "probation"
    profile = client.get(f"/v1/astrologers/{slug}").json()
    assert profile["price_per_min_paise"] == 2000 and profile["tier"] == "rising"
    assert profile["is_demo"] is False

    assert verify(client, admin_headers, aid, "probation").json()["status"] == "approved"
    assert client.get(f"/v1/astrologers/{slug}").status_code == 200

    r = client.post(
        f"/v1/admin/astrologers/{aid}/suspend", json={"reason": "complaint"}, headers=admin_headers
    )
    assert r.json()["status"] == "suspended"
    assert client.get(f"/v1/astrologers/{slug}").status_code == 404
    r = client.post(f"/v1/admin/astrologers/{aid}/reinstate", headers=admin_headers)
    assert r.json()["status"] == "approved"
    assert client.get(f"/v1/astrologers/{slug}").status_code == 200

    r = client.post(
        f"/v1/admin/astrologers/{aid}/reject", json={"reason": "fraud found"}, headers=admin_headers
    )
    assert r.json()["status"] == "rejected"
    assert client.get(f"/v1/astrologers/{slug}").status_code == 404

    actions = [e["action"] for e in r.json()["audit"]]
    for expected in (
        "astrologer.apply",
        "kyc_document.upload",
        "astrologer.verify.identity",
        "astrologer.approve",
        "astrologer.suspend",
        "astrologer.reinstate",
        "astrologer.reject",
    ):
        assert expected in actions
    assert "+91" in r.json()["phone"] and "•" in r.json()["phone"]


def test_illegal_transitions(client: TestClient, login, admin_headers, app_body) -> None:  # type: ignore[no-untyped-def]
    me = login("+919811110002")
    aid = client.post("/v1/astrologer/application", json=app_body(), headers=me).json()["id"]

    # Nothing can be verified before the documents are in.
    assert verify(client, admin_headers, aid, "identity").json()["detail"]["code"] == (
        "invalid_transition"
    )
    upload(client, me, "identity")
    upload(client, me, "qualification")
    # Steps run in order.
    r = verify(client, admin_headers, aid, "qualification")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "out_of_order"
    r = verify(client, admin_headers, aid, "interview")
    assert r.json()["detail"]["code"] == "out_of_order"
    # Approval needs the interview.
    r = client.post(
        f"/v1/admin/astrologers/{aid}/approve",
        json={"tier": "rising", "price_per_min_paise": 2000},
        headers=admin_headers,
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_ready"
    verify(client, admin_headers, aid, "identity")
    verify(client, admin_headers, aid, "qualification")
    # The applicant can no longer edit once interviews start.
    r = client.patch("/v1/astrologer/me", json={"bio": "x" * 30}, headers=me)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"
    verify(client, admin_headers, aid, "interview")
    # Price must sit inside the tier.
    r = client.post(
        f"/v1/admin/astrologers/{aid}/approve",
        json={"tier": "rising", "price_per_min_paise": 9000},
        headers=admin_headers,
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "price_out_of_range"
    r = client.post(
        f"/v1/admin/astrologers/{aid}/approve",
        json={"tier": "galactic", "price_per_min_paise": 2000},
        headers=admin_headers,
    )
    assert r.status_code == 422
    # Only live astrologers can be suspended; only suspended ones reinstated.
    r = client.post(
        f"/v1/admin/astrologers/{aid}/suspend", json={"reason": "test"}, headers=admin_headers
    )
    assert r.json()["detail"]["code"] == "invalid_transition"
    r = client.post(f"/v1/admin/astrologers/{aid}/reinstate", headers=admin_headers)
    assert r.json()["detail"]["code"] == "invalid_transition"
    # Tier/price changes need an approval first.
    r = client.patch(
        f"/v1/admin/astrologers/{aid}",
        json={"price_per_min_paise": 2500},
        headers=admin_headers,
    )
    assert r.json()["detail"]["code"] == "not_approved"


def test_failed_probation_rejects(client: TestClient, make_live, admin_headers) -> None:  # type: ignore[no-untyped-def]
    _, aid, slug = make_live("+919811110003")
    assert client.get(f"/v1/astrologers/{slug}").status_code == 200
    assert verify(client, admin_headers, aid, "probation", "failed").json()["status"] == "rejected"
    assert client.get(f"/v1/astrologers/{slug}").status_code == 404


def test_application_validation(client: TestClient, login, app_body) -> None:  # type: ignore[no-untyped-def]
    me = login("+919811110004")
    r = client.post("/v1/astrologer/application", json=app_body(accepts_terms=False), headers=me)
    assert r.json()["detail"]["code"] == "terms_required"
    r = client.post("/v1/astrologer/application", json=app_body(skills=["alchemy"]), headers=me)
    assert r.status_code == 422 and r.json()["detail"]["invalid"] == ["alchemy"]
    r = client.post("/v1/astrologer/application", json=app_body(languages=["xx"]), headers=me)
    assert r.status_code == 422
    r = client.post(
        "/v1/astrologer/application",
        json=app_body(requested_price_per_min_paise=10),
        headers=me,
    )
    assert r.json()["detail"]["code"] == "price_out_of_range"
    assert client.post("/v1/astrologer/application", json=app_body(), headers=me).status_code == 201
    r = client.post("/v1/astrologer/application", json=app_body(), headers=me)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_applied"
    assert client.get("/v1/astrologer/me").status_code == 401
    other = login("+919811110005")
    assert client.get("/v1/astrologer/me", headers=other).json()["detail"]["code"] == "not_applied"


def test_slugs_are_unique_and_ascii(client: TestClient, login, app_body) -> None:  # type: ignore[no-untyped-def]
    slugs = []
    for n, name in enumerate(("Asha Verma", "Asha  Verma!", "आशा वर्मा", "Ásha Vérma")):
        me = login(f"+91981111010{n}")
        r = client.post("/v1/astrologer/application", json=app_body(display_name=name), headers=me)
        slugs.append(r.json()["slug"])
    assert slugs == ["asha-verma", "asha-verma-2", "astrologer", "asha-verma-3"]


def test_patch_while_applied_updates_slug(client: TestClient, login, app_body) -> None:  # type: ignore[no-untyped-def]
    me = login("+919811110011")
    client.post("/v1/astrologer/application", json=app_body(), headers=me)
    r = client.patch(
        "/v1/astrologer/me",
        json={"display_name": "Ravi Shankar", "skills": ["tarot"], "bio_hi": "नमस्ते"},
        headers=me,
    )
    assert r.status_code == 200
    assert (r.json()["slug"], r.json()["skills"], r.json()["bio_hi"]) == (
        "ravi-shankar",
        ["tarot"],
        "नमस्ते",
    )


def test_admin_endpoints_need_admin_role(client: TestClient, login, make_live) -> None:  # type: ignore[no-untyped-def]
    _, aid, _ = make_live("+919811110012")
    member = login("+919811110013")
    for method, path in (
        ("get", "/v1/admin/astrologers"),
        ("get", f"/v1/admin/astrologers/{aid}"),
        ("get", "/v1/admin/reviews"),
        ("post", f"/v1/admin/astrologers/{aid}/reinstate"),
    ):
        assert getattr(client, method)(path).status_code == 401
        r = getattr(client, method)(path, headers=member)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "forbidden"


def test_admin_list_filters_and_flags(
    client: TestClient,
    make_live: Any,
    login: Any,
    admin_headers: Any,
    app_body: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The public profile offers calls only when the voice_calls flag is on too.
    monkeypatch.setenv("FLAG_VOICE_CALLS", "true")
    _, live_id, slug = make_live("+919811110014", display_name="Live One")
    applicant = login("+919811110015")
    client.post(
        "/v1/astrologer/application", json=app_body(display_name="Waiting Two"), headers=applicant
    )
    r = client.get("/v1/admin/astrologers", params={"status": "applied"}, headers=admin_headers)
    assert [i["display_name"] for i in r.json()["items"]] == ["Waiting Two"]
    r = client.get("/v1/admin/astrologers", params={"q": "live"}, headers=admin_headers)
    assert r.json()["total"] == 1 and r.json()["items"][0]["verifications"]["interview"] == "passed"
    assert (
        client.get("/v1/admin/astrologers", params={"status": "x"}, headers=admin_headers).json()[
            "detail"
        ]["code"]
        == "invalid_filter"
    )
    # Per-astrologer flags: hiding from the directory hides the profile everywhere.
    r = client.patch(
        f"/v1/admin/astrologers/{live_id}",
        json={"flags": {"show_in_directory": False, "call_enabled": True}},
        headers=admin_headers,
    )
    assert r.json()["flags"] == {
        "chat_enabled": True,
        "call_enabled": True,
        "show_in_directory": False,
    }
    assert client.get(f"/v1/astrologers/{slug}").status_code == 404
    r = client.patch(
        f"/v1/admin/astrologers/{live_id}",
        json={
            "flags": {"show_in_directory": True},
            "tier": "top_choice",
            "price_per_min_paise": 5000,
        },
        headers=admin_headers,
    )
    profile = client.get(f"/v1/astrologers/{slug}").json()
    assert (
        profile["tier"],
        profile["price_per_min_paise"],
        profile["consult"]["call_enabled"],
    ) == (
        "top_choice",
        5000,
        True,
    )


def test_me_reports_roles_and_astrologer(
    client: TestClient, login: Any, make_live: Any, admin_headers: Any
) -> None:
    headers, aid, slug = make_live("+919811110016")
    me = client.get("/v1/me", headers=headers).json()
    assert me["roles"] == [] and me["astrologer"] == {
        "id": aid,
        "status": "probation",
        "slug": slug,
    }
    assert client.get("/v1/me", headers=admin_headers).json()["roles"] == ["admin"]
