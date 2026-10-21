"""report_render / report_email jobs (docs/api/revenue.md §2.2-2.3, ADR-0009). Written before
the handlers. Chromium is a fake here (test_report_render_live.py prints with the real one).

- render: prints the signed print URL, validates the PDF, stores it under a random key, marks
  the report ready with its page count, and queues the email when an address was given;
- email: sent once, then the address is erased;
- the last failed attempt marks the report failed and refunds the buyer once (money path).
"""

import asyncio
import datetime as dt
import importlib.util
import logging
import os
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest
from pydantic import SecretStr
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import jobs as queue
from astro_api import reports, wallet
from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.email import ConsoleEmail
from astro_api.models import User
from astro_api.models_jobs import Job
from astro_api.models_ledger import LedgerTransaction
from astro_api.models_reports import Report, ReportOrder
from astro_api.storage import make_storage
from astro_worker import jobs
from astro_worker.config import WorkerSettings
from astro_worker.handlers import reports as handlers

pytestmark = pytest.mark.integration

RECORDER = Path(__file__).resolve().parents[2] / "api/tests/fixtures/record_report_engine.py"
EMAIL = "buyer@example.com"
PRICE = 49900


def recorder() -> ModuleType:
    spec = importlib.util.spec_from_file_location("record_report_engine", RECORDER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tiny_pdf(pages: int) -> bytes:
    """A structurally valid PDF with `pages` empty A4 pages (no xref; enough for validation)."""
    kids = " ".join(f"{3 + i} 0 R" for i in range(pages))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode(),
        *[b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>" for _ in range(pages)],
    ]
    body = b"".join(f"{i + 1} 0 obj\n".encode() + o + b"\nendobj\n" for i, o in enumerate(objects))
    return b"%PDF-1.7\n" + body + b"trailer << /Root 1 0 R >>\n" + b"%" * 200 + b"\n%%EOF\n"


def make_settings(db_url: str, tmp_path: Path) -> Settings:
    base = os.environ.get("REDIS_URL", "redis://localhost:6379/0").rsplit("/", 1)[0]
    return Settings(
        app_env="test",
        database_url=SecretStr(db_url),
        redis_url=SecretStr(f"{base}/{os.environ.get('TEST_REDIS_DB', '15')}"),
        secret_key=SecretStr("test-secret-key-for-hmac-0123456789"),
        documents_dir=tmp_path / "docs",
        web_internal_url="http://web.internal:3000",
    )


class FakeChromium:
    def __init__(self, result: bytes | BaseException) -> None:
        self.result = result
        self.urls: list[str] = []

    async def __call__(self, url: str, out: Path, timeout_s: float) -> None:
        self.urls.append(url)
        if isinstance(self.result, BaseException):
            raise self.result
        await asyncio.to_thread(out.write_bytes, self.result)


@pytest.fixture
async def world(db_url: str, tmp_path: Path) -> AsyncIterator[dict[str, Any]]:
    settings = make_settings(db_url, tmp_path)
    engine = create_async_engine(db_url)
    maker = make_sessionmaker(engine)
    redis = Redis.from_url(settings.redis_url.get_secret_value())
    ConsoleEmail.outbox.clear()
    async with httpx.AsyncClient() as http:
        ctx = jobs.Context(maker, settings, WorkerSettings(app_env="test"), http, redis)
        yield {"ctx": ctx, "maker": maker, "settings": settings}
    await redis.aclose()
    await engine.dispose()


async def paid_report(
    maker: async_sessionmaker[AsyncSession], settings: Settings, *, email: str | None
) -> tuple[uuid.UUID, uuid.UUID]:
    """A user with a wallet-paid kundli report (snapshot from the recorded engine responses)."""
    rec = recorder()
    async with httpx.AsyncClient(
        base_url="http://astro.test", transport=rec.replay_transport()
    ) as http:
        snapshot = await reports.build_snapshot(
            http, "kundli_report", [rec.birth(rec.PERSON_A)], rec.AS_OF
        )
    async with maker() as db:
        user = User(phone=f"+9196{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
        db.add(user)
        await db.flush()
        await wallet.credit_recharge(
            db, user_id=user.id, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=PRICE
        )
        order = ReportOrder(
            id=uuid.uuid4(),
            user_id=user.id,
            idempotency_key=uuid.uuid4().hex,
            sku="kundli_report",
            language="en",
            kundli_ids=[],
            pay_with="wallet",
            price_paise=PRICE,
            currency="INR",
            status="created",
            snapshot=snapshot,
            engine_version=reports.engine_version(snapshot),
        )
        db.add(order)
        await db.flush()
        if email:
            reports.seal_email(settings, order, email)
        await wallet.charge_purchase(
            db,
            user_id=user.id,
            key=reports.paid_key(order.id),
            product="report",
            ref_id=str(order.id),
            amount_paise=PRICE,
        )
        report = await reports.mark_paid(db, order, dt.datetime.now(dt.UTC))
        await db.commit()
        return report.id, order.id


async def drain(ctx: jobs.Context, maker: async_sessionmaker[AsyncSession]) -> None:
    """Run every due job; make retries due at once; until nothing is left to run."""
    for _ in range(queue.MAX_ATTEMPTS + 2):
        while await jobs.run_once(ctx, ("report_render", "report_email")):
            pass
        async with maker() as db:
            await db.execute(
                update(Job).where(Job.status == "queued").values(run_after=Job.created_at)
            )
            await db.commit()


async def test_render_stores_the_pdf_marks_ready_and_emails_once(world: dict[str, Any]) -> None:
    ctx, maker, settings = world["ctx"], world["maker"], world["settings"]
    chromium = FakeChromium(tiny_pdf(3))
    ctx.extra["chromium"] = chromium
    report_id, order_id = await paid_report(maker, settings, email=EMAIL)
    await drain(ctx, maker)

    assert len(chromium.urls) == 1
    url = chromium.urls[0]
    prefix = f"http://web.internal:3000/print/reports/{report_id}?sig="
    assert url.startswith(prefix)
    assert reports.verify(settings, "render", report_id, url.removeprefix(prefix))
    async with maker() as db:
        report = await db.get(Report, report_id)
        order = await db.get(ReportOrder, order_id)
        assert report is not None and order is not None
        assert (report.status, report.pages, report.size_bytes) == ("ready", 3, len(tiny_pdf(3)))
        assert report.ready_at is not None and report.emailed_at is not None
        assert report.storage_key and len(report.storage_key) == 32  # random, not a name
        assert make_storage(settings).get(report.storage_key) == tiny_pdf(3)
        assert order.email_ciphertext is None and order.email_key_id is None
        statuses = {j.key: j.status for j in (await db.execute(select(Job))).scalars()}
    assert statuses == {f"report:{report_id}:render": "done", f"report:{report_id}:email": "done"}
    assert len(ConsoleEmail.outbox) == 1
    to, subject, body = ConsoleEmail.outbox[0]
    assert to == EMAIL and subject
    assert "Asha" not in body and "1990" not in body  # no name or birth details in mail

    # Running either job again changes nothing: no second print, no second email.
    await handlers.render(ctx, uuid.uuid4(), {"report_id": str(report_id)})
    await handlers.send_email(ctx, uuid.uuid4(), {"report_id": str(report_id)})
    assert len(chromium.urls) == 1 and len(ConsoleEmail.outbox) == 1


async def test_no_email_job_without_an_address(world: dict[str, Any]) -> None:
    ctx, maker, settings = world["ctx"], world["maker"], world["settings"]
    ctx.extra["chromium"] = FakeChromium(tiny_pdf(1))
    report_id, _ = await paid_report(maker, settings, email=None)
    await drain(ctx, maker)
    async with maker() as db:
        keys = [j.key for j in (await db.execute(select(Job))).scalars()]
    assert keys == [f"report:{report_id}:render"]
    assert ConsoleEmail.outbox == []


async def test_last_failure_marks_failed_and_refunds_once(
    world: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    ctx, maker, settings = world["ctx"], world["maker"], world["settings"]
    chromium = FakeChromium(b"<html>not a pdf</html>" * 40)
    ctx.extra["chromium"] = chromium
    report_id, order_id = await paid_report(maker, settings, email=EMAIL)
    caplog.set_level(logging.INFO)
    await drain(ctx, maker)

    assert len(chromium.urls) == queue.MAX_ATTEMPTS
    async with maker() as db:
        report = await db.get(Report, report_id)
        order = await db.get(ReportOrder, order_id)
        assert report is not None and order is not None
        assert (report.status, report.last_error_code) == ("failed", "pdf_invalid")
        assert report.refunded_at is not None and report.storage_key is None
        assert order.email_ciphertext is None  # never sent, not kept
        user_id = order.user_id
        b = await wallet.balances(db, user_id)
        assert (b.real_paise, b.promo_paise) == (PRICE, 0)
        refunds = (
            (
                await db.execute(
                    select(LedgerTransaction).where(
                        LedgerTransaction.idempotency_key == f"refund:report:{report_id}"
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(refunds) == 1
        job = (await db.execute(select(Job))).scalar_one()
        assert (job.status, job.last_error_code) == ("failed", "pdf_invalid")
    # The hook again (a crashed worker re-running it) never refunds twice.
    await handlers.on_render_failed(ctx, uuid.uuid4(), {"report_id": str(report_id)})
    async with maker() as db:
        assert (await wallet.balances(db, user_id)).real_paise == PRICE
    assert "report_failed" in caplog.text
    assert (
        EMAIL not in caplog.text and "Asha" not in caplog.text and "1990-08-15" not in caplog.text
    )
    assert ConsoleEmail.outbox == []


@pytest.mark.parametrize(
    ("result", "code"),
    [
        (TimeoutError(), "render_timeout"),
        (handlers.ChromiumError("exit 1"), "render_failed"),
        (b"%PDF-1.7\n" + b"x" * 400 + b"\n%%EOF\n", "pdf_no_pages"),
        (b"%PDF-1.7\n%%EOF\n", "pdf_invalid"),
    ],
)
async def test_render_failures_have_codes_and_keep_the_report_queued(
    world: dict[str, Any], result: bytes | BaseException, code: str
) -> None:
    ctx, maker, settings = world["ctx"], world["maker"], world["settings"]
    ctx.extra["chromium"] = FakeChromium(result)
    report_id, _ = await paid_report(maker, settings, email=None)
    with pytest.raises(jobs.JobError) as err:
        await handlers.render(ctx, uuid.uuid4(), {"report_id": str(report_id)})
    assert err.value.code == code
    async with maker() as db:
        report = await db.get(Report, report_id)
        assert report is not None
        assert (report.status, report.last_error_code) == ("queued", code)


def test_pdf_validation_and_page_count() -> None:
    assert handlers.validate_pdf(tiny_pdf(5)) == 5
    for bad in (b"", b"GIF89a" + b"x" * 500, b"%PDF-1.7\n" + b"x" * 500):
        with pytest.raises(jobs.JobError):
            handlers.validate_pdf(bad)
    with pytest.raises(jobs.JobError) as err:
        handlers.validate_pdf(b"%PDF-1.7\n" + b"x" * (handlers.MAX_PDF_BYTES + 1) + b"%%EOF\n")
    assert err.value.code == "pdf_too_large"
    # /Type /Pages (the tree node) is not a page; spacing variants are.
    assert handlers.count_pages(b"/Type /Pages /Type/Page /Type  /Page\n/Type /Page>>") == 3


def test_chromium_command_line() -> None:
    argv = handlers.chromium_argv("/usr/bin/chromium", "http://web/print/x?sig=1", Path("/t/o.pdf"))
    assert argv[0] == "/usr/bin/chromium" and argv[-1] == "http://web/print/x?sig=1"
    for flag in (
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--print-to-pdf=/t/o.pdf",
    ):
        assert flag in argv


def test_render_is_registered_with_a_refund_hook() -> None:
    assert jobs.HANDLERS["report_render"].on_failed is handlers.on_render_failed
    assert jobs.HANDLERS["report_email"].handle is handlers.send_email


async def test_missing_report_is_a_no_op(world: dict[str, Any]) -> None:
    ctx = world["ctx"]
    ctx.extra["chromium"] = FakeChromium(tiny_pdf(1))
    await handlers.render(ctx, uuid.uuid4(), {"report_id": str(uuid.uuid4())})
    await handlers.on_render_failed(ctx, uuid.uuid4(), {"report_id": str(uuid.uuid4())})
    await asyncio.sleep(0)
