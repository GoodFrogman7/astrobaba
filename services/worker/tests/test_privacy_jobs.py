"""data_export and account_cleanup jobs (docs/api/trust.md §2, ADR-0011): the export is built,
stored under a random key and marked ready once; a final failure marks it failed; cleanup removes
the files an executed deletion listed (and an expired export's file), idempotently."""

import asyncio
import datetime as dt
import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import jobs as queue
from astro_api import privacy
from astro_api.config import get_settings
from astro_api.db import make_sessionmaker
from astro_api.models import SavedKundli, User
from astro_api.models_analytics import AnalyticsEvent
from astro_api.models_jobs import Job
from astro_api.models_privacy import DataExport, DeletionRequest
from astro_api.storage import LocalStorage, new_key
from astro_worker import handlers, jobs
from astro_worker.config import get_worker_settings
from astro_worker.handlers import privacy as privacy_handlers

pytestmark = pytest.mark.integration

PHONE = "+919855500001"
LINKED_AT = dt.datetime(2026, 10, 1, 4, 30, tzinfo=dt.UTC)


def run(db_url: str, storage: LocalStorage, fn: Any) -> Any:
    async def go() -> Any:
        engine = create_async_engine(db_url)
        maker = make_sessionmaker(engine)
        redis = Redis.from_url(get_settings().redis_url.get_secret_value())
        try:
            async with httpx.AsyncClient() as http:
                ctx = jobs.Context(
                    maker,
                    get_settings(),
                    get_worker_settings(),
                    http,
                    redis,
                    extra={"storage": storage},
                )
                return await fn(ctx, maker)
        finally:
            await redis.aclose()
            await engine.dispose()

    return asyncio.run(go())


async def _user_with_export(maker: async_sessionmaker[AsyncSession]) -> uuid.UUID:
    async with maker() as db:
        user = User(phone=PHONE, device_ids=[], roles=[])
        db.add(user)
        await db.flush()
        db.add(
            SavedKundli(
                user_id=user.id,
                name="Meera",
                birth_date=dt.date(1992, 1, 2),
                birth_time=None,
                unknown_time=True,
                birth_datetime_utc=dt.datetime(1992, 1, 1, 18, 30, tzinfo=dt.UTC),
                tz="Asia/Kolkata",
                utc_offset="+05:30",
                lat=28.6,
                lon=77.2,
            )
        )
        # Analytics: one event with the user's id (exported), one anonymous (not exported).
        for uid, event, props in (
            (None, "page_view", {"path": "/kundli"}),
            (user.id, "otp_verified", {"is_new_user": True}),
        ):
            db.add(
                AnalyticsEvent(
                    event=event,
                    occurred_at=LINKED_AT,
                    anonymous_id="anon_worker_0001",
                    user_id=uid,
                    locale="en",
                    properties=props,
                )
            )
        export = await privacy.request_export(db, user)
        await db.commit()
        return export.id


def _files(path: Path) -> list[Path]:
    return list(path.iterdir())


def test_handlers_are_registered() -> None:
    assert handlers.privacy is privacy_handlers
    assert {"data_export", "account_cleanup"} <= set(jobs.HANDLERS)


def test_export_job_builds_and_stores_once(db_url: str, tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)

    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> DataExport:
        export_id = await _user_with_export(maker)
        assert await jobs.run_once(ctx, ("data_export",)) is True
        assert await jobs.run_once(ctx, ("data_export",)) is False  # done, nothing left
        # A duplicate delivery of the same job changes nothing.
        await privacy_handlers.build_export(ctx, uuid.uuid4(), {"export_id": str(export_id)})
        async with maker() as db:
            return (await db.execute(select(DataExport))).scalar_one()

    export = run(db_url, storage, go)
    assert export.status == "ready" and export.storage_key is not None
    assert export.expires_at is not None
    files = list(tmp_path.iterdir())
    assert [f.name for f in files] == [export.storage_key]
    data = json.loads(files[0].read_text())
    assert data["profile"]["phone"] == PHONE
    assert data["saved_kundlis"][0]["name"] == "Meera"
    assert data["analytics_events"] == [
        {
            "event": "otp_verified",
            "occurred_at": LINKED_AT.isoformat(),
            "properties": {"is_new_user": True},
        }
    ]
    assert export.size_bytes == files[0].stat().st_size


