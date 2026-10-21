"""Almanac dates (docs/api/growth.md §4.2). The engine is the in-process astro engine (no
network); every expected value below is read back from the engine itself, never typed here."""

import asyncio
import datetime as dt
import itertools
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from astro_api import growth_api as g

pytestmark = pytest.mark.integration

URL = "/v1/admin/growth/almanac-dates"
START = dt.date(2026, 10, 21)


class CountingEngine(httpx.AsyncBaseTransport):
    """Serves the real engine in-process and records the requested panchang dates."""

    def __init__(self) -> None:
        from astro_engine.main import app

        self.inner = httpx.ASGITransport(app=app)
        self.dates: list[str] = []
        self.paths: list[str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.paths.append(request.url.path)
        if request.url.path == "/v1/panchang":
            params = request.url.params
            assert (params["lat"], params["lon"], params["tz"]) == (
                "28.6139",
                "77.209",
                "Asia/Kolkata",
            )
            self.dates.append(params["date"])
        return await self.inner.handle_async_request(request)


def engine_panchang(day: dt.date) -> dict[str, Any]:
    from astro_engine.main import app

    async def run() -> dict[str, Any]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://engine") as http:
            r = await http.get("/v1/panchang", params={**g.ALMANAC_PLACE, "date": day.isoformat()})
            data: dict[str, Any] = r.json()
            return data

    return asyncio.run(run())


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> CountingEngine:
    transport = CountingEngine()
    monkeypatch.setattr(g, "ENGINE_TRANSPORT", transport)
    monkeypatch.setattr(g, "ist_today", lambda: START)
    return transport


def test_dates_match_the_engine_and_are_cached(
    client: TestClient, admin_headers: dict[str, str], engine: CountingEngine
) -> None:
    r = client.get(URL, params={"days": 40}, headers=admin_headers)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    # One call per day, plus the day before the range for the sign comparison.
    expected_days = [START + dt.timedelta(days=n) for n in range(-1, 40)]
    assert sorted(engine.dates) == [d.isoformat() for d in expected_days]

    panchang = {d: engine_panchang(d) for d in expected_days}
    want: list[dict[str, Any]] = []
    for prev, day in itertools.pairwise(expected_days):
        tithi = panchang[day]["tithi_at_sunrise"]
        kind = {15: "purnima", 30: "amavasya", 11: "ekadashi", 26: "ekadashi"}.get(tithi["number"])
        if kind:
            want.append({"date": day.isoformat(), "kind": kind, "tithi": tithi["id"]})
        sun, sun_before = panchang[day]["sun_at_sunrise"], panchang[prev]["sun_at_sunrise"]
        if sun["sign_index"] != sun_before["sign_index"]:
            want.append({"date": day.isoformat(), "kind": "sun_sign_change", "sign": sun["sign"]})
    assert items == want
    kinds = {i["kind"] for i in items}
    # 40 days always hold a full and a new moon, two ekadashis and a solar ingress.
    assert {"purnima", "amavasya", "ekadashi", "sun_sign_change"} <= kinds
    assert all(dt.date.fromisoformat(i["date"]) >= START for i in items)

    # Cached per IST date for 7 days: a second request makes no engine call.
    redis = client.app.state.redis  # type: ignore[attr-defined]

    async def ttl() -> tuple[int, Any]:
        key = f"growth:almanac:new-delhi:{START.isoformat()}"
        return int(await redis.ttl(key)), await redis.get(key)

    seconds, cached = client.portal.call(ttl)  # type: ignore[union-attr]
    assert 6 * 86400 < seconds <= 7 * 86400
    assert set(json.loads(cached)) == {"tithi_number", "tithi_id", "sun_sign_index", "sun_sign"}
    before = len(engine.dates)
    again = client.get(URL, params={"days": 40}, headers=admin_headers)
    assert again.json()["items"] == items
    assert len(engine.dates) == before
    # A longer range only fetches the new days.
    client.get(URL, params={"days": 45}, headers=admin_headers)
    assert len(engine.dates) == before + 5


def test_days_bounds_and_admin_only(
    client: TestClient, admin_headers: dict[str, str], login: Any, engine: CountingEngine
) -> None:
    assert client.get(URL, params={"days": 6}, headers=admin_headers).status_code == 422
    assert client.get(URL, params={"days": 121}, headers=admin_headers).status_code == 422
    assert client.get(URL, headers=login("+919888880001")).status_code == 403
    assert engine.dates == []
    r = client.get(URL, headers=admin_headers)  # default 60 days
    assert r.status_code == 200
    assert len(engine.dates) == 61


@pytest.mark.parametrize("failure", ["down", "error", "garbage"])
def test_engine_unavailable_is_503(
    client: TestClient, admin_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "down":
            raise httpx.ConnectError("refused", request=request)
        if failure == "error":
            return httpx.Response(500, json={"detail": "boom"})
        return httpx.Response(200, json={"date": request.url.params["date"]})

    monkeypatch.setattr(g, "ENGINE_TRANSPORT", httpx.MockTransport(handler))
    r = client.get(URL, params={"days": 7}, headers=admin_headers)
    assert (r.status_code, r.json()["detail"]["code"]) == (503, "engine_unavailable")
