import asyncio
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

# Unit tests must not need real services; integration tests opt in via the marker.
os.environ.setdefault("APP_ENV", "test")

API_DIR = Path(__file__).resolve().parents[1]
ADMIN_PHONE = "+919000000001"


def services_available() -> bool:
    return bool(os.environ.get("DATABASE_URL")) and bool(os.environ.get("REDIS_URL"))


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if services_available():
        return
    skip = pytest.mark.skip(reason="DATABASE_URL/REDIS_URL not set")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


def _test_redis_url() -> str:
    """Integration tests use Redis database 15 (or TEST_REDIS_DB) so they never touch development
    data."""
    base = os.environ["REDIS_URL"].rsplit("/", 1)[0]
    return f"{base}/{os.environ.get('TEST_REDIS_DB', '15')}"


@pytest.fixture(scope="session")
def migrated() -> None:
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=API_DIR, check=True)


@pytest.fixture(scope="session")
def documents_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("kyc-documents")


def make_settings(documents_dir: Path):  # type: ignore[no-untyped-def]
    from astro_api.config import Settings

    return Settings(
        app_env="test",
        database_url=SecretStr(os.environ["DATABASE_URL"]),
        redis_url=SecretStr(_test_redis_url()),
        secret_key=SecretStr("test-secret-key-for-hmac-0123456789"),
        documents_dir=documents_dir,
    )


@pytest.fixture
def settings(migrated: None, documents_dir: Path):  # type: ignore[no-untyped-def]
    return make_settings(documents_dir)


async def _truncate(url: str) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(url)
    async with engine.begin() as conn:
        # Every application table, so new phases never need to edit this list.
        tables = (
            await conn.execute(
                text(
                    "SELECT quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' "
                    "AND tablename <> 'alembic_version'"
                )
            )
        ).scalars()
        await conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    await engine.dispose()


@pytest.fixture
def clean(settings):  # type: ignore[no-untyped-def]
    import redis

    from astro_api.sms import ConsoleSms

    asyncio.run(_truncate(settings.database_url.get_secret_value()))
    r = redis.Redis.from_url(settings.redis_url.get_secret_value())
    r.flushdb()
    r.close()
    ConsoleSms.outbox.clear()
    return settings


@pytest.fixture
def client(clean) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    from astro_api.main import create_app

    with TestClient(create_app(clean)) as c:
        yield c


async def _session_for(url: str, phone: str, roles: tuple[str, ...], consents: bool = True) -> str:
    """Create (or reuse) a user and a fresh bearer session directly in the database, so tests can
    sign in many users without the OTP rate limits. With `consents` the user also holds every
    consent kind at the current policies version (Phase 7 enforcement)."""
    import datetime as dt
    import secrets

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine

    from astro_api.auth import hash_token
    from astro_api.db import make_sessionmaker
    from astro_api.models import AuthSession, User

    engine = create_async_engine(url)
    try:
        async with make_sessionmaker(engine)() as db:
            user = (await db.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
            if user is None:
                user = User(phone=phone, device_ids=[], roles=list(roles))
                db.add(user)
            else:
                user.roles = sorted(set(user.roles) | set(roles))
            await db.flush()
            if consents:
                from astro_api import consent
                from astro_api.models_privacy import CONSENT_KINDS

                await consent.record(
                    db,
                    user,
                    CONSENT_KINDS,
                    version=consent.current_version(),
                    ip_hash=None,
                    device_hash=None,
                )
            token = secrets.token_urlsafe(32)
            db.add(
                AuthSession(
                    user_id=user.id,
                    token_hash=hash_token(token),
                    expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=1),
                )
            )
            await db.commit()
            return token
    finally:
        await engine.dispose()


@pytest.fixture
def login(clean):  # type: ignore[no-untyped-def]
    """login(phone, *roles, consents=True) -> Authorization headers for that user."""

    def _login(phone: str, *roles: str, consents: bool = True) -> dict[str, str]:
        url = clean.database_url.get_secret_value()
        token = asyncio.run(_session_for(url, phone, roles, consents))
        return {"Authorization": f"Bearer {token}"}

    return _login


@pytest.fixture
def admin_headers(login) -> dict[str, str]:  # type: ignore[no-untyped-def]
    return login(ADMIN_PHONE, "admin")  # type: ignore[no-any-return]


# ---------------------------------------------------------------- marketplace helpers

PDF = b"%PDF-1.4\n% test document\n"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def application(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "display_name": "Asha Verma",
        "bio": "Vedic astrologer with a calm, practical approach to chart reading.",
        "skills": ["vedic", "numerology"],
        "languages": ["hi", "en"],
        "gender": "female",
        "experience_years": 12,
        "requested_price_per_min_paise": 2500,
        "accepts_terms": True,
    }
    body.update(overrides)
    return body


@pytest.fixture
def make_live(client: TestClient, login, admin_headers):  # type: ignore[no-untyped-def]
    """make_live(phone, **application overrides) drives an application to `probation` (public)
    and returns (applicant headers, astrologer id, slug)."""

    def _make(
        phone: str, tier: str = "rising", price: int = 2000, **overrides: object
    ) -> tuple[dict[str, str], str, str]:
        headers = login(phone)
        r = client.post(
            "/v1/astrologer/application", json=application(**overrides), headers=headers
        )
        assert r.status_code == 201, r.text
        aid, slug = r.json()["id"], r.json()["slug"]
        for kind, data in (("identity", PDF), ("qualification", PNG)):
            r = client.post(
                "/v1/astrologer/me/documents",
                files={"file": (f"{kind}.bin", data, "application/octet-stream")},
                data={"kind": kind},
                headers=headers,
            )
            assert r.status_code == 201, r.text
        for step in ("identity", "qualification", "interview"):
            r = client.post(
                f"/v1/admin/astrologers/{aid}/verifications/{step}",
                json={"status": "passed"},
                headers=admin_headers,
            )
            assert r.status_code == 200, r.text
        r = client.post(
            f"/v1/admin/astrologers/{aid}/approve",
            json={"tier": tier, "price_per_min_paise": price},
            headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        return headers, aid, slug

    return _make


async def _completed_session(url: str, user_phone: str, astrologer_id: str, status: str) -> str:
    import datetime as dt
    import uuid

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine

    from astro_api.db import make_sessionmaker
    from astro_api.models import ConsultSession, User

    engine = create_async_engine(url)
    try:
        async with make_sessionmaker(engine)() as db:
            user = (await db.execute(select(User).where(User.phone == user_phone))).scalar_one()
            now = dt.datetime.now(dt.UTC)
            s = ConsultSession(
                user_id=user.id,
                astrologer_id=uuid.UUID(astrologer_id),
                kind="chat",
                status=status,
                started_at=now - dt.timedelta(minutes=20),
                ended_at=now if status == "completed" else None,
            )
            db.add(s)
            await db.commit()
            return str(s.id)
    finally:
        await engine.dispose()


@pytest.fixture
def consult(clean):  # type: ignore[no-untyped-def]
    """consult(user_phone, astrologer_id, status="completed") -> session id, inserted directly."""

    def _consult(phone: str, astrologer_id: str, status: str = "completed") -> str:
        return asyncio.run(
            _completed_session(clean.database_url.get_secret_value(), phone, astrologer_id, status)
        )

    return _consult
