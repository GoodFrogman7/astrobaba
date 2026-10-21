"""remedy_lead_notify: the partner gets the lead (remedy, date, language, phone, decrypted note)
once, the lead is marked notified, and neither the phone nor the note reaches a log."""

import asyncio
import datetime as dt
import uuid
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import jobs as queue
from astro_api.chat_crypto import cipher_from_settings
from astro_api.config import Settings, get_settings
from astro_api.db import make_sessionmaker
from astro_api.email import ConsoleEmail
from astro_api.models import User
from astro_api.models_jobs import Job
from astro_api.models_remedies import RemedyLead, note_aad
from astro_worker import jobs
from astro_worker.config import get_worker_settings
from astro_worker.handlers import remedies

pytestmark = pytest.mark.integration

PHONE = "+919812345678"
NOTE = "Please call after 6 pm"


async def _lead(
    maker: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    note: str | None = NOTE,
    partner_id: str = "demo-partner",
) -> uuid.UUID:
    async with maker() as db:
        user = User(phone=PHONE, device_ids=[], roles=[])
        db.add(user)
        await db.flush()
        lead_id = uuid.uuid4()
        sealed = cipher_from_settings(settings).encrypt(note, note_aad(lead_id)) if note else None
        db.add(
            RemedyLead(
                id=lead_id,
                user_id=user.id,
                idempotency_key="k" * 12,
                remedy_id="ganesh-puja",
                partner_id=partner_id,
                language="hi",
                preferred_date=dt.date(2026, 11, 2),
                phone=PHONE,
                note_ciphertext=sealed.ciphertext if sealed else None,
                note_nonce=sealed.nonce if sealed else None,
                note_key_id=sealed.key_id if sealed else None,
                consent_at=dt.datetime.now(dt.UTC),
            )
        )
        await queue.enqueue(
            db, "remedy_lead_notify", {"lead_id": str(lead_id)}, f"lead:{lead_id}:notify"
        )
        await db.commit()
    return lead_id


def run(db_url: str, fn: Any, settings: Settings | None = None) -> Any:
    async def go() -> Any:
        engine = create_async_engine(db_url)
        maker = make_sessionmaker(engine)
        redis = Redis.from_url(get_settings().redis_url.get_secret_value())
        try:
            async with httpx.AsyncClient() as http:
                ctx = jobs.Context(
                    maker, settings or get_settings(), get_worker_settings(), http, redis
                )
                return await fn(ctx, maker)
        finally:
            await redis.aclose()
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture(autouse=True)
def _outbox(monkeypatch: pytest.MonkeyPatch) -> None:
    ConsoleEmail.outbox.clear()
    monkeypatch.setattr(jobs, "HANDLERS", {})
    jobs.register("remedy_lead_notify", remedies.notify_lead, remedies.notify_failed)


def test_partner_gets_the_lead_once_and_nothing_personal_is_logged(
    db_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")

    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> None:
        lead_id = await _lead(maker, ctx.settings)
        assert await jobs.run_once(ctx) is True
        assert await jobs.run_once(ctx) is False
        async with maker() as db:
            lead = await db.get(RemedyLead, lead_id)
            job = (await db.execute(select(Job))).scalar_one()
            assert lead is not None and lead.notified_at is not None
            assert job.status == "done"
        assert len(ConsoleEmail.outbox) == 1
        to, subject, body = ConsoleEmail.outbox[0]
        assert to == "demo-partner@example.invalid"
        assert "Ganesh puja" in subject and PHONE not in subject
        for expected in (PHONE, NOTE, "2026-11-02", "Hindi", "गणेश पूजा", str(lead_id)):
            assert expected in body
        assert "do not promise outcomes" in body
        # A second delivery of the same job (lease expired after sending) sends nothing.
        await remedies.notify_lead(ctx, uuid.uuid4(), {"lead_id": str(lead_id)})
        assert len(ConsoleEmail.outbox) == 1

    run(db_url, go)
    assert PHONE not in caplog.text and NOTE not in caplog.text


def test_lead_without_note_and_spam_leads(db_url: str) -> None:
    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> None:
        lead_id = await _lead(maker, ctx.settings, note=None)
        await remedies.notify_lead(ctx, uuid.uuid4(), {"lead_id": str(lead_id)})
        assert "Note from the user: (none)" in ConsoleEmail.outbox[0][2]
        assert "Preferred date: 2026-11-02" in ConsoleEmail.outbox[0][2]
        async with maker() as db:
            lead = await db.get(RemedyLead, lead_id)
            assert lead is not None
            lead.notified_at, lead.status = None, "spam"
            await db.commit()
        await remedies.notify_lead(ctx, uuid.uuid4(), {"lead_id": str(lead_id)})
        assert len(ConsoleEmail.outbox) == 1
        # A lead whose account was erased is simply done.
        await remedies.notify_lead(ctx, uuid.uuid4(), {"lead_id": str(uuid.uuid4())})

    run(db_url, go)


def test_unavailable_partner_fails_with_a_code_only(db_url: str) -> None:
    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> None:
        lead_id = await _lead(maker, ctx.settings, partner_id="gone")
        assert await jobs.run_once(ctx) is True
        async with maker() as db:
            job = (await db.execute(select(Job))).scalar_one()
            lead = await db.get(RemedyLead, lead_id)
        assert job.status == "queued" and job.last_error_code == "partner_unavailable"
        assert lead is not None and lead.notified_at is None
        assert ConsoleEmail.outbox == []

    run(db_url, go)


def test_dev_only_partner_is_never_contacted_in_staging(db_url: str) -> None:
    staging = get_settings().model_copy(update={"app_env": "staging"})

    async def go(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> None:
        lead_id = await _lead(maker, get_settings())
        with pytest.raises(jobs.JobError) as err:
            await remedies.notify_lead(ctx, uuid.uuid4(), {"lead_id": str(lead_id)})
        assert err.value.code == "partner_unavailable"
        assert ConsoleEmail.outbox == []

    run(db_url, go, staging)
