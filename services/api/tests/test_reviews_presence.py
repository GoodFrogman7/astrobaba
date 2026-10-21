"""Reviews (only after a completed session, one per session, moderation, reply, report),
presence and wait time, the demo seed and the role CLI."""

import asyncio
import datetime as dt
from typing import Any

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration
CLIENT = "+919833330001"


@pytest.fixture
def live(make_live, login):  # type: ignore[no-untyped-def]
    headers, aid, slug = make_live("+919833330100")
    login(CLIENT)
    return headers, aid, slug


def review(client: TestClient, headers: dict[str, str], session_id: str, **body: Any) -> Any:
    return client.post(
        f"/v1/consult-sessions/{session_id}/review",
        json={"rating": 5, "text": "Clear and kind.", **body},
        headers=headers,
    )


def test_review_only_after_own_completed_session(client: TestClient, live, login, consult) -> None:  # type: ignore[no-untyped-def]
    _, aid, slug = live
    me = login(CLIENT)
    stranger = login("+919833330002")
    sid = consult(CLIENT, aid)
    active = consult(CLIENT, aid, "active")

    assert review(client, stranger, sid).status_code == 404  # not your session
    r = review(client, me, active)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "session_not_completed"
    assert review(client, me, "00000000-0000-0000-0000-000000000000").status_code == 404
    assert review(client, {}, sid).status_code == 401

    r = review(client, me, sid, rating=4, text="  Helpful reading.  ")
    assert r.status_code == 201
    assert r.json()["status"] == "published" and r.json()["text"] == "Helpful reading."
    r = review(client, me, sid)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_reviewed"

    body = client.get(f"/v1/astrologers/{slug}/reviews").json()
    assert body["rating"] == {"average": 4.0, "count": 1}
    assert body["items"][0]["author_label"] == "Verified client"
    assert "+91" not in str(body)
    assert client.get(f"/v1/astrologers/{slug}").json()["rating"]["count"] == 1

    assert review(client, me, sid, rating=6).status_code == 422
    other = consult(CLIENT, aid)
    assert review(client, me, other, text="x" * 1001).json()["detail"]["code"] == "text_too_long"


@pytest.mark.parametrize(
    "text",
    [
        "Call me on 98765 43210 for a cheaper reading",
        "Email me at someone@example.com",
        "Book at www.example.com instead",
        "Message on WhatsApp",
        "He cured my diabetes",
        "Total chutiya",
    ],
)
def test_auto_moderation_holds_review(client: TestClient, live, login, consult, text: str) -> None:  # type: ignore[no-untyped-def]
    _, aid, slug = live
    me = login(CLIENT)
    r = review(client, me, consult(CLIENT, aid), text=text)
    assert r.status_code == 201 and r.json()["status"] == "pending_moderation"
    body = client.get(f"/v1/astrologers/{slug}/reviews").json()
    assert body["items"] == [] and body["rating"]["count"] == 0


