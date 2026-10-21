"""Job runner: `python -m astro_worker jobs run [--once]`. Claims jobs (astro_api.jobs), runs the
registered handler, retries with backoff, and calls the handler's `on_failed` once a job is out
of attempts (e.g. refund an undeliverable report). Never logs payload content."""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from astro_api import jobs
from astro_api.config import Settings
from astro_worker.config import WorkerSettings

log = logging.getLogger("astro_worker.jobs")


class JobError(Exception):
    """A handler failure with a short machine code (stored on the job, never personal data)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class Context:
    sessionmaker: async_sessionmaker[AsyncSession]
    settings: Settings
    worker: WorkerSettings
    http: httpx.AsyncClient
    redis: Redis
    extra: dict[str, Any] = field(default_factory=dict)


Handle = Callable[[Context, uuid.UUID, dict[str, Any]], Awaitable[None]]
OnFailed = Callable[[Context, uuid.UUID, dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class Handler:
    handle: Handle
    on_failed: OnFailed | None = None


HANDLERS: dict[str, Handler] = {}


def register(kind: str, handle: Handle, on_failed: OnFailed | None = None) -> None:
    HANDLERS[kind] = Handler(handle, on_failed)


async def run_once(ctx: Context, kinds: tuple[str, ...] | None = None) -> bool:
    """Run one due job. Returns False when there was nothing to do."""
    kinds = kinds or tuple(HANDLERS)
    async with ctx.sessionmaker() as db:
        job = await jobs.claim(db, kinds)
        if job is None:
            return False
        job_id, kind, payload = job.id, job.kind, dict(job.payload)
    handler = HANDLERS[kind]
    try:
        await handler.handle(ctx, job_id, payload)
    except Exception as exc:  # every failure is recorded and retried
        code = exc.code if isinstance(exc, JobError) else type(exc).__name__
        async with ctx.sessionmaker() as db:
            final = await jobs.fail(db, job_id, code)
        log.warning("job_failed", extra={"job_id": str(job_id), "kind": kind, "code": code})
        if final and handler.on_failed is not None:
            try:
                await handler.on_failed(ctx, job_id, payload)
            except Exception as hook_exc:  # must not stop the runner
                # Hooks are idempotent; the admin jobs view shows the failed job to retry.
                log.error(
                    "job_on_failed_error",
                    extra={"job_id": str(job_id), "kind": kind, "code": type(hook_exc).__name__},
                )
        return True
    async with ctx.sessionmaker() as db:
        await jobs.finish(db, job_id)
    return True


async def run_forever(ctx: Context, poll_s: float = 2.0) -> None:
    while True:
        if not await run_once(ctx):
            await asyncio.sleep(poll_s)
