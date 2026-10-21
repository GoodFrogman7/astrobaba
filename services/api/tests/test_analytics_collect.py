"""First-party analytics collector (docs/api/growth.md §1.1): validation with rejected
counting, user_id only from the bearer token, occurred_at clamping, the per-IP rate limit, and
no event values in the logs."""

import asyncio
import datetime as dt
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api.db import make_sessionmaker
from astro_api.models_analytics import AnalyticsEvent

pytestmark = pytest.mark.integration

URL = "/v1/analytics/events"
ANON = "anon_collect_0001"
SECRET_PATH = "/kundli/zz-private-path-marker"


def iso(at: dt.datetime) -> str:
    return at.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


def envelope(event: str = "page_view", **over: Any) -> dict[str, Any]:
    props = over.pop("properties", {"path": "/kundli"} if event == "page_view" else {})
    body = {
        "event": event,
        "ts": iso(dt.datetime.now(dt.UTC)),
        "anonymous_id": ANON,
        "user_id": None,
        "locale": "en",
        "schema_version": 2,
        "properties": props,
    }
    body.update(over)
    return body


def rows(client: TestClient) -> list[AnalyticsEvent]:
    async def go() -> list[AnalyticsEvent]:
        url = client.app.state.settings.database_url.get_secret_value()  # type: ignore[attr-defined]
        engine = create_async_engine(url)
        try:
            async with make_sessionmaker(engine)() as db:
                q = select(AnalyticsEvent).order_by(AnalyticsEvent.id)
                return list((await db.execute(q)).scalars())
        finally:
            await engine.dispose()

    return asyncio.run(go())


def me(client: TestClient, headers: dict[str, str]) -> uuid.UUID:
    return uuid.UUID(client.get("/v1/me", headers=headers).json()["id"])


def test_accepts_valid_events_and_counts_rejected(client: TestClient) -> None:
    events = [
        envelope(properties={"path": "/", "source": "search", "utm_source": "google"}),
        envelope("tool_completed", properties={"tool": "kundli", "unknown_birth_time": True}),
        envelope("tool_started", properties={"tool": "kundli", "name": "Ravi"}),  # free text
        envelope("chat_message", properties={}),  # unknown event
        envelope(schema_version=1),
        envelope(anonymous_id="x"),
        envelope(locale="fr"),
        envelope(ts="2026-10-20 10:00:00"),
        "not an object",
        envelope(properties={"path": "/kundli?dob=1990-01-01"}),
    ]
    r = client.post(URL, json={"events": events})
    assert r.status_code == 202, r.text
    assert r.json() == {"accepted": 2, "rejected": 8}
    stored = rows(client)
    assert [(e.event, e.anonymous_id, e.locale, e.user_id) for e in stored] == [
        ("page_view", ANON, "en", None),
        ("tool_completed", ANON, "en", None),
    ]
    assert stored[0].properties == {"path": "/", "source": "search", "utm_source": "google"}
    assert stored[1].properties == {"tool": "kundli", "unknown_birth_time": True}


def test_batch_shape(client: TestClient) -> None:
    r = client.post(URL, json={"events": [envelope() for _ in range(21)]})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "too_many_events"
    for bad in ({}, {"events": "x"}, [envelope()]):
        r = client.post(URL, json=bad)
        assert r.status_code == 422, bad
    r = client.post(URL, json={"events": []})
    assert r.status_code == 202 and r.json() == {"accepted": 0, "rejected": 0}
    r = client.post(URL, json={"events": [envelope() for _ in range(20)]})
    assert r.status_code == 202 and r.json() == {"accepted": 20, "rejected": 0}
    assert rows(client)[0].user_id is None


