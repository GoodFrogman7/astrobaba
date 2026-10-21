"""Reports, the admin moderation queue, reveal, actions and strikes, and the public safety
endpoints (docs/api/trust.md §3-§4)."""

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from astro_api import session_service as svc
from astro_api.models import AuditLog
from astro_api.models_safety import ModerationEvent
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    World,
    alive,
    deps_for,
    money_fixture,
    world_fixture,
)

pytestmark = pytest.mark.integration

NOTE = "He asked me to pay on a personal number. My name is Ravi."
CRISIS = "I want to kill myself"


def code(r: Any) -> str:
    return str(r.json()["detail"]["code"])


def report(w: World, headers: dict[str, str], key: str | None = None, **body: Any) -> Any:
    payload = {"astrologer_id": w.aid, "reason": "scam", **body}
    return w.client.post(
        "/v1/reports/astrologer",
        json=payload,
        headers={**headers, "Idempotency-Key": key or uuid.uuid4().hex},
    )


def flagged_session(w: World, phone: str = "+919844440077") -> str:
    """An active session with one crisis message from the client (seq 2)."""
    _, _, raw = w.accepted(phone)
    sid = uuid.UUID(raw)

    async def run() -> None:
        async with deps_for(w.settings) as deps:
            now = svc.utcnow()
            await alive(deps, sid, now)
            assert await svc.activate(deps, sid, now)
            await svc.post_message(deps, sid, "user", "c-1", CRISIS, crisis="self_harm")
            await svc.refuse_message(deps, sid, "guarantee")

    asyncio.run(run())
    return raw


def stored(w: World) -> list[ModerationEvent]:
    async def run() -> list[ModerationEvent]:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            return list((await db.execute(select(ModerationEvent))).scalars())

    return asyncio.run(run())


def audit_rows(w: World, action: str) -> list[AuditLog]:
    async def run() -> list[AuditLog]:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            q = select(AuditLog).where(AuditLog.action == action)
            return list((await db.execute(q)).scalars())

    return asyncio.run(run())


# ---------------------------------------------------------------- public


def test_resources_and_conduct_are_public(world: World) -> None:
    r = world.client.get("/v1/safety/resources")
    assert r.status_code == 200
    body = r.json()
    assert [h["number"] for h in body["helplines"]] == ["14416", "112"]
    assert body["not_a_helpline"]["hi"]
    r = world.client.get("/v1/safety/conduct")
    assert r.status_code == 200
    assert [x["id"] for x in r.json()["rules"]][:6] == [
        "contact_details",
        "off_platform_payment",
        "cure_claim",
        "guarantee",
        "fear_selling",
        "remedy_sale",
    ]


# ---------------------------------------------------------------- reports


def test_report_is_idempotent_unique_while_open_and_note_encrypted(world: World) -> None:
    headers, _ = world.user("+919844440061", fund=0)
    assert report(world, {}, reason="scam").status_code == 401
    r = world.client.post(
        "/v1/reports/astrologer", json={"astrologer_id": world.aid}, headers=headers
    )
    assert r.status_code == 400 and code(r) == "idempotency_key_required"

    r = report(world, headers, "rep-key-0001", reason="fear_selling", note=NOTE)
    assert r.status_code == 201, r.text
    first = r.json()
    assert first["reason"] == "fear_selling" and first["status"] == "open" and first["has_note"]
    # Same key and body: the same report back (also after Redis loses it).
    assert report(world, headers, "rep-key-0001", reason="fear_selling", note=NOTE).json() == first
    import redis

    rc = redis.Redis.from_url(world.settings.redis_url.get_secret_value())
    rc.flushdb()
    rc.close()
    again = report(world, headers, "rep-key-0001", reason="fear_selling", note=NOTE)
    assert again.status_code == 201 and again.json() == first
    r = report(world, headers, "rep-key-0001", reason="other")
    assert r.status_code == 409 and code(r) == "idempotency_conflict"
    # One open report per user per astrologer.
    r = report(world, headers, reason="harassment")
    assert r.status_code == 409 and code(r) == "report_open"
    assert r.json()["detail"]["report_id"] == first["id"]

    (item,) = stored(world)
    assert item.note_ciphertext is not None and NOTE.encode() not in item.note_ciphertext
    assert b"Ravi" not in item.note_ciphertext
    trail = audit_rows(world, "astrologer.report")
    assert len(trail) == 1 and "Ravi" not in str(trail[0].detail)


