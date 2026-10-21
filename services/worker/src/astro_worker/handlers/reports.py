"""Job handlers: report_render and report_email (docs/api/revenue.md §2.3, ADR-0009).

report_render: print the web app's private print page (`/print/reports/{id}?sig=`, 5-minute
HMAC) with headless Chromium, validate the PDF (magic bytes, %%EOF, size limits, page count),
store it under a random key, mark the report ready, and queue report_email when the buyer gave
an address. Its `on_failed` (after the last attempt) marks the report failed and refunds the
buyer once (astro_api.reports.fail_and_refund).

report_email: decrypt the address, send one message with a link to the signed-in reports page
(no name, birth details or file in the mail), then erase the address.

Payloads hold the report id only. Nothing here logs names, birth details or addresses.
"""

import asyncio
import contextlib
import datetime as dt
import glob
import logging
import re
import shutil
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import anyio
from sqlalchemy import select

from astro_api import jobs as queue
from astro_api import reports
from astro_api.config import Settings
from astro_api.email import EmailSender, make_email_sender
from astro_api.models_jobs import Job
from astro_api.models_reports import Report, ReportOrder
from astro_api.storage import DocumentStorage, make_storage, new_key
from astro_worker.jobs import Context, JobError, register

log = logging.getLogger("astro_worker.reports")

RENDER_TIMEOUT_S = 120.0  # well inside the job lease (astro_api.jobs.LEASE)
MIN_PDF_BYTES = 256
MAX_PDF_BYTES = 25 * 1024 * 1024
_PAGE = re.compile(rb"/Type\s*/Page(?![A-Za-z])")

ChromiumRunner = Callable[[str, Path, float], Awaitable[None]]

EMAIL_TEXT = {
    "en": (
        "Your report is ready",
        "Your report is ready to download.\n\nSign in and open your reports: {link}\n\n"
        "For entertainment; not medical, legal or financial advice.\n",
    ),
    "hi": (
        "आपकी रिपोर्ट तैयार है",
        "आपकी रिपोर्ट डाउनलोड के लिए तैयार है।\n\nसाइन इन करके अपनी रिपोर्ट खोलें: {link}\n\n"
        "केवल मनोरंजन के लिए; यह चिकित्सा, कानूनी या वित्तीय सलाह नहीं है।\n",
    ),
}


class ChromiumError(Exception):
    """Chromium exited with an error. Message holds the exit status only."""


# ------------------------------------------------------------------ Chromium


def find_chromium(settings: Settings) -> str | None:
    """CHROMIUM_PATH, then `chromium` / `chromium-browser` on PATH, then a Playwright build."""
    if settings.chromium_path:
        return settings.chromium_path
    for name in ("chromium", "chromium-browser"):
        if found := shutil.which(name):
            return found
    builds = sorted(glob.glob("/opt/pw-browsers/chromium*/chrome-linux/chrome"))
    return builds[-1] if builds else None


def chromium_argv(binary: str, url: str, out: Path, profile: Path | None = None) -> list[str]:
    argv = [
        binary,
        "--headless=new",
        # The page is our own print page on the internal network; the container is the sandbox.
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-pdf-header-footer",
        f"--print-to-pdf={out}",
    ]
    if profile is not None:
        argv.append(f"--user-data-dir={profile}")
    return [*argv, url]


def make_chromium_runner(settings: Settings) -> ChromiumRunner:
    async def run(url: str, out: Path, timeout_s: float) -> None:
        binary = find_chromium(settings)
        if binary is None:
            raise ChromiumError("chromium not found")
        with tempfile.TemporaryDirectory(prefix="chromium-") as profile:
            proc = await asyncio.create_subprocess_exec(
                *chromium_argv(binary, url, out, Path(profile)),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                code = await asyncio.wait_for(proc.wait(), timeout_s)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
                raise
        if code != 0:
            raise ChromiumError(f"exit {code}")

    return run


# ------------------------------------------------------------------ PDF checks


def count_pages(data: bytes) -> int:
    """Count `/Type /Page` objects (not the `/Pages` tree nodes). Chromium writes page objects
    uncompressed, so this simple count is exact for its output."""
    return len(_PAGE.findall(data))


def validate_pdf(data: bytes) -> int:
    """Raise JobError unless `data` looks like a complete PDF of sane size; return its pages."""
    if len(data) > MAX_PDF_BYTES:
        raise JobError("pdf_too_large")
    if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-1024:]:
        raise JobError("pdf_invalid")
    if len(data) < MIN_PDF_BYTES:
        raise JobError("pdf_invalid")
    pages = count_pages(data)
    if pages < 1:
        raise JobError("pdf_no_pages")
    return pages


# ------------------------------------------------------------------ helpers


def _report_id(payload: dict[str, Any]) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(payload.get("report_id")))
    except ValueError:
        return None


def _storage(ctx: Context) -> DocumentStorage:
    storage: DocumentStorage | None = ctx.extra.get("storage")
    return storage or make_storage(ctx.settings)


