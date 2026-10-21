import asyncio
import time
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


async def _timed(name: str, coro: Any, limit_s: float) -> dict[str, Any]:
    start = time.perf_counter()
    try:
        await asyncio.wait_for(coro, limit_s)
        status = "ok"
    except Exception as exc:  # report the dependency as down, never crash the probe
        status = f"error: {type(exc).__name__}"
    return {"name": name, "status": status, "ms": round((time.perf_counter() - start) * 1000, 1)}


async def _ping_db(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


async def check_dependencies(
    engine: AsyncEngine, redis: Redis, limit_s: float
) -> list[dict[str, Any]]:
    return list(
        await asyncio.gather(
            _timed("postgres", _ping_db(engine), limit_s),
            _timed("redis", redis.ping(), limit_s),
        )
    )
