"""Session REST API: create checks in contract order, idempotency, queue/ETA, transitions,
presence, history, SessionView shape (docs/api/billing.md "Sessions", chat.ts)."""

import asyncio
import datetime as dt
import re
import typing
import uuid
from typing import Any

import pytest
from sqlalchemy import select, update

from astro_api import session_service as svc
from astro_api import sessions_api
from astro_api.models import SESSION_STATUSES, Astrologer, AuditLog
from services.api.tests.money_fakes import (  # noqa: F401 - fixtures
    PRICE,
    USER_PHONE,
    FakeMoney,
    World,
    deps_for,
    fake_money_fixture,
    money_fixture,
    world_fixture,
)

pytestmark = pytest.mark.integration

# packages/shared/src/chat.ts SessionView
SESSION_VIEW_KEYS = {
    "id",
    "kind",
    "status",
    "end_reason",
    "role",
    "astrologer",
    "client_label",
    "price_per_min_paise",
    "is_free",
    "free_minutes",
    "queue",
    "created_at",
    "accepted_at",
    "started_at",
    "ended_at",
    "billed_minutes",
    "billed_paise",
    "minutes_left",
    "can_review",
}


def code(r: Any) -> str:
    return str(r.json()["detail"]["code"])


def set_astrologer(w: World, **values: Any) -> None:
    async def run() -> None:
        async with deps_for(w.settings) as deps, deps.sessionmaker() as db:
            await db.execute(
                update(Astrologer).where(Astrologer.id == uuid.UUID(w.aid)).values(**values)
            )
            await db.commit()

    asyncio.run(run())


def test_status_literal_matches_model() -> None:
    assert set(typing.get_args(sessions_api.Status)) == set(SESSION_STATUSES)


def test_create_returns_session_view_and_captures_price(world: World) -> None:
    headers, _ = world.user()
    r = world.create(headers)
    assert r.status_code == 201, r.text
    view = r.json()
    assert set(view) == SESSION_VIEW_KEYS
    assert view["status"] == "requested" and view["role"] == "user" and view["kind"] == "chat"
    assert view["astrologer"] == {
        "id": world.aid,
        "slug": world.slug,
        "display_name": "Asha Verma",
    }
    assert view["price_per_min_paise"] == PRICE and view["is_free"] is False
    assert view["queue"] is None and view["billed_minutes"] == 0
    assert view["minutes_left"] == 100_000 // PRICE
    assert re.fullmatch(r"Client [0-9A-F]{4}", view["client_label"])
    assert USER_PHONE[3:] not in str(view)
    row = world.row(view["id"])
    assert row.commission_bps == 4000  # rising tier, data/marketplace/billing.json

    # Later price changes never reprice the session.
    set_astrologer(world, price_per_min_paise=PRICE * 2)
    again = world.client.get(f"/v1/sessions/{view['id']}", headers=headers).json()
    assert again["price_per_min_paise"] == PRICE

    # The astrologer sees the same label, never the phone, and minutes_left is null.
    a_view = world.client.get(f"/v1/sessions/{view['id']}", headers=world.astro).json()
    assert a_view["role"] == "astrologer" and a_view["minutes_left"] is None
    assert a_view["client_label"] == view["client_label"]


def test_create_is_idempotent(world: World) -> None:
    headers, _ = world.user()
    first = world.create(headers, "same-key-0001")
    assert first.status_code == 201
    replay = world.create(headers, "same-key-0001")
    assert replay.status_code == 201 and replay.json()["id"] == first.json()["id"]
    other = world.client.post(
        "/v1/sessions",
        json={"astrologer_id": world.aid, "kind": "chat", "free": True},
        headers={**headers, "Idempotency-Key": "same-key-0001"},
    )
    assert other.status_code == 409 and code(other) == "idempotency_conflict"
    missing = world.client.post("/v1/sessions", json={"astrologer_id": world.aid}, headers=headers)
    assert code(missing) == "idempotency_key_required"

    # Redis forgets: the unique (user, key) column still returns the original session.
    import redis

    r = redis.Redis.from_url(world.settings.redis_url.get_secret_value())
    r.flushdb()
    r.close()
    after_flush = world.create(headers, "same-key-0001")
    assert after_flush.status_code == 201 and after_flush.json()["id"] == first.json()["id"]
    conflict = world.client.post(
        "/v1/sessions",
        json={"astrologer_id": world.aid, "kind": "chat", "free": True},
        headers={**headers, "Idempotency-Key": "same-key-0001"},
    )
    assert code(conflict) == "idempotency_conflict"


