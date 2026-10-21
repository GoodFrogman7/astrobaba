"""Connection pools are sized from settings (Phase 8 load test: redis-py's default of 100
connections ran out at ~50 concurrent chats, because every chat socket holds one for pub/sub)."""

import asyncio

from pydantic import SecretStr

from astro_api.config import Settings
from astro_api.db import make_engine, make_redis


def settings(**overrides: object) -> Settings:
    return Settings(
        app_env="test",
        database_url=SecretStr("postgresql+asyncpg://u:p@localhost:5432/db"),
        redis_url=SecretStr("redis://localhost:6379/0"),
        **overrides,  # type: ignore[arg-type]
    )


def test_redis_pool_allows_one_connection_per_chat_socket() -> None:
    s = settings()
    assert s.redis_max_connections >= 2000
    redis = make_redis(s)
    assert redis.connection_pool.max_connections == s.redis_max_connections
    asyncio.run(redis.aclose())
    assert make_redis(settings(redis_max_connections=50)).connection_pool.max_connections == 50


def test_database_pool_size_comes_from_settings() -> None:
    s = settings(db_pool_size=12, db_max_overflow=8)
    engine = make_engine(s.database_url.get_secret_value(), s)
    assert engine.pool.size() == 12  # type: ignore[attr-defined]
    assert engine.pool._max_overflow == 8  # type: ignore[attr-defined]
    asyncio.run(engine.dispose())
