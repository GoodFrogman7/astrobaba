"""Astrologer invites (docs/api/growth.md §2.1): creation (code shown once, stored as HMAC),
derived statuses, revoke, applying with a code (single use, also under concurrency) and the
`astrologer_invite_only` flag."""

import asyncio
import datetime as dt
import re
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import applicant, growth_api
from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.errors import ApiError
from astro_api.models import User
from services.api.tests.conftest import application

pytestmark = pytest.mark.integration

INVITES = "/v1/admin/astrologer-invites"
APPLY = "/v1/astrologer/application"
CODE = re.compile(r"^[A-HJ-NP-Z2-9]{12}$")


def settings_of(client: TestClient) -> Settings:
    s: Settings = client.app.state.settings  # type: ignore[attr-defined]
    return s


def sql(client: TestClient, query: str, **params: Any) -> list[Any]:
    async def run() -> list[Any]:
        eng = create_async_engine(settings_of(client).database_url.get_secret_value())
        try:
            async with eng.begin() as conn:
                result = await conn.execute(text(query), params)
                return list(result.all()) if result.returns_rows else []
        finally:
            await eng.dispose()

    return asyncio.run(run())


def create(client: TestClient, admin: dict[str, str], **body: Any) -> dict[str, Any]:
    r = client.post(INVITES, json=body, headers=admin)
    assert r.status_code == 201, r.text
    out: dict[str, Any] = r.json()
    return out


def listed(client: TestClient, admin: dict[str, str], status: str | None = None) -> list[Any]:
    params = {"status": status} if status else {}
    r = client.get(INVITES, params=params, headers=admin)
    assert r.status_code == 200, r.text
    items: list[Any] = r.json()["items"]
    return items


# ---------------------------------------------------------------- unit


def test_code_alphabet_and_length() -> None:
    codes = {growth_api.new_invite_code() for _ in range(500)}
    assert len(codes) == 500
    assert all(CODE.fullmatch(c) for c in codes)
    assert set("".join(codes)) <= set(growth_api.INVITE_ALPHABET)
    assert not set("01IO") & set(growth_api.INVITE_ALPHABET)
    assert len(growth_api.INVITE_ALPHABET) == 32


def test_code_normalisation() -> None:
    assert growth_api.normalize_code(" abcd-efgh-jkmn ") == "ABCDEFGHJKMN"
    assert growth_api.normalize_code("ABCD EFGH JKMN") == "ABCDEFGHJKMN"


# ---------------------------------------------------------------- admin


