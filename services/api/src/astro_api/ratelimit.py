"""Fixed-window rate limits in Redis. Keys hold HMACs, never raw phone numbers or IPs."""

import hashlib
import hmac

from redis.asyncio import Redis

from astro_api.errors import ApiError


def bucket_key(secret: str, scope: str, value: str) -> str:
    digest = hmac.new(secret.encode(), f"{scope}:{value}".encode(), hashlib.sha256).hexdigest()
    return f"rl:{scope}:{digest[:32]}"


async def hit(redis: Redis, key: str, limit: int, window_s: int) -> None:
    """Count one hit; raise 429 once the window's limit is exceeded."""
    count = int(await redis.incr(key))
    if count == 1:
        await redis.expire(key, window_s)
    if count > limit:
        ttl = int(await redis.ttl(key))
        retry_after = max(ttl, 1)
        raise ApiError(
            429,
            "rate_limited",
            "Too many attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
            retry_after=retry_after,
        )