def test_user_id_only_from_the_bearer_token(client: TestClient, login: Any) -> None:
    h = login("+919822200001")
    uid = me(client, h)
    other = me(client, login("+919822200002"))
    spoofed = envelope("otp_verified", user_id=str(other), properties={"is_new_user": True})
    # Signed in: the token's user, whatever the envelope says.
    r = client.post(URL, json={"events": [spoofed]}, headers=h)
    assert r.json() == {"accepted": 1, "rejected": 0}
    # Anonymous: null, even with a user_id in the envelope.
    r = client.post(URL, json={"events": [spoofed]})
    assert r.json() == {"accepted": 1, "rejected": 0}
    # Invalid or revoked token: still accepted, as anonymous (never 401).
    r = client.post(URL, json={"events": [spoofed]}, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 202
    r = client.post(URL, json={"events": [spoofed]}, headers={"Authorization": "Basic abc"})
    assert r.status_code == 202
    assert client.post("/v1/auth/logout", headers=h).status_code == 204
    r = client.post(URL, json={"events": [spoofed]}, headers=h)
    assert r.status_code == 202
    assert [e.user_id for e in rows(client)] == [uid, None, None, None, None]


def test_occurred_at_is_clamped_to_receive_time(client: TestClient) -> None:
    now = dt.datetime.now(dt.UTC)
    near_past = now - dt.timedelta(hours=23)
    events = [
        envelope(ts=iso(near_past)),
        envelope(ts=iso(now - dt.timedelta(hours=25))),
        envelope(ts=iso(now + dt.timedelta(hours=25))),
        envelope(ts=iso(now + dt.timedelta(hours=1))),
    ]
    before = dt.datetime.now(dt.UTC)
    assert client.post(URL, json={"events": events}).json()["accepted"] == 4
    after = dt.datetime.now(dt.UTC)
    stored = rows(client)
    assert abs(stored[0].occurred_at - near_past) < dt.timedelta(seconds=1)
    for e in stored[1:3]:
        assert before - dt.timedelta(seconds=1) <= e.occurred_at <= after + dt.timedelta(seconds=1)
    assert stored[3].occurred_at > after + dt.timedelta(minutes=50)
    for e in stored:
        assert before - dt.timedelta(seconds=5) <= e.received_at <= after + dt.timedelta(seconds=5)


@pytest.fixture
def proxied(clean: Any) -> Iterator[TestClient]:
    """An app that reads the client IP from X-Forwarded-For, as behind the web BFF."""
    from astro_api.main import create_app

    settings = clean.model_copy(update={"client_ip_header": "X-Forwarded-For"})
    with TestClient(create_app(settings)) as c:
        yield c


def test_rate_limit_is_300_events_per_minute_per_ip(proxied: TestClient) -> None:
    ip1 = {"X-Forwarded-For": "203.0.113.7"}
    for _ in range(15):
        r = proxied.post(URL, json={"events": [envelope() for _ in range(20)]}, headers=ip1)
        assert r.status_code == 202
    # Invalid events count toward the limit too.
    r = proxied.post(URL, json={"events": [envelope(locale="fr")]}, headers=ip1)
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
    assert 1 <= int(r.headers["Retry-After"]) <= 60
    # Another IP has its own budget.
    r = proxied.post(
        URL, json={"events": [envelope()]}, headers={"X-Forwarded-For": "198.51.100.2"}
    )
    assert r.status_code == 202
    assert len(rows(proxied)) == 301


def test_rate_limit_counts_events_not_requests(proxied: TestClient) -> None:
    ip = {"X-Forwarded-For": "203.0.113.9"}
    r = proxied.post(URL, json={"events": [envelope() for _ in range(20)]}, headers=ip)
    assert r.status_code == 202
    for _ in range(14):
        proxied.post(URL, json={"events": [envelope() for _ in range(20)]}, headers=ip)
    r = proxied.post(URL, json={"events": [envelope()]}, headers=ip)
    assert r.status_code == 429


def test_logs_counts_never_values(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG")
    events = [
        envelope(properties={"path": SECRET_PATH}),
        envelope(properties={"path": SECRET_PATH, "bogus": "zz-free-text-marker"}),
    ]
    r = client.post(URL, json={"events": events})
    assert r.json() == {"accepted": 1, "rejected": 1}
    assert "zz-private-path-marker" not in caplog.text
    assert "zz-free-text-marker" not in caplog.text
    assert ANON not in caplog.text
    records = [rec for rec in caplog.records if rec.getMessage() == "analytics_events"]
    assert [(rec.accepted, rec.rejected) for rec in records] == [(1, 1)]  # type: ignore[attr-defined]
