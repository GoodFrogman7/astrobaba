import asyncio
import datetime as dt
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.models import AuditLog, HoroscopeEntry
from astro_api.shared_files import data_dir

pytestmark = pytest.mark.integration
FACTS: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "facts_aries_daily.json").read_text()
)
# --- Sample text built from the fixture's facts, so tests survive regenerating the fixture. ---
_TABLES = data_dir()
GRAHAS = {g["id"]: g for g in json.loads((_TABLES / "grahas.json").read_text())["grahas"]}
SIGNS = {s["id"]: s for s in json.loads((_TABLES / "signs.json").read_text())["signs"]}
AREAS = ("overall", "love", "career", "money", "health")
FILLER = (
    "Take the day one step at a time, listen closely, and keep plans flexible while you sort out "
    "what matters most to you. A calm pace suits you, and small, steady choices add up over the "
    "coming hours. Leave room for rest and for people who make you feel at ease today."
)


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def true_claim(facts: dict[str, Any]) -> str:
    """A sentence naming a planet with the sign and house the facts actually give it."""
    t = facts["transits"][0]
    g, s = GRAHAS[t["graha"]]["en"], SIGNS[t["sign"]]["en"]
    return f"With {g} in {s}, in your {ordinal(t['house_from_sign'])} house, effort is noticed."


def valid_text(facts: dict[str, Any]) -> str:
    return f"{true_claim(facts)} {FILLER}"


def false_pair(facts: dict[str, Any]) -> tuple[str, str]:
    """A (graha, sign) placement the facts do NOT contain (and not the subject sign)."""
    for t in facts["transits"]:
        placed = {t["sign"], *(i["to_sign"] for i in t.get("ingresses") or [])}
        for sign in SIGNS:
            if sign not in placed and sign != facts["sign"]:
                return t["graha"], sign
    raise AssertionError("facts place every planet everywhere")


def false_house(facts: dict[str, Any]) -> tuple[str, int]:
    t = facts["transits"][0]
    houses = {x["house_from_sign"] for x in facts["transits"] if x["graha"] == t["graha"]}
    return t["graha"], next(h for h in range(1, 13) if h not in houses)


TEXT = valid_text(FACTS)


async def _seed(settings: Settings, **overrides: Any) -> str:
    engine = create_async_engine(settings.database_url.get_secret_value())
    async with make_sessionmaker(engine)() as s:
        e = HoroscopeEntry(
            period="daily",
            sign="aries",
            ist_date=dt.date(2026, 10, 22),
            ist_date_end=dt.date(2026, 10, 22),
            locale="en",
            sections={a: TEXT for a in ("overall", "love", "career", "money", "health")},
            scores={"overall": 3},
            lucky={"day": "tuesday", "number": 9},
            facts=FACTS,
            model="fake",
            prompt_version="test",
            **overrides,
        )
        s.add(e)
        await s.commit()
        entry_id = str(e.id)
    await engine.dispose()
    return entry_id


async def _audit(settings: Settings) -> list[AuditLog]:
    engine = create_async_engine(settings.database_url.get_secret_value())
    async with make_sessionmaker(engine)() as s:
        rows = list((await s.execute(select(AuditLog))).scalars())
    await engine.dispose()
    return rows


def seed(client: TestClient, **overrides: Any) -> str:
    return asyncio.run(_seed(client.app.state.settings, **overrides))  # type: ignore[attr-defined]


def test_public_endpoint_hides_unpublished(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    seed(client)
    r = client.get("/v1/horoscopes/daily/aries", params={"date": "2026-10-22"})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "not_published"


def test_approve_publishes_and_audits(client: TestClient, admin_headers: dict[str, str]) -> None:
    entry_id = seed(client)
    pending = client.get("/v1/admin/horoscopes", headers=admin_headers).json()
    assert [p["id"] for p in pending] == [entry_id] and pending[0]["facts"]["sign"] == "aries"
    r = client.post(
        f"/v1/admin/horoscopes/{entry_id}/approve", json={"reviewer": "Asha"}, headers=admin_headers
    )
    assert r.status_code == 200 and r.json()["status"] == "published"
    pub = client.get("/v1/horoscopes/daily/aries", params={"date": "2026-10-22"})
    assert pub.status_code == 200
    body = pub.json()
    assert body["ai_generated"] is True and "facts" not in body and "status" not in body
    assert (
        client.get("/v1/horoscopes/daily/aries", params={"date": "2026-10-23"}).status_code == 404
    )
    assert (
        client.get(
            "/v1/horoscopes/daily/aries", params={"date": "2026-10-22", "locale": "hi"}
        ).status_code
        == 404
    )
    log = asyncio.run(_audit(client.app.state.settings))  # type: ignore[attr-defined]
    assert [(a.action, a.entity_id) for a in log] == [("horoscope.approve", entry_id)]
    again = client.post(
        f"/v1/admin/horoscopes/{entry_id}/approve", json={"reviewer": "Asha"}, headers=admin_headers
    )
    assert again.status_code == 422


def test_edited_text_is_validated(client: TestClient, admin_headers: dict[str, str]) -> None:
    entry_id = seed(client)
    graha, sign = false_pair(FACTS)
    invented = f" {GRAHAS[graha]['en']} in {SIGNS[sign]['en']} guarantees luck."
    bad = {a: TEXT + invented for a in AREAS}
    r = client.post(
        f"/v1/admin/horoscopes/{entry_id}/approve",
        json={"reviewer": "Asha", "sections": bad},
        headers=admin_headers,
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_sections"
    good = {
        a: TEXT.replace("today", "this evening")
        for a in ("overall", "love", "career", "money", "health")
    }
    r = client.post(
        f"/v1/admin/horoscopes/{entry_id}/approve",
        json={"reviewer": "Asha", "sections": good},
        headers=admin_headers,
    )
    assert r.status_code == 200 and r.json()["review_note"] == "edited"
    assert "this evening" in r.json()["sections"]["love"]


def test_reject(client: TestClient, admin_headers: dict[str, str]) -> None:
    entry_id = seed(client)
    r = client.post(
        f"/v1/admin/horoscopes/{entry_id}/reject",
        json={"reviewer": "Asha", "reason": "too generic"},
        headers=admin_headers,
    )
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert (
        client.get("/v1/horoscopes/daily/aries", params={"date": "2026-10-22"}).status_code == 404
    )
    assert (
        client.get(
            "/v1/admin/horoscopes", params={"status": "rejected"}, headers=admin_headers
        ).json()[0]["review_note"]
        == "too generic"
    )


def test_admin_requires_admin_role(client: TestClient, login) -> None:  # type: ignore[no-untyped-def]
    assert client.get("/v1/admin/horoscopes").status_code == 401
    assert (
        client.get("/v1/admin/horoscopes", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    member = login("+919811111111")
    r = client.get("/v1/admin/horoscopes", headers=member)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "forbidden"


def test_validation_of_path_params(client: TestClient, admin_headers: dict[str, str]) -> None:
    assert client.get("/v1/horoscopes/yearly/aries").status_code == 422
    assert client.get("/v1/horoscopes/daily/ophiuchus").status_code == 422
