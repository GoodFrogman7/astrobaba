"""Facts for AI answers come only from the astro engine (PLAN.md §0.4). Unit tests use responses
recorded by fixtures/record_ai_engine.py; one live test runs against a local engine if present."""

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from astro_api import ai_facts
from astro_api.ai_facts import BirthInput, answer_grounding_errors, build_facts

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def recorded(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"ai_engine_{name}.json").read_text())
    return data


def facts(name: str = "known_time") -> dict[str, Any]:
    r = recorded(name)
    return build_facts(r["kundli"], r["dasha"], r["transits"])


def test_known_time_facts_are_the_engine_values() -> None:
    r = recorded("known_time")
    f = facts()
    assert f["birth_time_known"] is True
    assert f["ascendant"]["sign"] == r["kundli"]["ascendant"]["sign"]
    by_id = {g["id"]: g for g in r["kundli"]["grahas"]}
    for p in f["planets"]:
        g = by_id[p["graha"]]
        assert (p["sign"], p["house"], p["retrograde"]) == (g["sign"], g["house"], g["retrograde"])
    assert len(f["planets"]) == 9 and len(f["houses"]) == 12
    cur = r["dasha"]["current"]
    assert (f["dasha"]["mahadasha"], f["dasha"]["antardasha"]) == (
        cur["mahadasha"],
        cur["antardasha"],
    )
    assert f["dasha"]["next_mahadasha"] != f["dasha"]["mahadasha"]
    assert {t["graha"] for t in f["transits"]["planets"]} == set(by_id)
    assert all(t["house_from_moon"] is not None for t in f["transits"]["planets"])
    assert f["engine_version"] == r["kundli"]["settings"]["engine_version"]


def test_unknown_time_drops_everything_that_needs_the_time() -> None:
    f = facts("unknown_time")
    assert f["birth_time_known"] is False
    assert f["ascendant"] is None and f["houses"] is None
    assert all(p["house"] is None for p in f["planets"])
    # Vimshottari depends on the Moon's exact degree: omitted rather than guessed.
    assert f["dasha"] is None and "dasha" in f["omitted"]
    moon = next(p for p in f["planets"] if p["graha"] == "moon")
    assert moon["nakshatra"] is None  # the Moon changed nakshatra during the day


def test_facts_hold_no_birth_details() -> None:
    text = json.dumps(facts())
    for leak in ("1990", "28.62", "77.21", "Asia/Kolkata", "06:30"):
        assert leak not in text


def test_grounding_accepts_facts_and_rejects_invented_placements() -> None:
    f = facts()
    assert answer_grounding_errors("Your Moon is in Taurus, in your 10th house.", f) == []
    assert answer_grounding_errors("Your ascendant is Leo.", f) == []
    assert answer_grounding_errors("You are in the Jupiter mahadasha now.", f) == []
    assert answer_grounding_errors("आपकी कुंडली में चन्द्र वृषभ राशि में है।", f) == []
    assert answer_grounding_errors("Your Moon is in Scorpio.", f) != []
    assert answer_grounding_errors("Saturn sits in your 2nd house.", f) != []
    assert answer_grounding_errors("You are in the Venus mahadasha now.", f) != []
    assert answer_grounding_errors("Things change in 2031.", f) != []
    end_year = f["dasha"]["mahadasha_end"][:4]
    assert answer_grounding_errors(f"This mahadasha runs until {end_year}.", f) == []


def test_grounding_without_dasha_rejects_any_dasha_claim() -> None:
    f = facts("unknown_time")
    assert answer_grounding_errors("You are in the Jupiter mahadasha now.", f) != []


def test_birth_input_from_saved_kundli_fields() -> None:
    b = BirthInput(
        date=dt.date(1990, 8, 15),
        time=None,
        lat=28.6,
        lon=77.2,
        tz="Asia/Kolkata",
        utc_offset="+05:30",
    )
    assert b.engine_body() == {
        "date": "1990-08-15",
        "time": None,
        "place": {"lat": 28.6, "lon": 77.2, "tz": "Asia/Kolkata"},
    }
    b2 = BirthInput(dt.date(1990, 8, 15), dt.time(6, 30), 28.6, 77.2, "Asia/Kolkata", "+05:30")
    assert b2.engine_body()["time"] == "06:30:00" and b2.engine_body()["utc_offset"] == "+05:30"


async def test_fetch_uses_post_bodies_and_tolerates_missing_transits() -> None:
    r = recorded("known_time")
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        assert "1990" not in str(request.url)  # birth details only in POST bodies
        if request.url.path == "/v1/kundli":
            return httpx.Response(200, json=r["kundli"])
        if request.url.path == "/v1/dasha":
            return httpx.Response(200, json=r["dasha"])
        return httpx.Response(503)

    birth = BirthInput(dt.date(1990, 8, 15), dt.time(6, 30), 28.62137, 77.2148, "Asia/Kolkata")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        f = await ai_facts.fetch_facts(
            http, "http://astro.test", birth, now=dt.datetime(2026, 10, 21, 6, tzinfo=dt.UTC)
        )
    assert f["transits"] is None and "transits" in f["omitted"]
    assert ("POST", "/v1/kundli") in seen and ("POST", "/v1/dasha") in seen


async def test_fetch_raises_when_the_engine_is_down() -> None:
    birth = BirthInput(dt.date(1990, 8, 15), dt.time(6, 30), 28.62137, 77.2148, "Asia/Kolkata")
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(503))
    ) as http:
        with pytest.raises(ai_facts.FactsUnavailable):
            await ai_facts.fetch_facts(http, "http://astro.test", birth)


async def test_live_engine_facts() -> None:
    url = os.environ.get("ASTRO_URL", "http://localhost:8001")
    birth = BirthInput(dt.date(1990, 8, 15), dt.time(6, 30), 28.62137, 77.2148, "Asia/Kolkata")
    async with httpx.AsyncClient(timeout=10) as http:
        try:
            (await http.get(f"{url}/healthz")).raise_for_status()
        except httpx.HTTPError:
            pytest.skip("astro engine not reachable")
        f = await ai_facts.fetch_facts(http, url, birth)
    assert f["ascendant"]["sign"] == facts()["ascendant"]["sign"]
    assert f["transits"] is not None and f["dasha"] is not None
