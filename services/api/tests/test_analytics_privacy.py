"""Analytics in the DPDP rights (docs/api/growth.md §1.2): the export lists the events recorded
with the user's id; executing a deletion removes them and every event of an anonymous id that
was ever linked to the user, and leaves other visitors' events alone."""

import datetime as dt
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import privacy
from astro_api.models import AuditLog
from astro_api.models_analytics import AnalyticsEvent
from services.api.tests.privacy_support import run_db

pytestmark = pytest.mark.integration

URL = "/v1/analytics/events"
PHONE = "+919866600001"
OTHER_PHONE = "+919866600002"


def iso(at: dt.datetime) -> str:
    return at.isoformat().replace("+00:00", "Z")


def envelope(anon: str, event: str, at: dt.datetime, **properties: Any) -> dict[str, Any]:
    return {
        "event": event,
        "ts": iso(at),
        "anonymous_id": anon,
        "user_id": None,
        "locale": "en",
        "schema_version": 2,
        "properties": properties,
    }


def send(client: TestClient, events: list[dict[str, Any]], headers: Any = None) -> None:
    r = client.post(URL, json={"events": events}, headers=headers or {})
    assert r.status_code == 202 and r.json()["rejected"] == 0, r.text


def world(client: TestClient, login: Any) -> tuple[dict[str, str], uuid.UUID, dt.datetime]:
    """The user browsed as `anon_mine_*` before and after signing in on two browsers; another
    visitor and another user have their own events."""
    h = login(PHONE)
    other = login(OTHER_PHONE)
    uid = uuid.UUID(client.get("/v1/me", headers=h).json()["id"])
    t = dt.datetime.now(dt.UTC).replace(microsecond=0) - dt.timedelta(hours=1)
    m = dt.timedelta(minutes=1)
    # Browser 1: anonymous browsing, then the BFF's otp_verified with the new token.
    send(client, [envelope("anon_mine_0001", "page_view", t, path="/kundli", source="search")])
    send(client, [envelope("anon_mine_0001", "tool_completed", t + m, tool="kundli")])
    send(client, [envelope("anon_mine_0001", "otp_verified", t + 2 * m, is_new_user=True)], h)
    send(client, [envelope("anon_mine_0001", "page_view", t + 3 * m, path="/wallet")], h)
    # Browser 2: linked by a later sign-in.
    send(client, [envelope("anon_mine_0002", "page_view", t + 4 * m, path="/")])
    send(client, [envelope("anon_mine_0002", "otp_verified", t + 5 * m, is_new_user=False)], h)
    # Not the user's: an unlinked visitor and another user.
    send(client, [envelope("anon_else_0001", "page_view", t, path="/")])
    send(client, [envelope("anon_else_0002", "otp_verified", t, is_new_user=True)], other)
    return h, uid, t


def test_export_lists_the_users_own_events(client: TestClient, login: Any) -> None:
    _, uid, t = world(client, login)
    settings = client.app.state.settings  # type: ignore[attr-defined]
    data = run_db(client, lambda db: privacy.build_export(db, settings, uid))
    m = dt.timedelta(minutes=1)
    assert data["analytics_events"] == [
        {
            "event": "otp_verified",
            "occurred_at": (t + 2 * m).isoformat(),
            "properties": {"is_new_user": True},
        },
        {
            "event": "page_view",
            "occurred_at": (t + 3 * m).isoformat(),
            "properties": {"path": "/wallet"},
        },
        {
            "event": "otp_verified",
            "occurred_at": (t + 5 * m).isoformat(),
            "properties": {"is_new_user": False},
        },
    ]


def test_deletion_removes_linked_events(
    client: TestClient, login: Any, admin_headers: dict[str, str]
) -> None:
    h, uid, _ = world(client, login)
    r = client.post("/v1/me/deletion", json={"confirm": "DELETE"}, headers=h)
    assert r.status_code == 202, r.text
    r = client.post(f"/v1/admin/deletions/{r.json()['id']}/execute", headers=admin_headers)
    assert r.status_code == 200, r.text

    async def facts(db: AsyncSession) -> tuple[list[tuple[str, str]], dict[str, Any]]:
        left = (
            await db.execute(
                select(AnalyticsEvent.anonymous_id, AnalyticsEvent.event).order_by(
                    AnalyticsEvent.id
                )
            )
        ).all()
        detail = (
            await db.execute(
                select(AuditLog.detail).where(AuditLog.action == "privacy.deletion.content_deleted")
            )
        ).scalar_one()
        return [(a, e) for a, e in left], detail

    left, detail = run_db(client, facts)
    assert left == [("anon_else_0001", "page_view"), ("anon_else_0002", "otp_verified")]
    assert detail["analytics_events"] == 6
    assert detail["user_id"] == str(uid)