def _chromium(ctx: Context) -> ChromiumRunner:
    runner: ChromiumRunner | None = ctx.extra.get("chromium")
    return runner or make_chromium_runner(ctx.settings)


def _email(ctx: Context) -> EmailSender:
    sender: EmailSender | None = ctx.extra.get("email")
    return sender or make_email_sender(ctx.settings)


async def _print(ctx: Context, report_id: uuid.UUID) -> bytes:
    url = reports.print_url(ctx.settings, report_id)
    with tempfile.TemporaryDirectory(prefix="report-") as tmp:
        out = Path(tmp) / "report.pdf"
        try:
            await _chromium(ctx)(url, out, RENDER_TIMEOUT_S)
        except TimeoutError as exc:
            raise JobError("render_timeout") from exc
        except ChromiumError as exc:
            raise JobError("render_failed") from exc
        if not await anyio.Path(out).exists():
            raise JobError("render_failed")
        return await anyio.Path(out).read_bytes()


# ------------------------------------------------------------------ report_render


async def render(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    report_id = _report_id(payload)
    if report_id is None:
        raise JobError("bad_payload")
    async with ctx.sessionmaker() as db:
        report = await db.get(Report, report_id)
        if report is None or report.status in ("ready", "failed"):
            return  # deleted, already done, or given up (an admin retry re-queues it)
        report.status = "rendering"
        await db.commit()

    try:
        data = await _print(ctx, report_id)
        pages = validate_pdf(data)
    except JobError as exc:
        async with ctx.sessionmaker() as db:
            row = await db.get(Report, report_id)
            if row is not None and row.status == "rendering":
                row.status = "queued"  # the runner retries with backoff
                row.last_error_code = exc.code
                await db.commit()
        raise

    storage = _storage(ctx)
    key = new_key()
    await anyio.to_thread.run_sync(storage.put, key, data)
    old_key: str | None = None
    async with ctx.sessionmaker() as db:
        report = (
            await db.execute(select(Report).where(Report.id == report_id).with_for_update())
        ).scalar_one()
        old_key = report.storage_key
        report.status = "ready"
        report.storage_key = key
        report.pages = pages
        report.size_bytes = len(data)
        report.ready_at = dt.datetime.now(dt.UTC)
        report.failed_at = None
        report.last_error_code = None
        if report.order_id is not None:
            order = await db.get(ReportOrder, report.order_id)
            if order is not None and order.email_ciphertext is not None:
                await queue.enqueue(
                    db, "report_email", {"report_id": str(report_id)}, f"report:{report_id}:email"
                )
        await db.commit()
    if old_key and old_key != key:  # an admin re-render replaced an earlier file
        await anyio.to_thread.run_sync(storage.delete, old_key)
    log.info("report_ready", extra={"report_id": str(report_id), "pages": pages})


async def on_render_failed(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    """Out of attempts: mark failed, alert (error log `report_failed`), refund once."""
    report_id = _report_id(payload)
    if report_id is None:
        return
    async with ctx.sessionmaker() as db:
        job = await db.get(Job, job_id)
        code = job.last_error_code if job is not None else None
        await reports.fail_and_refund(db, report_id, code, dt.datetime.now(dt.UTC))
        await db.commit()


# ------------------------------------------------------------------ report_email


def _reports_link(settings: Settings, language: str) -> str:
    site = settings.public_site_url.rstrip("/")
    return f"{site}/hi/account/reports" if language == "hi" else f"{site}/account/reports"


async def send_email(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    report_id = _report_id(payload)
    if report_id is None:
        raise JobError("bad_payload")
    async with ctx.sessionmaker() as db:
        report = await db.get(Report, report_id)
        if report is None or report.order_id is None or report.emailed_at is not None:
            return
        order = (
            await db.execute(
                select(ReportOrder).where(ReportOrder.id == report.order_id).with_for_update()
            )
        ).scalar_one()
        address = reports.open_email(ctx.settings, order)
        if address is None:
            return
        if report.status != "ready":
            raise JobError("report_not_ready")
        subject, body = EMAIL_TEXT[report.language]
        await _email(ctx).send(
            address, subject, body.format(link=_reports_link(ctx.settings, report.language))
        )
        # Used once, then erased. A crash between send and commit can send it twice; never
        # zero times (the job is retried).
        reports.erase_email(order)
        report.emailed_at = dt.datetime.now(dt.UTC)
        await db.commit()
    log.info("report_emailed", extra={"report_id": str(report_id)})


async def on_email_failed(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    """Could not send after every attempt: erase the address anyway (it is not kept)."""
    report_id = _report_id(payload)
    if report_id is None:
        return
    async with ctx.sessionmaker() as db:
        report = await db.get(Report, report_id)
        if report is not None and report.order_id is not None:
            order = await db.get(ReportOrder, report.order_id)
            if order is not None:
                reports.erase_email(order)
                await db.commit()
    log.error("report_email_failed", extra={"report_id": str(report_id)})


register("report_render", render, on_render_failed)
register("report_email", send_email, on_email_failed)
