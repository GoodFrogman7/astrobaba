"""Job runner: success finishes the job, failure retries, the last failure calls on_failed once,
and a broken on_failed hook never stops the runner."""

import asyncio
import uuid
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import jobs as queue
from astro_api.config import get_settings
from astro_api.db import make_sessionmaker
from astro_api.models_jobs import Job
from astro_worker import jobs
from astro_worker.config import get_worker_settings

pytestmark = pytest.mark.integration


def test_runner_finishes_retries_and_calls_on_failed_once(
    db_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    async def ok(ctx: jobs.Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
        calls.append(f"ok:{payload['n']}")

    async def boom(ctx: jobs.Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
        raise jobs.JobError("render_failed")

    async def refund(ctx: jobs.Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
        calls.append(f"refund:{payload['n']}")
        raise RuntimeError("hook broke")  # must be logged, not crash the runner

    monkeypatch.setattr(jobs, "HANDLERS", {})
    jobs.register("ai_answer", ok)
    jobs.register("report_render", boom, refund)

    async def go() -> None:
        engine = create_async_engine(db_url)
        maker = make_sessionmaker(engine)
        redis = Redis.from_url(get_settings().redis_url.get_secret_value())
        async with httpx.AsyncClient() as http:
            ctx = jobs.Context(maker, get_settings(), get_worker_settings(), http, redis)
            async with maker() as db:
                await queue.enqueue(db, "ai_answer", {"n": 1}, "ai:1")
                await queue.enqueue(db, "report_render", {"n": 2}, "report:2:render")
                await db.commit()
            for _ in range(queue.MAX_ATTEMPTS):
                while await jobs.run_once(ctx):
                    pass
                async with maker() as db:  # make the retry due now
                    await db.execute(
                        update(Job).where(Job.status == "queued").values(run_after=Job.created_at)
                    )
                    await db.commit()
            async with maker() as db:
                rows = {j.key: j for j in (await db.execute(select(Job))).scalars()}
        await redis.aclose()
        await engine.dispose()
        assert rows["ai:1"].status == "done"
        assert rows["report:2:render"].status == "failed"
        assert rows["report:2:render"].last_error_code == "render_failed"
        assert rows["report:2:render"].attempts == queue.MAX_ATTEMPTS

    asyncio.run(go())
    assert calls == ["ok:1", "refund:2"]
