"""KYC documents: type by magic bytes, size and count limits, deletion rules, private storage,
admin-only streaming with an audit entry."""

import hashlib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration

PDF = b"%PDF-1.7\n% sample\n"
JPEG = b"\xff\xd8\xff\xe0" + b"\x01" * 50
PNG = b"\x89PNG\r\n\x1a\n" + b"\x02" * 50
GIF = b"GIF89a" + b"\x00" * 50

APP = {
    "display_name": "Meera Iyer",
    "bio": "KP and Vedic astrologer, fifteen years of consultations.",
    "skills": ["kp"],
    "languages": ["ta", "en"],
    "gender": "female",
    "experience_years": 15,
    "requested_price_per_min_paise": 3000,
    "accepts_terms": True,
}


@pytest.fixture
def applicant(client: TestClient, login) -> dict[str, str]:  # type: ignore[no-untyped-def]
    headers: dict[str, str] = login("+919822220001")
    assert client.post("/v1/astrologer/application", json=APP, headers=headers).status_code == 201
    return headers


def upload(
    client: TestClient,
    headers: dict[str, str],
    data: bytes,
    kind: str = "identity",
    filename: str = "id.pdf",
    claimed: str = "application/pdf",
) -> Any:
    return client.post(
        "/v1/astrologer/me/documents",
        files={"file": (filename, data, claimed)},
        data={"kind": kind},
        headers=headers,
    )


@pytest.mark.parametrize(
    ("data", "content_type"),
    [(PDF, "application/pdf"), (JPEG, "image/jpeg"), (PNG, "image/png")],
)
def test_accepted_types_by_magic_bytes(
    client: TestClient, applicant: dict[str, str], data: bytes, content_type: str
) -> None:
    # The client's claimed type is ignored; the bytes decide.
    r = upload(client, applicant, data, claimed="text/plain")
    assert r.status_code == 201, r.text
    me = client.get("/v1/astrologer/me", headers=applicant).json()
    assert me["documents"][0]["size"] == len(data)


@pytest.mark.parametrize("data", [GIF, b"<html>not a pdf</html>", b"MZ\x90\x00 executable"])
def test_other_types_rejected_even_if_claimed_pdf(
    client: TestClient, applicant: dict[str, str], data: bytes
) -> None:
    r = upload(client, applicant, data, claimed="application/pdf")
    assert r.status_code == 415 and r.json()["detail"]["code"] == "unsupported_file_type"


def test_empty_and_oversized_files(client: TestClient, applicant: dict[str, str]) -> None:
    assert upload(client, applicant, b"").json()["detail"]["code"] == "empty_file"
    big = PDF + b"\x00" * (5 * 1024 * 1024)
    r = upload(client, applicant, big)
    assert r.status_code == 413 and r.json()["detail"]["code"] == "file_too_large"


def test_count_limit(client: TestClient, applicant: dict[str, str]) -> None:
    for _ in range(10):
        assert upload(client, applicant, PDF, kind="other").status_code == 201
    r = upload(client, applicant, PDF, kind="other")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many_documents"


def test_filename_sanitised_and_never_used_as_path(
    client: TestClient, applicant: dict[str, str], documents_dir: Path
) -> None:
    r = upload(client, applicant, PDF, filename="../../etc/passwd; rm -rf.pdf")
    assert r.status_code == 201
    assert r.json()["filename"] == "passwd_rm_-rf.pdf"
    stored = [p.name for p in documents_dir.iterdir()]
    assert all(len(name) == 32 and "passwd" not in name for name in stored)


def test_deletion_rules(client: TestClient, applicant: dict[str, str], admin_headers) -> None:  # type: ignore[no-untyped-def]
    ident = upload(client, applicant, PDF).json()
    qual = upload(client, applicant, PNG, kind="qualification").json()
    assert qual["astrologer_status"] == "kyc_submitted"
    # Removing a required document before review steps back to `applied`.
    r = client.delete(f"/v1/astrologer/me/documents/{qual['id']}", headers=applicant)
    assert r.status_code == 204
    assert client.get("/v1/astrologer/me", headers=applicant).json()["status"] == "applied"
    qual = upload(client, applicant, PNG, kind="qualification").json()
    aid = client.get("/v1/astrologer/me", headers=applicant).json()["id"]
    client.post(
        f"/v1/admin/astrologers/{aid}/verifications/identity",
        json={"status": "passed"},
        headers=admin_headers,
    )
    # Reviewed documents are locked.
    r = client.delete(f"/v1/astrologer/me/documents/{ident['id']}", headers=applicant)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"
    # Other people's documents do not exist for you.
    r = client.delete(
        "/v1/astrologer/me/documents/00000000-0000-0000-0000-000000000000", headers=applicant
    )
    assert r.status_code == 404


def test_admin_streams_content_and_audits(
    client: TestClient, applicant: dict[str, str], admin_headers: Any, login: Any
) -> None:
    doc = upload(client, applicant, JPEG, filename="aadhaar.jpg").json()
    aid = client.get("/v1/astrologer/me", headers=applicant).json()["id"]
    detail = client.get(f"/v1/admin/astrologers/{aid}", headers=admin_headers).json()
    url = detail["documents"][0]["content_url"]
    assert url == f"/v1/admin/documents/{doc['id']}/content"

    r = client.get(url, headers=admin_headers)
    assert r.status_code == 200
    assert r.content == JPEG
    assert hashlib.sha256(r.content).hexdigest() == hashlib.sha256(JPEG).hexdigest()
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["content-security-policy"].startswith("sandbox")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "aadhaar.jpg" in r.headers["content-disposition"]

    # Applicants (and anyone without the admin role) cannot read documents.
    assert client.get(url, headers=applicant).status_code == 403
    assert client.get(url).status_code == 401

    trail = client.get(f"/v1/admin/astrologers/{aid}", headers=admin_headers).json()["audit"]
    assert any(e["action"] == "kyc_document.view" for e in trail)


def test_uploads_locked_after_approval(client: TestClient, make_live) -> None:  # type: ignore[no-untyped-def]
    headers, _, _ = make_live("+919822220002")
    r = upload(client, headers, PDF, kind="other")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "locked"


def test_production_refuses_local_storage() -> None:
    from pydantic import SecretStr

    from astro_api.config import Settings, check_production_settings

    s = Settings(
        app_env="production",
        secret_key=SecretStr("x" * 40),
        sms_provider="msg91",
        documents_backend="local",
    )
    with pytest.raises(RuntimeError, match="DOCUMENTS_BACKEND=local"):
        check_production_settings(s)
