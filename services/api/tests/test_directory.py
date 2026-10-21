"""Directory filters and sorts against the demo seed (PLAN.md Phase 3 acceptance: filter + sort
combinations covered by tests; unapproved astrologers invisible everywhere).

The expected result for every query is computed independently from raw database rows and Redis
presence, then compared with what the API returns across all pages.
"""

import asyncio
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import SecretStr

pytestmark = pytest.mark.integration

SORTS = ("recommended", "price_asc", "price_desc", "experience", "rating")
FILTER_SETS: list[dict[str, Any]] = [
    {},
    {"skill": ["vedic"]},
    {"skill": ["tarot", "numerology"]},
    {"language": ["hi"]},
    {"language": ["ta", "te", "kn"]},
    {"gender": "female"},
    {"gender": "other"},
    {"tier": "rising"},
    {"tier": "celebrity"},
    {"min_price": 2000, "max_price": 8000},
    {"max_price": 3000},
    {"online": "true"},
    {"skill": ["vedic", "kp"], "language": ["hi", "en"], "gender": "male"},
    {"tier": "top_choice", "online": "true", "skill": ["vastu", "palmistry", "lal_kitab"]},
    {"skill": ["nadi"], "language": ["ur"], "tier": "celebrity", "gender": "female"},
]


def _settings(documents_dir: Path):  # type: ignore[no-untyped-def]
    from astro_api.config import Settings

    base = os.environ["REDIS_URL"].rsplit("/", 1)[0]
    return Settings(
        app_env="test",
        database_url=SecretStr(os.environ["DATABASE_URL"]),
        redis_url=SecretStr(f"{base}/15"),
        secret_key=SecretStr("test-secret-key-for-hmac-0123456789"),
        documents_dir=documents_dir,
    )


async def _reset_and_seed(s: Any) -> None:
    from redis.asyncio import Redis
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    from astro_api.db import make_sessionmaker
    from astro_api.seed import seed_demo_astrologers

    engine = create_async_engine(s.database_url.get_secret_value())
    redis = Redis.from_url(s.redis_url.get_secret_value())
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "TRUNCATE audit_log, reviews, consult_sessions, kyc_documents, "
                    "astrologer_verifications, astrologers, auth_sessions, saved_kundlis, users "
                    "RESTART IDENTITY CASCADE"
                )
            )
        await redis.flushdb()
        await seed_demo_astrologers(make_sessionmaker(engine), redis, s, count=30)
    finally:
        await redis.aclose()
        await engine.dispose()


async def _snapshot(s: Any) -> list[dict[str, Any]]:
    """Raw rows for the oracle: every astrologer, its visible reviews and its presence."""
    from redis.asyncio import Redis
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(s.database_url.get_secret_value())
    redis = Redis.from_url(s.redis_url.get_secret_value())
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        """
                        SELECT a.id::text AS id, a.slug, a.status::text AS status, a.skills,
                               a.languages, a.gender::text AS gender, a.tier,
                               a.price_per_min_paise AS price, a.experience_years AS exp,
                               (a.flags->>'show_in_directory')::boolean AS shown, a.is_seed,
                               COUNT(r.id) AS n, COALESCE(SUM(r.rating), 0) AS total
                        FROM astrologers a
                        LEFT JOIN reviews r ON r.astrologer_id = a.id AND (
                            r.status = 'published'
                            OR (r.status = 'flagged' AND r.auto_flag_reason IS NULL))
                        GROUP BY a.id
                        """
                    )
                )
            ).mappings()
            out = [dict(r) for r in rows]
        for r in out:
            raw = await redis.get(f"presence:{r['id']}")
            state = raw.decode() if isinstance(raw, bytes) else raw
            r["presence"] = state if state in ("online", "busy") else "offline"
        return out
    finally:
        await redis.aclose()
        await engine.dispose()


@pytest.fixture(scope="module")
def seeded(
    migrated: None, documents_dir: Path
) -> Iterator[tuple[TestClient, list[dict[str, Any]]]]:
    from astro_api.main import create_app

    s = _settings(documents_dir)
    asyncio.run(_reset_and_seed(s))
    snapshot = asyncio.run(_snapshot(s))
    with TestClient(create_app(s)) as c:
        yield c, snapshot


def _as_list(v: Any) -> list[str]:
    return v if isinstance(v, list) else [v]


