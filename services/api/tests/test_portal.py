"""Astrologer portal (docs/api/portal.md §2): availability schedule, consultation settings and
the astrologer's own review list. Earnings and payouts: test_earnings.py, test_payouts.py."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.models import AuditLog
from services.api.tests.test_payouts_support import ASTRO_A, run_db

pytestmark = pytest.mark.integration

ASTRO = "+919866660100"
CLIENT = "+919866660001"


@pytest.fixture
def live(make_live: Any, login: Any) -> tuple[dict[str, str], str, str]:
    headers, aid, slug = make_live(ASTRO)
    login(CLIENT)
    return headers, aid, slug


def put(client: TestClient, headers: dict[str, str], slots: list[dict[str, Any]]) -> Any:
    return client.put("/v1/astrologer/me/availability", json={"slots": slots}, headers=headers)


def slot(weekday: int, start: str, end: str) -> dict[str, Any]:
    return {"weekday": weekday, "start": start, "end": end}


# ---------------------------------------------------------------- availability


def test_availability_roundtrip_and_public_profile(client: TestClient, live: Any) -> None:
    headers, _, slug = live
    r = client.get("/v1/astrologer/me/availability", headers=headers)
    assert r.json() == {"timezone": "Asia/Kolkata", "slots": []}
    assert client.get(f"/v1/astrologers/{slug}").json()["availability"] == {
        "timezone": "Asia/Kolkata",
        "slots": [],
    }

    # An overnight shift is two slots; "24:00" ends a day.
    slots = [slot(6, "22:00", "24:00"), slot(0, "00:00", "02:00"), slot(0, "09:15", "13:45")]
    r = put(client, headers, slots)
    assert r.status_code == 200, r.text
    expected = {
        "timezone": "Asia/Kolkata",
        "slots": [slot(0, "00:00", "02:00"), slot(0, "09:15", "13:45"), slot(6, "22:00", "24:00")],
    }
    assert r.json() == expected
    assert client.get("/v1/astrologer/me/availability", headers=headers).json() == expected
    assert client.get(f"/v1/astrologers/{slug}").json()["availability"] == expected

    # PUT replaces everything; touching slots end to end is not an overlap.
    r = put(client, headers, [slot(2, "10:00", "11:00"), slot(2, "11:00", "12:00")])
    assert r.status_code == 200 and len(r.json()["slots"]) == 2
    assert put(client, headers, []).json()["slots"] == []


@pytest.mark.parametrize(
    ("slots", "index"),
    [
        ([slot(0, "09:00", "10:00"), slot(7, "09:00", "10:00")], 1),
        ([slot(-1, "09:00", "10:00")], 0),
        ([slot(0, "09:10", "10:00")], 0),
        ([slot(0, "09:00", "10:05")], 0),
        ([slot(0, "10:00", "10:00")], 0),
        ([slot(0, "11:00", "10:00")], 0),
        ([slot(0, "24:00", "24:00")], 0),
        ([slot(0, "9:00", "10:00")], 0),
        ([slot(0, "09:00", "24:15")], 0),
        ([slot(0, "25:00", "26:00")], 0),
        ([slot(0, "ab:cd", "10:00")], 0),
        ([slot(3, "09:00", "12:00"), slot(1, "08:00", "09:00"), slot(3, "11:45", "13:00")], 2),
        ([slot(3, "09:00", "12:00"), slot(3, "10:00", "11:00")], 1),
    ],
)
def test_invalid_slots(
    client: TestClient, live: Any, slots: list[dict[str, Any]], index: int
) -> None:
    headers, _, _ = live
    put(client, headers, [slot(4, "09:00", "10:00")])
    r = put(client, headers, slots)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_slots" and detail["index"] == index
    # Nothing was replaced.
    kept = client.get("/v1/astrologer/me/availability", headers=headers).json()["slots"]
    assert kept == [slot(4, "09:00", "10:00")]


def test_at_most_21_slots(client: TestClient, live: Any) -> None:
    headers, _, _ = live
    many = [slot(d, f"{h:02d}:00", f"{h:02d}:30") for d in range(7) for h in (8, 10, 12)]
    assert len(many) == 21
    assert put(client, headers, many).status_code == 200
    r = put(client, headers, [*many, slot(0, "20:00", "21:00")])
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_slots"
    assert r.json()["detail"]["index"] == 21


def test_portal_needs_an_application(client: TestClient, login: Any) -> None:
    me = login(CLIENT)
    for method, path in (
        ("get", "availability"),
        ("get", "consult"),
        ("get", "reviews"),
    ):
        r = getattr(client, method)(f"/v1/astrologer/me/{path}", headers=me)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "not_applied"
    assert put(client, me, []).status_code == 404
    assert client.get("/v1/astrologer/me/availability").status_code == 401


# ---------------------------------------------------------------- consultation settings


def test_consult_settings(client: TestClient, live: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    headers, aid, slug = live
    monkeypatch.setenv("FLAG_VOICE_CALLS", "false")
    r = client.get("/v1/astrologer/me/consult", headers=headers)
    assert r.json() == {"chat_enabled": True, "call_enabled": False, "voice_calls_available": False}

    r = client.patch("/v1/astrologer/me/consult", json={"call_enabled": True}, headers=headers)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "call_unavailable"
    r = client.patch("/v1/astrologer/me/consult", json={"chat_enabled": False}, headers=headers)
    assert r.status_code == 200
    assert r.json() == {
        "chat_enabled": False,
        "call_enabled": False,
        "voice_calls_available": False,
    }
    assert client.get(f"/v1/astrologers/{slug}").json()["consult"]["chat_enabled"] is False

    monkeypatch.setenv("FLAG_VOICE_CALLS", "true")
    r = client.patch(
        "/v1/astrologer/me/consult",
        json={"call_enabled": True, "chat_enabled": True},
        headers=headers,
    )
    assert r.json() == {"chat_enabled": True, "call_enabled": True, "voice_calls_available": True}
    assert client.get(f"/v1/astrologers/{slug}").json()["consult"]["call_enabled"] is True
    # Other flags are untouched.
    me = client.get("/v1/astrologer/me", headers=headers).json()
    assert me["flags"]["show_in_directory"] is True
    # With the flag off, the public profile never offers calls, whatever the setting.
    monkeypatch.setenv("FLAG_VOICE_CALLS", "false")
    assert client.get(f"/v1/astrologers/{slug}").json()["consult"]["call_enabled"] is False
    # Turning calls off is always allowed, even with the flag off.
    r = client.patch("/v1/astrologer/me/consult", json={"call_enabled": False}, headers=headers)
    assert r.status_code == 200 and r.json()["call_enabled"] is False
    assert (
        client.patch(
            "/v1/astrologer/me/consult", json={"chat_enabled": "yes"}, headers=headers
        ).status_code
        == 422
    )

    async def audits(db: AsyncSession) -> list[AuditLog]:
        rows = await db.execute(
            select(AuditLog).where(AuditLog.action == "astrologer.consult").order_by(AuditLog.id)
        )
        return list(rows.scalars())

    settings = client.app.state.settings  # type: ignore[attr-defined]
    rows = run_db(settings, audits)
    assert len(rows) == 3
    assert rows[0].entity_id == aid and rows[0].detail == {"chat_enabled": False}
    assert rows[1].detail == {"chat_enabled": True, "call_enabled": True}
    for row in rows:
        assert ASTRO not in str(row.detail) and ASTRO_A not in str(row.detail)


# ---------------------------------------------------------------- reviews


def test_own_reviews(
    client: TestClient, live: Any, login: Any, consult: Any, admin_headers: dict[str, str]
) -> None:
    headers, aid, _ = live
    me = login(CLIENT)

    def review(text: str, rating: int = 5) -> str:
        sid = consult(CLIENT, aid)
        r = client.post(
            f"/v1/consult-sessions/{sid}/review",
            json={"rating": rating, "text": text},
            headers=me,
        )
        assert r.status_code == 201, r.text
        return str(r.json()["id"])

    published = review("Clear and kind.")
    held = review("Call me on 98765 43210 for a cheaper reading", rating=2)
    hidden = review("Fine.")
    replied = review("Very helpful.", rating=4)
    r = client.post(
        f"/v1/admin/reviews/{hidden}/hide", json={"reason": "spam"}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    r = client.post(f"/v1/reviews/{replied}/reply", json={"text": "Thank you."}, headers=headers)
    assert r.status_code == 200

    body = client.get("/v1/astrologer/me/reviews", headers=headers).json()
    items = {i["id"]: i for i in body["items"]}
    assert set(items) == {published, held, replied}  # hidden (removed) is never listed
    assert items[published]["status"] == "published" and items[published]["session_id"]
    assert items[held]["status"] == "held"
    # Held text may hold contact details: the astrologer sees the rating, not the text.
    assert items[held]["text"] is None and items[held]["rating"] == 2
    assert items[replied]["reply"]["text"] == "Thank you."
    for item in body["items"]:
        assert item["author_label"] == "Verified client"
        assert "user_id" not in item
    assert "+91" not in str(body) and "98765" not in str(body)

    unreplied = client.get(
        "/v1/astrologer/me/reviews", params={"filter": "unreplied"}, headers=headers
    ).json()
    assert {i["id"] for i in unreplied["items"]} == {published, held}

    page = client.get("/v1/astrologer/me/reviews", params={"limit": 2}, headers=headers).json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    rest = client.get(
        "/v1/astrologer/me/reviews",
        params={"limit": 2, "cursor": page["next_cursor"]},
        headers=headers,
    ).json()
    assert len(rest["items"]) == 1 and rest["next_cursor"] is None
    bad = client.get("/v1/astrologer/me/reviews", params={"filter": "x"}, headers=headers)
    assert bad.status_code == 422