def test_reply_once_by_the_reviewed_astrologer(
    client: TestClient, live: Any, login: Any, consult: Any, make_live: Any
) -> None:
    astro_headers, aid, slug = live
    other_astro, _, _ = make_live("+919833330101", display_name="Other One")
    me = login(CLIENT)
    rid = review(client, me, consult(CLIENT, aid)).json()["id"]

    assert (
        client.post(f"/v1/reviews/{rid}/reply", json={"text": "Thanks"}, headers=me).status_code
        == 404
    )
    assert (
        client.post(
            f"/v1/reviews/{rid}/reply", json={"text": "Thanks"}, headers=other_astro
        ).status_code
        == 404
    )
    r = client.post(
        f"/v1/reviews/{rid}/reply", json={"text": "Call 9876543210"}, headers=astro_headers
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "reply_not_allowed"
    r = client.post(f"/v1/reviews/{rid}/reply", json={"text": "Thank you."}, headers=astro_headers)
    assert r.status_code == 200
    r = client.post(f"/v1/reviews/{rid}/reply", json={"text": "Again"}, headers=astro_headers)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_replied"
    item = client.get(f"/v1/astrologers/{slug}/reviews").json()["items"][0]
    assert item["reply"]["text"] == "Thank you."


def test_report_and_moderation(client: TestClient, live, login, consult, admin_headers) -> None:  # type: ignore[no-untyped-def]
    _, aid, slug = live
    me = login(CLIENT)
    rid = review(client, me, consult(CLIENT, aid)).json()["id"]
    reporter = login("+919833330003")
    for _ in range(3):  # repeats by one user count once
        r = client.post(
            f"/v1/reviews/{rid}/report", json={"reason": "seems fake"}, headers=reporter
        )
        assert r.status_code == 202
    client.post(f"/v1/reviews/{rid}/report", json={"reason": "spam"}, headers=me)

    flagged = client.get("/v1/admin/reviews", params={"status": "flagged"}, headers=admin_headers)
    item = flagged.json()["items"][0]
    assert (item["id"], item["report_count"], item["held"]) == (rid, 2, False)
    # Reported reviews stay visible until a moderator acts.
    assert len(client.get(f"/v1/astrologers/{slug}/reviews").json()["items"]) == 1

    r = client.post(f"/v1/admin/reviews/{rid}/hide", json={"reason": "fake"}, headers=admin_headers)
    assert r.json()["status"] == "hidden"
    assert client.get(f"/v1/astrologers/{slug}/reviews").json()["items"] == []
    assert (
        client.post(f"/v1/reviews/{rid}/report", json={"reason": "x" * 5}, headers=me).status_code
        == 404
    )
    r = client.post(f"/v1/admin/reviews/{rid}/unhide", headers=admin_headers)
    assert r.json()["status"] == "published"
    assert len(client.get(f"/v1/astrologers/{slug}/reviews").json()["items"]) == 1

    # A held review is published by a moderator after checking it.
    held = review(client, me, consult(CLIENT, aid), text="visit www.example.com").json()
    queue = client.get("/v1/admin/reviews", params={"status": "flagged"}, headers=admin_headers)
    assert any(i["id"] == held["id"] and i["held"] for i in queue.json()["items"])
    client.post(f"/v1/admin/reviews/{held['id']}/unhide", headers=admin_headers)
    assert len(client.get(f"/v1/astrologers/{slug}/reviews").json()["items"]) == 2
    actions = {
        e["action"]
        for e in client.get(f"/v1/admin/astrologers/{aid}", headers=admin_headers).json()["audit"]
    }
    assert "astrologer.approve" in actions


def test_presence_and_wait_time(client: TestClient, live, login) -> None:  # type: ignore[no-untyped-def]
    astro_headers, aid, slug = live
    assert client.get(f"/v1/astrologers/{slug}").json()["presence"] == "offline"
    r = client.post("/v1/astrologer/me/presence", json={"status": "online"}, headers=astro_headers)
    assert r.json() == {"presence": "online", "wait_minutes": None, "ttl_s": 120}
    assert client.get(f"/v1/astrologers/{slug}").json()["presence"] == "online"
    listed = client.get("/v1/astrologers", params={"online": "true"}).json()
    assert [i["slug"] for i in listed["items"]] == [slug]

    # Busy (set by sessions in Phase 4) is not overridden by a heartbeat and carries a wait time.
    redis = client.app.state.redis  # type: ignore[attr-defined]
    until = dt.datetime.now(dt.UTC) + dt.timedelta(minutes=12, seconds=30)

    async def set_busy() -> None:
        await redis.set(f"presence:{aid}", "busy")
        await redis.set(f"busy_until:{aid}", str(until.timestamp()))

    client.portal.call(set_busy)  # type: ignore[union-attr]
    r = client.post("/v1/astrologer/me/presence", json={"status": "online"}, headers=astro_headers)
    assert r.json()["presence"] == "busy" and r.json()["wait_minutes"] == 13
    profile = client.get(f"/v1/astrologers/{slug}").json()
    assert (profile["presence"], profile["wait_minutes"]) == ("busy", 13)
    client.post("/v1/astrologer/me/presence", json={"status": "offline"}, headers=astro_headers)
    assert client.get(f"/v1/astrologers/{slug}").json()["presence"] == "busy"

    # Applicants who are not live cannot set presence.
    applicant = login("+919833330004")
    client.post(
        "/v1/astrologer/application",
        json={
            "display_name": "Not Live",
            "bio": "Still waiting for verification to complete.",
            "skills": ["tarot"],
            "languages": ["en"],
            "gender": "male",
            "experience_years": 3,
            "requested_price_per_min_paise": 1500,
            "accepts_terms": True,
        },
        headers=applicant,
    )
    r = client.post("/v1/astrologer/me/presence", json={"status": "online"}, headers=applicant)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_live"


def test_seed_is_labelled_idempotent_and_refused_in_production(clean) -> None:  # type: ignore[no-untyped-def]
    from redis.asyncio import Redis
    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import create_async_engine

    from astro_api.db import make_sessionmaker
    from astro_api.models import Astrologer, Review, User
    from astro_api.phone import normalize_phone
    from astro_api.seed import SeedRefused, seed_demo_astrologers

    async def run() -> list[Any]:
        engine = create_async_engine(clean.database_url.get_secret_value())
        redis = Redis.from_url(clean.redis_url.get_secret_value())
        maker = make_sessionmaker(engine)
        try:
            first = await seed_demo_astrologers(maker, redis, clean, count=12)
            second = await seed_demo_astrologers(maker, redis, clean, count=12)
            with pytest.raises(SeedRefused):
                await seed_demo_astrologers(
                    maker, redis, clean.model_copy(update={"app_env": "production"})
                )
            async with maker() as db:
                n_astro = (
                    await db.execute(select(func.count()).select_from(Astrologer))
                ).scalar_one()
                names = list((await db.execute(select(Astrologer.display_name))).scalars())
                bios = list((await db.execute(select(Astrologer.bio))).scalars())
                texts = list((await db.execute(select(Review.text))).scalars())
                phones = list((await db.execute(select(User.phone))).scalars())
                seeds = set((await db.execute(select(Astrologer.is_seed))).scalars())
            return [first, second, n_astro, names, bios, texts, phones, seeds, normalize_phone]
        finally:
            await redis.aclose()
            await engine.dispose()

    first, second, n_astro, names, bios, texts, phones, seeds, normalize = asyncio.run(run())
    assert first == second
    assert n_astro == 12 + 5
    assert all(n.startswith(("Demo Astrologer", "Demo Applicant")) for n in names)
    assert all(b.startswith("[Demo profile]") for b in bios)
    assert texts and all(t.startswith("[Demo review]") for t in texts)
    assert seeds == {True}
    # Seed accounts can never sign in: their numbers are not valid Indian mobiles.
    from astro_api.errors import ApiError

    for p in phones:
        with pytest.raises(ApiError):
            normalize(p)


def test_cli_grant_and_revoke_role(clean, monkeypatch: pytest.MonkeyPatch, capsys) -> None:  # type: ignore[no-untyped-def]
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine

    from astro_api import cli
    from astro_api.config import get_settings
    from astro_api.db import make_sessionmaker
    from astro_api.models import User

    monkeypatch.setenv("DATABASE_URL", clean.database_url.get_secret_value())
    get_settings.cache_clear()

    async def roles() -> list[str]:
        engine = create_async_engine(clean.database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                user = (
                    await db.execute(select(User).where(User.phone == "+919833339999"))
                ).scalar_one()
                return list(user.roles)
        finally:
            await engine.dispose()

    assert cli.main(["grant-role", "98333 39999", "admin"]) == 0
    assert asyncio.run(roles()) == ["admin"]
    assert "98333" not in capsys.readouterr().out  # masked
    assert cli.main(["revoke-role", "+919833339999", "admin"]) == 0
    assert asyncio.run(roles()) == []
    assert cli.main(["grant-role", "12345", "admin"]) == 2
    with pytest.raises(SystemExit):
        cli.main(["grant-role", "9833339999", "superuser"])
    get_settings.cache_clear()