def test_create_returns_code_once_and_stores_only_its_hmac(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    before = dt.datetime.now(dt.UTC)
    inv = create(client, admin_headers, note="Pandit from Varanasi referral")
    assert set(inv) == {"id", "code", "url", "expires_at"}
    assert CODE.fullmatch(inv["code"])
    assert (
        inv["url"]
        == f"{settings_of(client).public_site_url}/astrologers/apply?invite={inv['code']}"
    )
    expires = dt.datetime.fromisoformat(inv["expires_at"])
    assert dt.timedelta(days=13, hours=23) < expires - before < dt.timedelta(days=14, minutes=5)

    row = sql(client, "SELECT * FROM astrologer_invites")[0]._mapping
    assert inv["code"] not in str(dict(row))
    assert row["code_hash"] == growth_api.invite_hash(settings_of(client), inv["code"])

    items = listed(client, admin_headers)
    assert items == [
        {
            "id": inv["id"],
            "note": "Pandit from Varanasi referral",
            "status": "open",
            "created_at": items[0]["created_at"],
            "expires_at": items[0]["expires_at"],
            "used_at": None,
            "astrologer_id": None,
        }
    ]
    assert inv["code"] not in client.get(INVITES, headers=admin_headers).text

    audits = sql(client, "SELECT action, entity_id, detail::text FROM audit_log")
    assert [(a[0], a[1]) for a in audits] == [("astrologer_invite.create", inv["id"])]
    assert inv["code"] not in audits[0][2] and "Varanasi" not in audits[0][2]


def test_create_validation_and_admin_only(
    client: TestClient, admin_headers: dict[str, str], login: Any
) -> None:
    assert client.post(INVITES, json={"expires_days": 0}, headers=admin_headers).status_code == 422
    assert client.post(INVITES, json={"expires_days": 61}, headers=admin_headers).status_code == 422
    r = client.post(INVITES, json={"note": "x" * 201}, headers=admin_headers)
    assert r.status_code == 422
    inv = create(client, admin_headers, expires_days=60)
    expires = dt.datetime.fromisoformat(inv["expires_at"])
    assert expires - dt.datetime.now(dt.UTC) > dt.timedelta(days=59)

    user = login("+919822220009")
    assert client.post(INVITES, json={}, headers=user).status_code == 403
    assert client.get(INVITES, headers=user).status_code == 403
    r = client.post(f"{INVITES}/{inv['id']}/revoke", headers=user)
    assert r.status_code == 403
    assert client.get(INVITES).status_code == 401


def test_statuses_are_derived_with_precedence(
    client: TestClient, admin_headers: dict[str, str], login: Any
) -> None:
    open_ = create(client, admin_headers, note="open")
    expired = create(client, admin_headers, note="expired")
    revoked = create(client, admin_headers, note="revoked")
    used = create(client, admin_headers, note="used")
    sql(
        client,
        "UPDATE astrologer_invites SET created_at = now() - interval '20 days', "
        "expires_at = now() - interval '1 second' WHERE id IN (:a, :b)",
        a=expired["id"],
        b=revoked["id"],
    )
    r = client.post(f"{INVITES}/{revoked['id']}/revoke", headers=admin_headers)
    assert r.status_code == 200 and r.json()["status"] == "revoked"  # revoked beats expired
    r = client.post(
        APPLY, json=application(invite_code=used["code"]), headers=login("+919822220001")
    )
    assert r.status_code == 201, r.text

    by_note = {i["note"]: i for i in listed(client, admin_headers)}
    assert {n: i["status"] for n, i in by_note.items()} == {
        "open": "open",
        "expired": "expired",
        "revoked": "revoked",
        "used": "used",
    }
    assert by_note["used"]["astrologer_id"] == r.json()["id"]
    assert by_note["used"]["used_at"] is not None
    for status, inv in (
        ("open", open_),
        ("expired", expired),
        ("revoked", revoked),
        ("used", used),
    ):
        assert [i["id"] for i in listed(client, admin_headers, status)] == [inv["id"]]
    assert client.get(INVITES, params={"status": "nope"}, headers=admin_headers).status_code == 422


def test_revoke(client: TestClient, admin_headers: dict[str, str], login: Any) -> None:
    inv = create(client, admin_headers)
    r = client.post(f"{INVITES}/{inv['id']}/revoke", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {
        "id",
        "note",
        "status",
        "created_at",
        "expires_at",
        "used_at",
        "astrologer_id",
    }
    assert r.json()["status"] == "revoked"
    # Revoking again changes nothing and writes no second audit row.
    assert client.post(f"{INVITES}/{inv['id']}/revoke", headers=admin_headers).status_code == 200
    actions = [a[0] for a in sql(client, "SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["astrologer_invite.create", "astrologer_invite.revoke"]
    r = client.post(
        APPLY, json=application(invite_code=inv["code"]), headers=login("+919822220002")
    )
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "invite_invalid")

    used = create(client, admin_headers)
    r = client.post(
        APPLY, json=application(invite_code=used["code"]), headers=login("+919822220003")
    )
    assert r.status_code == 201
    r = client.post(f"{INVITES}/{used['id']}/revoke", headers=admin_headers)
    assert (r.status_code, r.json()["detail"]["code"]) == (409, "invite_used")
    missing = client.post(f"{INVITES}/{uuid.uuid4()}/revoke", headers=admin_headers)
    assert missing.status_code == 404


# ---------------------------------------------------------------- applying


def test_valid_code_is_marked_used_with_the_application(
    client: TestClient, admin_headers: dict[str, str], login: Any
) -> None:
    inv = create(client, admin_headers)
    # Lower case and separators are accepted: people type codes by hand.
    typed = "-".join(inv["code"][i : i + 4] for i in (0, 4, 8)).lower()
    r = client.post(APPLY, json=application(invite_code=typed), headers=login("+919822220004"))
    assert r.status_code == 201, r.text
    aid = r.json()["id"]
    rows = sql(
        client,
        "SELECT a.invite_id::text, i.used_by_astrologer_id::text, i.used_at IS NOT NULL "
        "FROM astrologers a JOIN astrologer_invites i ON i.id = a.invite_id",
    )
    assert rows == [(inv["id"], aid, True)]

    r = client.post(
        APPLY, json=application(invite_code=inv["code"]), headers=login("+919822220005")
    )
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "invite_invalid")
    assert sql(client, "SELECT count(*) FROM astrologers")[0][0] == 1

    # Account deletion removes the astrologer; the invite stays used (never reusable).
    sql(client, "DELETE FROM astrologers WHERE id = :i", i=aid)
    (item,) = listed(client, admin_headers)
    assert (item["status"], item["astrologer_id"]) == ("used", None)
    r = client.post(
        APPLY, json=application(invite_code=inv["code"]), headers=login("+919822220005")
    )
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "invite_invalid")


@pytest.mark.parametrize("case", ["unknown", "malformed", "expired", "revoked"])
def test_invalid_codes_are_422_and_write_nothing(
    client: TestClient, admin_headers: dict[str, str], login: Any, case: str
) -> None:
    inv = create(client, admin_headers)
    code = inv["code"]
    if case == "unknown":
        code = growth_api.new_invite_code()
    elif case == "malformed":
        code = "0O1I-not-a-code"
    elif case == "expired":
        sql(
            client,
            "UPDATE astrologer_invites SET created_at = now() - interval '20 days', "
            "expires_at = now() - interval '1 minute'",
        )
    else:
        client.post(f"{INVITES}/{inv['id']}/revoke", headers=admin_headers)
    r = client.post(APPLY, json=application(invite_code=code), headers=login("+919822220006"))
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "invite_invalid")
    assert sql(client, "SELECT count(*) FROM astrologers")[0][0] == 0
    assert (
        sql(client, "SELECT count(*) FROM astrologer_invites WHERE used_at IS NOT NULL")[0][0] == 0
    )


