import asyncio

import pytest

from astro_api.errors import ApiError
from astro_api.idempotency import Idempotency, idempotency_key

pytestmark = pytest.mark.integration


def test_header_validation() -> None:
    assert idempotency_key("abcDEF-123_x") == "abcDEF-123_x"
    for bad in (None, "short", "has space here", "x" * 129):
        with pytest.raises(ApiError) as e:
            idempotency_key(bad)
        assert e.value.code == "idempotency_key_required"


def test_replay_conflict_and_lock(clean) -> None:  # type: ignore[no-untyped-def]
    from redis.asyncio import Redis

    async def run() -> None:
        redis = Redis.from_url(clean.redis_url.get_secret_value())
        try:
            first = Idempotency(redis, scope="t:u1", key="key-0001", payload={"a": 1})
            assert await first.begin() is None
            # Same key while the first is running.
            with pytest.raises(ApiError) as e:
                await Idempotency(redis, scope="t:u1", key="key-0001", payload={"a": 1}).begin()
            assert e.value.code == "idempotency_in_progress"
            await first.finish(201, {"id": "x"})
            again = await Idempotency(redis, scope="t:u1", key="key-0001", payload={"a": 1}).begin()
            assert again is not None and again.status == 201 and again.body == {"id": "x"}
            with pytest.raises(ApiError) as e:
                await Idempotency(redis, scope="t:u1", key="key-0001", payload={"a": 2}).begin()
            assert e.value.code == "idempotency_conflict"
            # Another scope (user) with the same key is independent.
            assert (
                await Idempotency(redis, scope="t:u2", key="key-0001", payload={}).begin() is None
            )
            # Abandoned work is not cached.
            failed = Idempotency(redis, scope="t:u3", key="key-0002", payload={})
            assert await failed.begin() is None
            await failed.abandon()
            assert (
                await Idempotency(redis, scope="t:u3", key="key-0002", payload={}).begin() is None
            )
        finally:
            await redis.aclose()

    asyncio.run(run())