def test_report_validation(world: World, consult: Any) -> None:
    headers, _ = world.user("+919844440062", fund=0)
    r = report(world, headers, astrologer_id=str(uuid.uuid4()))
    assert r.status_code == 404
    r = report(world, headers, reason="bribery")
    assert r.status_code == 422
    r = report(world, headers, note="x" * 501)
    assert r.status_code == 422
    world.user("+919844440063", fund=0)
    other = consult("+919844440063", world.aid)  # someone else's session
    r = report(world, headers, session_id=other)
    assert r.status_code == 404 and code(r) == "session_not_found"
    mine = consult("+919844440062", world.aid)
    r = report(world, headers, session_id=mine, reason="off_platform")
    assert r.status_code == 201 and r.json()["session_id"] == mine
    r = report(world, world.astro, reason="other")
    assert r.status_code == 409 and code(r) == "own_profile"


# ---------------------------------------------------------------- admin queue


def test_queue_shows_codes_and_counts_never_text(
    world: World, admin_headers: dict[str, str]
) -> None:
    sid = flagged_session(world)
    headers, _ = world.user("+919844440064", fund=0)
    assert report(world, headers, reason="scam", note=NOTE).status_code == 201

    assert world.client.get("/v1/admin/moderation", headers=headers).status_code == 403
    r = world.client.get("/v1/admin/moderation", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["next_cursor"] is None
    items = {i["kind"]: i for i in body["items"]}
    assert set(items) == {"report", "safety", "refused"}
    for item in body["items"]:
        assert set(item) == {
            "id",
            "kind",
            "status",
            "astrologer",
            "reasons",
            "session_id",
            "counts",
            "created_at",
            "resolution",
        }
        assert set(item["astrologer"]) == {"id", "slug", "display_name"}
        assert item["counts"] == {"reports": 1, "safety": 1, "refused": 1}
        assert item["status"] == "open" and item["resolution"] is None
    assert items["safety"]["reasons"] == ["self_harm"] and items["safety"]["session_id"] == sid
    assert items["refused"]["reasons"] == ["guarantee"]
    assert items["report"]["reasons"] == ["scam"]
    assert CRISIS not in r.text and "Ravi" not in r.text

    only = world.client.get("/v1/admin/moderation?kind=refused", headers=admin_headers).json()
    assert [i["kind"] for i in only["items"]] == ["refused"]
    page = world.client.get("/v1/admin/moderation?limit=2", headers=admin_headers).json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    rest = world.client.get(
        f"/v1/admin/moderation?limit=2&cursor={page['next_cursor']}", headers=admin_headers
    ).json()
    assert len(rest["items"]) == 1
    closed = world.client.get("/v1/admin/moderation?status=closed", headers=admin_headers)
    assert closed.json()["items"] == []


def test_reveal_one_flagged_message_is_audited(world: World, admin_headers: dict[str, str]) -> None:
    flagged_session(world)
    items = world.client.get("/v1/admin/moderation", headers=admin_headers).json()["items"]
    by_kind = {i["kind"]: i["id"] for i in items}
    url = f"/v1/admin/moderation/{by_kind['safety']}/message"
    assert world.client.get(url, headers=world.astro).status_code == 403
    r = world.client.get(url, headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "message": {
            "seq": 2,
            "sender": "user",
            "text": CRISIS,
            "sent_at": r.json()["message"]["sent_at"],
        }
    }
    (row,) = audit_rows(world, "moderation.reveal")
    admin_id = world.client.get("/v1/me", headers=admin_headers).json()["id"]
    assert row.actor == f"user:{admin_id}" and row.entity_id == by_kind["safety"]
    assert CRISIS not in str(row.detail)
    # Refused messages were never stored.
    r = world.client.get(
        f"/v1/admin/moderation/{by_kind['refused']}/message", headers=admin_headers
    )
    assert r.status_code == 404 and code(r) == "no_message"


def test_warn_records_a_strike_the_astrologer_sees(
    world: World, admin_headers: dict[str, str]
) -> None:
    flagged_session(world)
    items = world.client.get("/v1/admin/moderation", headers=admin_headers).json()["items"]
    refused = next(i for i in items if i["kind"] == "refused")
    url = f"/v1/admin/moderation/{refused['id']}"
    note = "Please do not promise outcomes to clients."
    r = world.client.post(url, json={"action": "warn", "note": note}, headers=admin_headers)
    assert r.status_code == 200, r.text
    res = r.json()["resolution"]
    assert r.json()["status"] == "closed" and res["action"] == "warn" and res["note"] == note
    assert res["by"].startswith("user:") and res["at"]
    r = world.client.post(url, json={"action": "dismiss"}, headers=admin_headers)
    assert r.status_code == 409 and code(r) == "already_closed"

    strikes = world.client.get("/v1/astrologer/me/strikes", headers=world.astro)
    assert strikes.status_code == 200
    (strike,) = strikes.json()["items"]
    assert set(strike) == {"id", "note", "created_at"} and strike["note"] == note

    # Without a note the astrologer sees the broken rule.
    safety_item = next(i for i in items if i["kind"] == "safety")
    r = world.client.post(
        f"/v1/admin/moderation/{safety_item['id']}", json={"action": "warn"}, headers=admin_headers
    )
    assert r.status_code == 200
    notes = [
        s["note"]
        for s in world.client.get("/v1/astrologer/me/strikes", headers=world.astro).json()["items"]
    ]
    assert len(notes) == 2 and any("crisis" in n for n in notes)
    other, _ = world.user("+919844440065", fund=0)
    assert world.client.get("/v1/astrologer/me/strikes", headers=other).status_code == 404
    assert len(audit_rows(world, "moderation.warn")) == 2


def test_suspend_uses_the_existing_suspension_and_dismiss_closes(
    world: World, admin_headers: dict[str, str]
) -> None:
    headers, _ = world.user("+919844440066", fund=0)
    first = report(world, headers, reason="harassment").json()
    r = world.client.post(
        f"/v1/admin/moderation/{first['id']}", json={"action": "dismiss"}, headers=admin_headers
    )
    assert r.status_code == 200 and r.json()["resolution"]["action"] == "dismiss"
    # Closed, so the user may report again.
    second = report(world, headers, reason="scam")
    assert second.status_code == 201
    r = world.client.post(
        f"/v1/admin/moderation/{second.json()['id']}",
        json={"action": "suspend", "note": "Repeated off-platform payment requests."},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    detail = world.client.get(f"/v1/admin/astrologers/{world.aid}", headers=admin_headers).json()
    assert detail["status"] == "suspended"
    assert audit_rows(world, "astrologer.suspend")
    assert (
        len(world.client.get("/v1/astrologer/me/strikes", headers=world.astro).json()["items"]) == 1
    )

    # Suspending an astrologer who is no longer live fails as a whole: the item stays open.
    other, _ = world.user("+919844440067", fund=0)
    third = report(world, other, reason="scam").json()
    r = world.client.post(
        f"/v1/admin/moderation/{third['id']}", json={"action": "suspend"}, headers=admin_headers
    )
    assert r.status_code == 409 and code(r) == "invalid_transition"
    still = [i for i in stored(world) if str(i.id) == third["id"]]
    assert still[0].status == "open"
    assert (
        len(world.client.get("/v1/astrologer/me/strikes", headers=world.astro).json()["items"]) == 1
    )