def test_export_job_final_failure_marks_failed(
    db_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalStorage(tmp_path)

    async def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(privacy, "build_export", broken)
    monkeypatch.setattr(queue, "MAX_ATTEMPTS", 1)

    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> DataExport:
        await _user_with_export(maker)
        assert await jobs.run_once(ctx, ("data_export",)) is True
        async with maker() as db:
            return (await db.execute(select(DataExport))).scalar_one()

    export = run(db_url, storage, go)
    assert export.status == "failed" and export.last_error_code == "build_failed"
    assert list(tmp_path.iterdir()) == []


def test_cleanup_removes_listed_files_idempotently(db_url: str, tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    keep, gone_a, gone_b = new_key(), new_key(), new_key()
    for key in (keep, gone_a, gone_b):
        storage.put(key, b"data")

    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> DeletionRequest:
        async with maker() as db:
            user = User(phone="deleted:x:1", device_ids=[], roles=[])
            db.add(user)
            await db.flush()
            d = DeletionRequest(
                user_id=user.id,
                status="executed",
                executed_at=dt.datetime.now(dt.UTC),
                executed_by="user:admin",
                pending_files=[
                    {"kind": "report", "id": str(uuid.uuid4()), "key": gone_a},
                    {"kind": "export", "id": str(uuid.uuid4()), "key": gone_b},
                ],
            )
            db.add(d)
            await db.flush()
            await queue.enqueue(
                db, "account_cleanup", {"deletion_id": str(d.id)}, f"deletion:{d.id}:cleanup"
            )
            await db.commit()
            did = d.id
        assert await jobs.run_once(ctx, ("account_cleanup",)) is True
        # Running the handler again (a retried job) is harmless.
        await privacy_handlers.cleanup(ctx, uuid.uuid4(), {"deletion_id": str(did)})
        async with maker() as db:
            job = (await db.execute(select(Job))).scalar_one()
            assert job.status == "done"
            found = await db.get(DeletionRequest, did)
            assert found is not None
            return found

    d = run(db_url, storage, go)
    assert d.pending_files == [] and d.files_cleaned_at is not None
    assert sorted(f.name for f in tmp_path.iterdir()) == [keep]


def test_cleanup_expires_a_due_export(db_url: str, tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)

    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> DataExport:
        export_id = await _user_with_export(maker)
        await jobs.run_once(ctx, ("data_export",))
        # Not due yet: the file stays.
        await privacy_handlers.cleanup(ctx, uuid.uuid4(), {"export_id": str(export_id)})
        assert len(_files(tmp_path)) == 1
        async with maker() as db:
            e = await db.get(DataExport, export_id)
            assert e is not None
            e.expires_at = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1)
            await db.commit()
        await privacy_handlers.cleanup(ctx, uuid.uuid4(), {"export_id": str(export_id)})
        async with maker() as db:
            found = await db.get(DataExport, export_id)
            assert found is not None
            return found

    export = run(db_url, storage, go)
    assert export.status == "expired" and export.storage_key is None
    assert list(tmp_path.iterdir()) == []


def test_bad_payload_is_a_job_error(db_url: str, tmp_path: Path) -> None:
    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> None:
        with pytest.raises(jobs.JobError, match="bad_payload"):
            await privacy_handlers.cleanup(ctx, uuid.uuid4(), {})
        with pytest.raises(jobs.JobError, match="bad_payload"):
            await privacy_handlers.build_export(ctx, uuid.uuid4(), {"export_id": "nope"})

    run(db_url, LocalStorage(tmp_path), go)
