"""Postgres job queue (ADR-0009). The API enqueues in the caller's transaction; the worker
claims with FOR UPDATE SKIP LOCKED, so any number of workers never run a job twice at once.
A worker that dies mid-job leaves `locked_until` in the past and the job is claimed again, so
handlers must be idempotent (they key every side effect, like the ledger does)."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.models_jobs import Job

MAX_ATTEMPTS = 5
LEASE = dt.timedelta(minutes=5)


def backoff(attempts: int) -> dt.timedelta:
    """30 s, 2 min, 8 min, 32 min after attempts 1-4."""
    return dt.timedelta(seconds=30 * 4 ** (attempts - 1))


async def enqueue(
    db: AsyncSession, kind: str, payload: dict[str, Any], key: str
) -> uuid.UUID | None:
    """Queue a job unless one with this key exists. Returns the new id, or None. Caller commits."""
    row = (
        await db.execute(
            insert(Job)
            .values(id=uuid.uuid4(), kind=kind, key=key, payload=payload)
            .on_conflict_do_nothing(index_elements=["key"])
            .returning(Job.id)
        )
    ).scalar_one_or_none()
    return row


async def claim(
    db: AsyncSession, kinds: tuple[str, ...], now: dt.datetime | None = None
) -> Job | None:
    """Lease the next due job of these kinds and commit the lease."""
    now = now or dt.datetime.now(dt.UTC)
    job = (
        await db.execute(
            select(Job)
            .where(
                Job.kind.in_(kinds),
                Job.run_after <= now,
                or_(
                    Job.status == "queued",
                    (Job.status == "running") & (Job.locked_until < now),
                ),
            )
            .order_by(Job.run_after, Job.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if job is None:
        return None
    job.status = "running"
    job.attempts += 1
    job.locked_until = now + LEASE
    await db.commit()
    return job


async def finish(db: AsyncSession, job_id: uuid.UUID, now: dt.datetime | None = None) -> None:
    now = now or dt.datetime.now(dt.UTC)
    await db.execute(
        update(Job)
        .where(Job.id == job_id)
        .values(status="done", finished_at=now, locked_until=None, last_error_code=None)
    )
    await db.commit()


async def fail(
    db: AsyncSession, job_id: uuid.UUID, error_code: str, now: dt.datetime | None = None
) -> bool:
    """Record a failure. Returns True when the job is out of attempts (now `failed`)."""
    now = now or dt.datetime.now(dt.UTC)
    job = (await db.execute(select(Job).where(Job.id == job_id).with_for_update())).scalar_one()
    final = job.attempts >= MAX_ATTEMPTS
    job.status = "failed" if final else "queued"
    job.last_error_code = error_code[:64]
    job.locked_until = None
    job.run_after = now + backoff(job.attempts)
    job.finished_at = now if final else None
    await db.commit()
    return final
