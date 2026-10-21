import asyncio

import pytest

from astro_api.ratelimit import hit, incr_window

pytestmark = pytest.mark.integration


def test_window_always_expires_even_if_a_crash_left_the_key_without_ttl(clean) -> None:  # type: ignore[no-untyped-def]
    """INCR and EXPIRE were separate calls: a crash between them left a key that never expired,
    rate-limiting that phone/IP/session forever."""
    from redis.asyncio import Redis

    async def run() -> None:
        redis = Redis.from_url(clean.redis_url.get_secret_value())
        try:
            await redis.set("rl:test:stuck", 1)  # what a crash after INCR used to leave
            await hit(redis, "rl:test:stuck", 10, 60)
            assert 0 < await redis.ttl("rl:test:stuck") <= 60
            assert await incr_window(redis, "rl:test:fresh", 30) == 1
            assert await incr_window(redis, "rl:test:fresh", 30) == 2
            assert 0 < await redis.ttl("rl:test:fresh") <= 30
        finally:
            await redis.aclose()

    asyncio.run(run())
