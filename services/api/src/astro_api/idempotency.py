"""`Idempotency-Key` handling for POST endpoints that create money or sessions.

Redis keeps the first response for 24 h so a retry gets the same status and body. This is a
convenience for clients; correctness comes from unique constraints in Postgres, which every
money and session write also has.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from fastapi import Header
from redis.asyncio import Redis

from astro_api.errors import ApiError

TTL_S = 24 * 3600
LOCK_S = 30
_KEY = re.compile(r"^[A-Za-z0-9_-]{8,128}$")


def idempotency_key(key: str | None = Header(default=None, alias="Idempotency-Key")) -> str:
    """FastAPI dependency: the validated header value."""
    if key is None or not _KEY.fullmatch(key):
        raise ApiError(
            400, "idempotency_key_required", "Send an Idempotency-Key header (8-128 characters)."
        )
    return key


def body_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


@dataclass(frozen=True)
class Stored:
    status: int
    body: Any


class Idempotency:
    """Usage:

    idem = Idempotency(redis, scope=f"recharge:{user.id}", key=key, payload=body.model_dump())
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        ... do the work ...
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    """

    def __init__(self, redis: Redis, *, scope: str, key: str, payload: Any) -> None:
        self.redis = redis
        self.base = f"idem:{scope}:{key}"
        self.hash = body_hash(payload)

    async def begin(self) -> Stored | None:
        raw = await self.redis.get(self.base)
        if raw is not None:
            return self._replay(raw)
        if not await self.redis.set(f"{self.base}:lock", self.hash, nx=True, ex=LOCK_S):
            raw = await self.redis.get(self.base)
            if raw is not None:
                return self._replay(raw)
            raise ApiError(409, "idempotency_in_progress", "The same request is still running.")
        return None

    def _replay(self, raw: bytes | str) -> Stored:
        data = json.loads(raw)
        if data["hash"] != self.hash:
            raise ApiError(
                409, "idempotency_conflict", "This Idempotency-Key was used for another request."
            )
        return Stored(int(data["status"]), data["body"])

    async def finish(self, status: int, body: Any) -> None:
        record = json.dumps({"hash": self.hash, "status": status, "body": body}, default=str)
        await self.redis.set(self.base, record, ex=TTL_S)
        await self.redis.delete(f"{self.base}:lock")

    async def abandon(self) -> None:
        """Release the lock without storing, so the client may retry (errors are not cached)."""
        await self.redis.delete(f"{self.base}:lock")
