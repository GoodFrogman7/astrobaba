"""Supply readiness (docs/api/growth.md §2.2): live = approved, public and not demo; pipeline,
steps passed, language/skill coverage, the IST schedule matrix and invite counts."""

import asyncio
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import growth_api as g
from services.api.tests.conftest import application

pytestmark = pytest.mark.integration

SUPPLY = "/v1/admin/growth/supply"


def sql(client: TestClient, query: str, **params: Any) -> None:
    async def run() -> None:
        url = client.app.state.settings.database_url.get_secret_value()  # type: ignore[attr-defined]
        eng = create_async_engine(url)
        try:
            async with eng.begin() as conn:
                await conn.execute(text(query), params)
        finally:
            await eng.dispose()

    asyncio.run(run())


def test_schedule_matrix_unit() -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    hours = g.schedule_hours(
        [
            (a, 0, 9 * 60, 11 * 60),  # Monday 09:00-11:00 → hours 9, 10
            (b, 0, 10 * 60 + 30, 10 * 60 + 45),  # inside hour 10
            (a, 6, 23 * 60, 24 * 60),  # Sunday 23:00-24:00
            (b, 2, 0, 15),
        ]
    )
    assert len(hours) == 7 and all(len(row) == 24 for row in hours)
    assert hours[0][8:12] == [0, 1, 2, 0]
    assert hours[6][23] == 1 and hours[2][0] == 1
    assert sum(map(sum, hours)) == 5
    core = {"weekdays": [0, 1, 2, 3, 4, 5, 6], "from_hour": 9, "to_hour": 23}
    assert g.uncovered_hours(hours, core) == 7 * 14 - 2
    assert g.uncovered_hours(hours, {"weekdays": [0], "from_hour": 9, "to_hour": 11}) == 0


def test_supply_readiness(
    client: TestClient, admin_headers: dict[str, str], login: Any, make_live: Any
) -> None:
    # Two approved astrologers (probation passed), one still on probation, one applicant.
    approved = []
    for phone, langs, skills in (
        ("+919866660001", ["hi", "en"], ["vedic", "numerology"]),
        ("+919866660002", ["hi"], ["tarot"]),
    ):
        headers, aid, _ = make_live(phone, languages=langs, skills=skills)
        r = client.post(
            f"/v1/admin/astrologers/{aid}/verifications/probation",
            json={"status": "passed"},
            headers=admin_headers,
        )
        assert r.status_code == 200 and r.json()["status"] == "approved", r.text
        approved.append((headers, aid))
    make_live("+919866660003", languages=["en"], skills=["vedic"])
    applicant = login("+919866660004")
    assert (
        client.post("/v1/astrologer/application", json=application(), headers=applicant).status_code
        == 201
    )
    # A demo (seed) astrologer is never counted, even when approved and public.
    _, demo_id = make_live("+919866660005")[:2]
    sql(
        client,
        "UPDATE astrologers SET status = 'approved', is_seed = true WHERE id = :i",
        i=demo_id,
    )
    # Hidden from the directory: approved but not public, so not live.
    headers3, hidden = make_live("+919866660006", languages=["en"])[:2]
    sql(
        client,
        "UPDATE astrologers SET status = 'approved', "
        "flags = flags || '{\"show_in_directory\": false}' WHERE id = :i",
        i=hidden,
    )

    first, second = approved
    r = client.put(
        "/v1/astrologer/me/availability",
        json={"slots": [{"weekday": 0, "start": "09:00", "end": "11:30"}]},
        headers=first[0],
    )
    assert r.status_code == 200, r.text
    r = client.put(
        "/v1/astrologer/me/availability",
        json={
            "slots": [
                {"weekday": 0, "start": "10:00", "end": "10:15"},
                {"weekday": 6, "start": "22:00", "end": "24:00"},
            ]
        },
        headers=second[0],
    )
    assert r.status_code == 200, r.text
    # Schedules of non-live astrologers are ignored.
    client.put(
        "/v1/astrologer/me/availability",
        json={"slots": [{"weekday": 3, "start": "12:00", "end": "13:00"}]},
        headers=headers3,
    )

    open_inv = client.post("/v1/admin/astrologer-invites", json={}, headers=admin_headers).json()
    revoked = client.post("/v1/admin/astrologer-invites", json={}, headers=admin_headers).json()
    client.post(f"/v1/admin/astrologer-invites/{revoked['id']}/revoke", headers=admin_headers)
    assert open_inv["id"]

    r = client.get(SUPPLY, headers=admin_headers)
    assert r.status_code == 200, r.text
    s = r.json()
    assert set(s) == {
        "target",
        "live",
        "pipeline",
        "steps_passed",
        "languages",
        "skills",
        "schedule",
        "invites",
    }
    assert s["target"] == {"min": 30, "max": 50}
    assert s["live"] == 2
    assert s["pipeline"] == {
        "applied": 1,
        "kyc_submitted": 0,
        "interview": 0,
        "probation": 1,
        "approved": 3,
        "suspended": 0,
        "rejected": 0,
    }
    assert s["steps_passed"] == {"identity": 4, "qualification": 4, "interview": 4, "probation": 2}
    assert s["languages"] == [
        {"id": "hi", "live": 2, "target_min": 15},
        {"id": "en", "live": 1, "target_min": 15},
    ]
    assert s["skills"] == [{"id": "vedic", "live": 1, "target_min": 20}]
    hours = s["schedule"]["hours"]
    assert len(hours) == 7 and all(len(row) == 24 for row in hours)
    assert hours[0][8:12] == [0, 1, 2, 1]
    assert hours[6][22:24] == [1, 1]
    assert hours[3][12] == 0
    assert sum(map(sum, hours)) == 6
    # Core hours 09-23 every day = 98 cells; Monday 9, 10, 11 and Sunday 22 are covered.
    assert s["schedule"]["uncovered_hours"] == 98 - 4
    assert s["invites"] == {"open": 1, "used": 0, "expired": 0, "revoked": 1}

    assert client.get(SUPPLY, headers=login("+919866660009")).status_code == 403