def test_invite_only_flag(
    client: TestClient, admin_headers: dict[str, str], login: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Off (the default): a code is optional.
    r = client.post(APPLY, json=application(), headers=login("+919822220010"))
    assert r.status_code == 201
    assert sql(client, "SELECT invite_id FROM astrologers")[0][0] is None

    monkeypatch.setenv("FLAG_ASTROLOGER_INVITE_ONLY", "true")
    for body in (application(), application(invite_code=""), application(invite_code="  ")):
        r = client.post(APPLY, json=body, headers=login("+919822220011"))
        assert (r.status_code, r.json()["detail"]["code"]) == (403, "invite_required")
    inv = create(client, admin_headers)
    r = client.post(
        APPLY, json=application(invite_code=inv["code"]), headers=login("+919822220011")
    )
    assert r.status_code == 201, r.text
    bad = growth_api.new_invite_code()
    r = client.post(APPLY, json=application(invite_code=bad), headers=login("+919822220012"))
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "invite_invalid")


async def _users(maker: Any, phones: list[str]) -> list[User]:
    async with maker() as db:
        users = [User(phone=p, device_ids=[], roles=[]) for p in phones]
        db.add_all(users)
        await db.commit()
        return users


def test_two_applications_with_one_code_exactly_one_wins(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    settings = settings_of(client)
    codes = [create(client, admin_headers)["code"] for _ in range(3)]

    async def run() -> list[list[str]]:
        eng = create_async_engine(settings.database_url.get_secret_value(), pool_size=10)
        maker = make_sessionmaker(eng)
        results: list[list[str]] = []
        try:
            for n, code in enumerate(codes):
                users = await _users(maker, [f"+91983333{n}{i:03d}" for i in range(4)])

                async def one(user: User, code: str = code) -> str:
                    async with maker() as db:
                        try:
                            await applicant.create_application(
                                db,
                                settings,
                                user,
                                applicant.ApplicationIn(**application(invite_code=code)),
                            )
                        except ApiError as exc:
                            return exc.code
                        return "created"

                results.append(sorted(await asyncio.gather(*(one(u) for u in users))))
        finally:
            await eng.dispose()
        return results

    for outcome in asyncio.run(run()):
        assert outcome == ["created", "invite_invalid", "invite_invalid", "invite_invalid"]
    assert sql(client, "SELECT count(*) FROM astrologers WHERE invite_id IS NOT NULL")[0][0] == 3
    rows = sql(
        client,
        "SELECT count(*) FROM astrologer_invites i JOIN astrologers a "
        "ON a.id = i.used_by_astrologer_id AND a.invite_id = i.id",
    )
    assert rows[0][0] == 3


@pytest.mark.parametrize("holder_commits", [True, False])
def test_a_claim_waits_for_the_lock_holder(
    client: TestClient, admin_headers: dict[str, str], holder_commits: bool
) -> None:
    """While one transaction holds the invite (as an application does until it commits), another
    application waits; it then re-reads the row: used by the holder → 422, holder rolled back →
    the code is still open and the waiting application gets it."""
    settings = settings_of(client)
    code = create(client, admin_headers)["code"]

    async def run() -> str:
        eng = create_async_engine(settings.database_url.get_secret_value())
        maker = make_sessionmaker(eng)
        try:
            (user,) = await _users(maker, ["+919844440002"])
            async with maker() as holder, maker() as second:
                invite = await growth_api.lock_open_invite(holder, settings, code)
                waiting = asyncio.create_task(
                    applicant.create_application(
                        second,
                        settings,
                        user,
                        applicant.ApplicationIn(**application(invite_code=code)),
                    )
                )
                await asyncio.sleep(0.5)
                assert not waiting.done()
                if holder_commits:
                    invite.revoked_at = dt.datetime.now(dt.UTC)
                    await holder.commit()
                else:
                    await holder.rollback()
                try:
                    await waiting
                except ApiError as exc:
                    return exc.code
                return "created"
        finally:
            await eng.dispose()

    expected = "invite_invalid" if holder_commits else "created"
    assert asyncio.run(run()) == expected
    count = sql(client, "SELECT count(*) FROM astrologers")[0][0]
    assert count == (0 if holder_commits else 1)


def test_invite_lookup_uses_the_hash(client: TestClient, admin_headers: dict[str, str]) -> None:
    settings = settings_of(client)
    code = create(client, admin_headers)["code"]

    async def run() -> str:
        eng = create_async_engine(settings.database_url.get_secret_value())
        try:
            async with make_sessionmaker(eng)() as db:
                from astro_api.models_growth import AstrologerInvite

                row = (await db.execute(select(AstrologerInvite))).scalar_one()
                locked = await growth_api.lock_open_invite(db, settings, code.lower())
                return str(locked.id == row.id)
        finally:
            await eng.dispose()

    assert asyncio.run(run()) == "True"