def test_create_checks_in_contract_order(world: World, money: Any) -> None:
    headers, uid = world.user(fund=PRICE)  # one minute: not enough to start (min 2)
    r = world.create(headers, astrologer_id=str(uuid.uuid4()))
    assert r.status_code == 404
    # Own profile beats everything after the astrologer check.
    r = world.create(world.astro)
    assert r.status_code == 409 and code(r) == "own_profile"
    r = world.create(headers)
    assert r.status_code == 402 and code(r) == "insufficient_funds"
    assert r.json()["detail"]["minutes_affordable"] == 1
    assert r.json()["detail"]["required_paise"] == PRICE * 2

    money.fund(uid, real_paise=PRICE)
    r = world.create(headers)
    assert r.status_code == 201
    r2 = world.create(headers)
    assert r2.status_code == 409 and code(r2) == "session_open"
    assert r2.json()["detail"]["session_id"] == r.json()["id"]

    set_astrologer(world, flags={"chat_enabled": False, "show_in_directory": True})
    other, _ = world.user("+919844440002")
    r = world.create(other)
    assert r.status_code == 409 and code(r) == "chat_unavailable"
    set_astrologer(world, flags={"chat_enabled": True, "show_in_directory": False})
    assert world.create(other).status_code == 404  # not public


def test_free_session(world: World, fake_money: FakeMoney) -> None:
    headers, uid = world.user(fund=0)
    r = world.create(headers, free=True)
    assert r.status_code == 201, r.text
    view = r.json()
    assert view["is_free"] is True and view["free_minutes"] == 5
    assert view["minutes_left"] == 5
    lot = fake_money.committed.lots[uuid.UUID(view["id"])]
    assert lot.user_id == uid and lot.remaining == PRICE * 5
    assert uid in fake_money.committed.free_claims

    world.post(view["id"], "cancel", headers)
    assert fake_money.committed.lots[uuid.UUID(view["id"])].closed  # rest of the lot expired
    r = world.create(headers, free=True)
    assert r.status_code == 403 and code(r) == "free_session_unavailable"
    assert r.json()["detail"]["reason"] == "already_used"


def test_queue_position_eta_and_promotion(world: World) -> None:
    h1, _ = world.user("+919844440011")
    h2, _ = world.user("+919844440012")
    h3, _ = world.user("+919844440013")
    s1 = world.create(h1).json()
    s2 = world.create(h2).json()
    s3 = world.create(h3).json()
    assert s1["status"] == "requested"
    # One request waiting ahead of #2 (never accepted yet): average_session_minutes for it.
    assert s2["status"] == "queued" and s2["queue"] == {"position": 1, "eta_minutes": 10}
    assert s3["queue"] == {"position": 2, "eta_minutes": 20}

    incoming = world.client.get("/v1/astrologer/me/sessions/incoming", headers=world.astro)
    assert [i["id"] for i in incoming.json()["items"]] == [s1["id"], s2["id"], s3["id"]]
    assert all(i["role"] == "astrologer" for i in incoming.json()["items"])

    # Accepted: the client's prepaid minutes (100000 / 2000 = 50) are what is known.
    assert world.post(s1["id"], "accept", world.astro).status_code == 200
    q2 = world.client.get(f"/v1/sessions/{s2['id']}", headers=h2).json()["queue"]
    assert q2["position"] == 1 and 49 <= q2["eta_minutes"] <= 50
    # The astrologer's busy_until key is gone: nothing is known, so no ETA is invented.
    import redis

    r = redis.Redis.from_url(world.settings.redis_url.get_secret_value())
    r.delete(f"busy_until:{world.aid}")
    r.close()
    q2 = world.client.get(f"/v1/sessions/{s2['id']}", headers=h2).json()["queue"]
    assert q2 == {"position": 1, "eta_minutes": None}

    # The head is promoted when the astrologer frees up.
    assert world.post(s1["id"], "cancel", h1).json()["status"] == "cancelled"
    assert world.client.get(f"/v1/sessions/{s2['id']}", headers=h2).json()["status"] == (
        "requested"
    )
    q3 = world.client.get(f"/v1/sessions/{s3['id']}", headers=h3).json()["queue"]
    assert q3 == {"position": 1, "eta_minutes": 10}
    # Declining the request promotes the next one too.
    declined = world.post(s2["id"], "decline", world.astro).json()
    assert declined["status"] == "cancelled" and declined["end_reason"] == "astrologer_declined"
    assert world.client.get(f"/v1/sessions/{s3['id']}", headers=h3).json()["status"] == (
        "requested"
    )