def expected(snapshot: list[dict[str, Any]], params: dict[str, Any], sort: str) -> list[str]:
    rows = [r for r in snapshot if r["status"] in ("probation", "approved") and r["shown"]]
    if "skill" in params:
        rows = [r for r in rows if set(r["skills"]) & set(_as_list(params["skill"]))]
    if "language" in params:
        rows = [r for r in rows if set(r["languages"]) & set(_as_list(params["language"]))]
    if "gender" in params:
        rows = [r for r in rows if r["gender"] == params["gender"]]
    if "tier" in params:
        rows = [r for r in rows if r["tier"] == params["tier"]]
    if "min_price" in params:
        rows = [r for r in rows if r["price"] >= params["min_price"]]
    if "max_price" in params:
        rows = [r for r in rows if r["price"] <= params["max_price"]]
    if params.get("online") == "true":
        rows = [r for r in rows if r["presence"] == "online"]

    def bayes(r: dict[str, Any]) -> float:
        return float((5 * 4.0 + r["total"]) / (5 + r["n"]))

    rank = {"online": 0, "busy": 1, "offline": 2}
    keys = {
        "price_asc": lambda r: (r["price"], r["id"]),
        "price_desc": lambda r: (-r["price"], r["id"]),
        "experience": lambda r: (-r["exp"], r["id"]),
        "rating": lambda r: (-bayes(r), -r["n"], r["id"]),
        "recommended": lambda r: (rank[r["presence"]], -bayes(r), -r["exp"], r["id"]),
    }
    return [r["slug"] for r in sorted(rows, key=keys[sort])]


def collect(
    client: TestClient, params: dict[str, Any], sort: str, limit: int
) -> tuple[list[dict[str, Any]], int]:
    items: list[dict[str, Any]] = []
    cursor = None
    totals = set()
    for _ in range(100):
        q = {**params, "sort": sort, "limit": limit}
        if cursor:
            q["cursor"] = cursor
        r = client.get("/v1/astrologers", params=q)
        assert r.status_code == 200, r.text
        body = r.json()
        totals.add(body["total"])
        items += body["items"]
        cursor = body["next_cursor"]
        if not cursor:
            break
    assert len(totals) == 1, "total must not change between pages"
    return items, totals.pop()


def check(
    client: TestClient,
    snapshot: list[dict[str, Any]],
    params: dict[str, Any],
    sort: str,
    limit: int = 7,
) -> None:
    items, total = collect(client, params, sort, limit)
    slugs = [i["slug"] for i in items]
    assert len(slugs) == len(set(slugs)), "pages overlap"
    assert len(slugs) == total, "pages skip or repeat items"
    assert slugs == expected(snapshot, params, sort)
    for i in items:
        if "skill" in params:
            assert set(i["skills"]) & set(_as_list(params["skill"]))
        if "language" in params:
            assert set(i["languages"]) & set(_as_list(params["language"]))
        if "gender" in params:
            assert i["gender"] == params["gender"]
        if "tier" in params:
            assert i["tier"] == params["tier"]
        if "min_price" in params:
            assert i["price_per_min_paise"] >= params["min_price"]
        if "max_price" in params:
            assert i["price_per_min_paise"] <= params["max_price"]
        if params.get("online") == "true":
            assert i["presence"] == "online"
        assert i["is_demo"] is True


def test_seed_has_variety(seeded: tuple[TestClient, list[dict[str, Any]]]) -> None:
    _, snapshot = seeded
    public = [r for r in snapshot if r["status"] in ("probation", "approved")]
    assert len(public) == 30
    assert {s for r in public for s in r["skills"]} >= {
        "vedic",
        "kp",
        "nadi",
        "prashna",
        "numerology",
        "tarot",
        "vastu",
        "palmistry",
        "lal_kitab",
    }
    assert len({lang for r in public for lang in r["languages"]}) >= 8
    assert {r["gender"] for r in public} == {"female", "male", "other"}
    assert {r["tier"] for r in public} == {"rising", "top_choice", "celebrity"}
    assert {r["presence"] for r in public} == {"online", "busy", "offline"}


@pytest.mark.parametrize("sort", SORTS)
@pytest.mark.parametrize(
    "params", FILTER_SETS, ids=lambda p: ",".join(f"{k}={v}" for k, v in p.items()) or "none"
)
def test_filters_and_sorts(
    seeded: tuple[TestClient, list[dict[str, Any]]], params: dict[str, Any], sort: str
) -> None:
    client, snapshot = seeded
    check(client, snapshot, params, sort)


TAX = {
    "skill": [
        "vedic",
        "kp",
        "nadi",
        "prashna",
        "numerology",
        "tarot",
        "vastu",
        "palmistry",
        "lal_kitab",
    ],
    "language": ["hi", "en", "bn", "mr", "ta", "te", "gu", "kn", "ml", "pa", "or", "ur"],
}


