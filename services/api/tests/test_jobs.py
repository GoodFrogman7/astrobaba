"""Postgres job queue (astro_api.jobs, ADR-0009)."""

import asyncio
import datetime as dt
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import jobs
from astro_api.db import make_sessionmaker
from astro_api.models_jobs import Job

pytestmark = pytest.mark.integration
T0 = dt.datetime(2026, 10, 21, 6, 0, tzinfo=dt.UTC)


def run(clean: Any, fn: Any) -> Any:
    async def go() -> Any:
        engine = create_async_engine(clean.database_url.get_secret_value(), pool_size=10)
        try:
            return await fn(make_sessionmaker(engine))
        finally:
            await engine.dispose()

    return asyncio.run(go())


def test_enqueue_is_idempotent_on_the_key(clean: Any) -> None:
    async def go(maker: async_sessionmaker[AsyncSession]) -> None:
        async with maker() as db:
            first = await jobs.enqueue(db, "report_render", {"report_id": "r1"}, "report:r1:render")
            again = await jobs.enqueue(db, "report_render", {"report_id": "r1"}, "report:r1:render")
            await db.commit()
            assert first is not None and again is None
            assert len((await db.execute(select(Job))).scalars().all()) == 1

    run(clean, go)


def test_parallel_workers_never_claim_the_same_job(clean: Any) -> None:
    async def go(maker: async_sessionmaker[AsyncSession]) -> None:
        async with maker() as db:
            for i in range(5):
                await jobs.enqueue(db, "ai_answer", {"question_id": str(i)}, f"ai:{i}")
            await db.commit()

        async def worker() -> list[str]:
            got = []
            async with maker() as db:
                while (job := await jobs.claim(db, ("ai_answer",))) is not None:
                    got.append(job.key)
            return got

        results = await asyncio.gather(*(worker() for _ in range(6)))
        claimed = [k for r in results for k in r]
        assert sorted(claimed) == [f"ai:{i}" for i in range(5)]

    run(clean, go)


def test_failure_backs_off_then_fails_for_good_and_expired_leases_are_reclaimed(
    clean: Any,
) -> None:
    async def go(maker: async_sessionmaker[AsyncSession]) -> None:
        async with maker() as db:
            await jobs.enqueue(db, "report_render", {"report_id": "r2"}, "report:r2:render")
            await db.commit()
        now = dt.datetime.now(dt.UTC)
        async with maker() as db:
            job = await jobs.claim(db, ("report_render",), now)
            assert job is not None and job.attempts == 1
            # Not due again until the backoff passes.
            assert await jobs.fail(db, job.id, "chromium_crashed", now) is False
            assert await jobs.claim(db, ("report_render",), now) is None
            # A worker that died keeps the lease until it expires, then the job is reclaimed.
            later = now + jobs.backoff(1)
            job = await jobs.claim(db, ("report_render",), later)
            assert job is not None and job.attempts == 2
            assert await jobs.claim(db, ("report_render",), later) is None
            job = await jobs.claim(db, ("report_render",), later + jobs.LEASE + dt.timedelta(1))
            assert job is not None and job.attempts == 3
            t = later + jobs.LEASE + dt.timedelta(1)
            for _ in range(jobs.MAX_ATTEMPTS - 3):
                assert await jobs.fail(db, job.id, "x", t) is False
                t += dt.timedelta(days=1)
                job = await jobs.claim(db, ("report_render",), t)
                assert job is not None
            assert await jobs.fail(db, job.id, "x", t) is True
            row = (await db.execute(select(Job))).scalar_one()
            assert row.status == "failed" and row.attempts == jobs.MAX_ATTEMPTS
            assert await jobs.claim(db, ("report_render",), t + dt.timedelta(days=9)) is None

    run(clean, go)