def test_transitions_roles_and_presence(world: World, fake_money: FakeMoney) -> None:
    headers, _, sid = world.accepted()
    stranger = world.login("+919844440099")
    assert world.client.get(f"/v1/sessions/{sid}", headers=stranger).status_code == 404
    assert world.post(sid, "accept", headers).status_code == 403  # the user cannot accept
    assert world.post(sid, "cancel", world.astro).status_code == 403
    assert code(world.post(sid, "accept", world.astro)) == "session_not_requested"
    assert code(world.post(sid, "end", headers)) == "session_not_active"

    profile = world.client.get(f"/v1/astrologers/{world.slug}").json()
    assert profile["presence"] == "busy" and 49 <= profile["wait_minutes"] <= 50

    async def start() -> None:
        async with deps_for(world.settings) as deps:
            assert await svc.activate(deps, uuid.UUID(sid))

    asyncio.run(start())
    view = world.client.get(f"/v1/sessions/{sid}", headers=headers).json()
    assert view["status"] == "active" and view["billed_minutes"] == 1
    assert view["billed_paise"] == PRICE and view["started_at"] is not None
    assert code(world.post(sid, "cancel", headers)) == "session_active"

    ended = world.post(sid, "end", world.astro).json()
    assert ended["status"] == "completed" and ended["end_reason"] == "astrologer_ended"
    assert ended["role"] == "astrologer"
    assert world.client.get(f"/v1/astrologers/{world.slug}").json()["presence"] == "offline"
    assert code(world.post(sid, "end", headers)) == "session_not_active"
    assert fake_money.refunded() == [uuid.UUID(sid)]
    assert world.row(sid).settled_at is not None

    # Reviews work on a completed session; can_review flips after reviewing.
    assert world.client.get(f"/v1/sessions/{sid}", headers=headers).json()["can_review"] is True
    r = world.client.post(f"/v1/consult-sessions/{sid}/review", json={"rating": 5}, headers=headers)
    assert r.status_code == 201, r.text
    assert world.client.get(f"/v1/sessions/{sid}", headers=headers).json()["can_review"] is False

    async def audit_actions() -> list[str]:
        async with deps_for(world.settings) as deps, deps.sessionmaker() as db:
            rows = await db.execute(select(AuditLog.action).where(AuditLog.entity_id == sid))
            return sorted(rows.scalars())

    assert asyncio.run(audit_actions()) == [
        "session.accept",
        "session.create",
        "session.end",
        "session.start",
    ]


def test_history_and_messages_endpoints(world: World) -> None:
    headers, _ = world.user()
    first = world.create(headers).json()
    world.post(first["id"], "cancel", headers)
    second = world.create(headers).json()

    items = world.client.get("/v1/sessions", headers=headers).json()
    assert [i["id"] for i in items["items"]] == [second["id"], first["id"]]
    page = world.client.get("/v1/sessions?limit=1", headers=headers).json()
    assert len(page["items"]) == 1 and page["next_cursor"]
    rest = world.client.get(f"/v1/sessions?limit=1&cursor={page['next_cursor']}", headers=headers)
    assert rest.json()["items"][0]["id"] == first["id"] and rest.json()["next_cursor"] is None
    cancelled = world.client.get("/v1/sessions?status=cancelled", headers=headers).json()
    assert [i["id"] for i in cancelled["items"]] == [first["id"]]
    assert cancelled["items"][0]["end_reason"] == "user_cancelled"
    mine = world.client.get("/v1/sessions?role=astrologer", headers=world.astro).json()
    assert {i["id"] for i in mine["items"]} == {first["id"], second["id"]}
    assert world.client.get("/v1/sessions?role=astrologer", headers=headers).json()["items"] == []
    assert world.client.get("/v1/sessions?status=nope", headers=headers).status_code == 422

    msgs = world.client.get(f"/v1/sessions/{first['id']}/messages", headers=headers).json()
    assert [m["text"] for m in msgs["items"]] == ["session_ended:user_cancelled"]
    assert msgs["items"][0]["sender"] == "system"
    too_many = world.client.get(f"/v1/sessions/{first['id']}/messages?limit=201", headers=headers)
    assert too_many.status_code == 422

    ticket = world.client.post(f"/v1/sessions/{second['id']}/ws-ticket", headers=headers).json()
    assert ticket["expires_in"] == 30 and ticket["path"] == f"/v1/sessions/{second['id']}/ws"
    stranger = world.login("+919844440098")
    assert (
        world.client.post(f"/v1/sessions/{second['id']}/ws-ticket", headers=stranger).status_code
        == 404
    )
    assert world.client.get("/v1/astrologer/me/sessions/incoming", headers=headers).status_code == (
        404
    )