@settings(
    max_examples=40, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture]
)
@given(
    skills=st.lists(st.sampled_from(TAX["skill"]), max_size=3, unique=True),
    languages=st.lists(st.sampled_from(TAX["language"]), max_size=3, unique=True),
    gender=st.sampled_from([None, "female", "male", "other"]),
    tier=st.sampled_from([None, "rising", "top_choice", "celebrity"]),
    price=st.one_of(st.none(), st.tuples(st.integers(0, 30000), st.integers(0, 30000)).map(sorted)),
    online=st.booleans(),
    sort=st.sampled_from(SORTS),
    limit=st.integers(1, 11),
)
def test_random_filter_combinations(
    seeded: tuple[TestClient, list[dict[str, Any]]],
    skills: list[str],
    languages: list[str],
    gender: str | None,
    tier: str | None,
    price: list[int] | None,
    online: bool,
    sort: str,
    limit: int,
) -> None:
    client, snapshot = seeded
    params: dict[str, Any] = {}
    if skills:
        params["skill"] = skills
    if languages:
        params["language"] = languages
    if gender:
        params["gender"] = gender
    if tier:
        params["tier"] = tier
    if price:
        params["min_price"], params["max_price"] = price
    if online:
        params["online"] = "true"
    check(client, snapshot, params, sort, limit)


def test_invalid_filters(seeded: tuple[TestClient, list[dict[str, Any]]]) -> None:
    client, _ = seeded
    for params in (
        {"skill": "astrology"},
        {"language": "xx"},
        {"gender": "unknown"},
        {"tier": "gold"},
        {"min_price": 5000, "max_price": 100},
    ):
        r = client.get("/v1/astrologers", params=params)
        assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_filter", params
    assert client.get("/v1/astrologers", params={"sort": "random"}).status_code == 422
    assert client.get("/v1/astrologers", params={"cursor": "%%%"}).json()["detail"]["code"] == (
        "invalid_cursor"
    )
    assert client.get("/v1/astrologers", params={"limit": 51}).status_code == 422


def test_non_public_astrologers_are_invisible_everywhere(
    seeded: tuple[TestClient, list[dict[str, Any]]],
) -> None:
    client, snapshot = seeded
    hidden = [r for r in snapshot if r["status"] not in ("probation", "approved")]
    assert {r["status"] for r in hidden} == {
        "applied",
        "kyc_submitted",
        "interview",
        "suspended",
        "rejected",
    }
    listed, _ = collect(client, {}, "recommended", 50)
    listed_slugs = {i["slug"] for i in listed}
    sitemap = {s["slug"] for s in client.get("/v1/astrologers/slugs").json()}
    for r in hidden:
        assert r["slug"] not in listed_slugs
        assert r["slug"] not in sitemap
        assert client.get(f"/v1/astrologers/{r['slug']}").status_code == 404
        assert client.get(f"/v1/astrologers/{r['slug']}/reviews").status_code == 404


def test_seed_rows_never_public_in_production(
    seeded: tuple[TestClient, list[dict[str, Any]]], documents_dir: Path
) -> None:
    """The visibility rule itself excludes seed rows in staging/production."""
    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import create_async_engine

    from astro_api.marketplace import is_public, public_condition
    from astro_api.models import Astrologer

    dev = _settings(documents_dir)
    prod = dev.model_copy(update={"app_env": "production"})

    async def count(s: Any) -> tuple[int, list[bool]]:
        engine = create_async_engine(dev.database_url.get_secret_value())
        try:
            async with engine.connect() as conn:
                n = (
                    await conn.execute(select(func.count()).where(public_condition(s)))
                ).scalar_one()
            from astro_api.db import make_sessionmaker

            async with make_sessionmaker(engine)() as db:
                rows = (await db.execute(select(Astrologer))).scalars().all()
                return int(n), [is_public(a, s) for a in rows]
        finally:
            await engine.dispose()

    n_dev, flags_dev = asyncio.run(count(dev))
    n_prod, flags_prod = asyncio.run(count(prod))
    assert n_dev == 30 and sum(flags_dev) == 30
    assert n_prod == 0 and not any(flags_prod)


def test_review_listing_and_rating(seeded: tuple[TestClient, list[dict[str, Any]]]) -> None:
    client, snapshot = seeded
    row = next(r for r in snapshot if r["slug"] == "demo-astrologer-01")
    body = client.get("/v1/astrologers/demo-astrologer-01/reviews", params={"limit": 50}).json()
    assert body["rating"]["count"] == row["n"]
    assert body["rating"]["average"] == round(row["total"] / row["n"], 2)
    assert all(i["author_label"] == "Verified client" for i in body["items"])
    assert all(i["text"].startswith("[Demo review]") for i in body["items"])
    # The held review (auto-moderation) is not public; the reported one still is.
    texts = [i["text"] for i in body["items"]]
    assert len(texts) == row["n"]
    dates = [i["created_at"] for i in body["items"]]
    assert dates == sorted(dates, reverse=True)
    profile = client.get("/v1/astrologers/demo-astrologer-01").json()
    assert profile["rating"] == body["rating"]
    assert profile["bio"].startswith("[Demo profile]")
    assert profile["verified"] == {"identity": True, "qualification": True, "interview": True}