def test_request_and_join_timeouts(world: World, fake_money: FakeMoney) -> None:
    from astro_api import billing_meter

    h1, _ = world.user("+919844440021")
    h2, _ = world.user("+919844440022")
    s1 = world.create(h1).json()["id"]
    s2 = world.create(h2).json()["id"]

    async def run() -> None:
        async with deps_for(world.settings) as deps:
            now = svc.utcnow()
            report = await billing_meter.tick(deps, now + dt.timedelta(seconds=60))
            assert report.ended == []
            report = await billing_meter.tick(deps, now + dt.timedelta(seconds=181))
            assert report.ended == [(uuid.UUID(s1), "request_timeout")]
            # s2 was promoted when s1 timed out (its own clock starts now).
            assert report.promoted == [] or report.promoted == [uuid.UUID(s2)]

    asyncio.run(run())
    assert world.row(s1).status == "cancelled"
    assert world.row(s2).status == "requested"
    assert world.post(s2, "accept", world.astro).status_code == 200

    async def join() -> None:
        async with deps_for(world.settings) as deps:
            now = svc.utcnow()
            assert (await billing_meter.tick(deps, now + dt.timedelta(seconds=30))).ended == []
            report = await billing_meter.tick(deps, now + dt.timedelta(seconds=91))
            assert report.ended == [(uuid.UUID(s2), "join_timeout")]

    asyncio.run(join())
    row = world.row(s2)
    assert row.status == "failed" and row.end_reason == "join_timeout"
    assert set(fake_money.refunded()) == {uuid.UUID(s1), uuid.UUID(s2)}
    failed = next(f for f in fake_money.refund_facts if f.session_id == uuid.UUID(s2))
    assert failed.status == "failed" and failed.accepted_at is not None


def test_free_claim_lost_to_a_concurrent_claim_is_403_and_writes_nothing(
    world: World, money: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from astro_api import free_session

    headers, uid = world.user(fund=0)

    async def eligible(*args: Any, **kwargs: Any) -> free_session.Eligibility:
        return free_session.Eligibility(True, 5, None)

    async def lost(*args: Any, **kwargs: Any) -> None:
        # What the real claim raises when another user on the same device won the lock.
        raise free_session.FreeSessionUnavailable("device_used")

    monkeypatch.setattr(free_session, "check", eligible)
    monkeypatch.setattr(free_session, "claim", lost)
    r = world.create(headers, free=True)
    assert r.status_code == 403 and code(r) == "free_session_unavailable"
    assert r.json()["detail"]["reason"] == "device_used"
    assert world.client.get("/v1/sessions", headers=headers).json()["items"] == []
    if isinstance(money, FakeMoney):
        assert money.committed.lots == {} and uid not in money.committed.free_claims
    else:
        assert money.balance(uid) == 0


def test_admin_sessions_list_is_admin_only_and_has_no_personal_data(
    world: World, admin_headers: dict[str, str]
) -> None:
    headers, uid = world.user()
    sid = world.create(headers).json()["id"]
    assert world.client.get("/v1/admin/sessions", headers=headers).status_code == 403
    r = world.client.get("/v1/admin/sessions", headers=admin_headers)
    assert r.status_code == 200, r.text
    (item,) = r.json()["items"]
    assert item["id"] == sid and item["user_id"] == str(uid) and item["status"] == "requested"
    assert not {"role", "minutes_left", "can_review"} & set(item)
    assert USER_PHONE[3:] not in r.text
    filtered = world.client.get(
        "/v1/admin/sessions", params={"status": "completed"}, headers=admin_headers
    )
    assert filtered.json()["items"] == []
