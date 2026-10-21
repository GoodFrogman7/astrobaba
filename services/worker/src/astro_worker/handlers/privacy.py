"""Job handlers: data_export and account_cleanup (docs/api/trust.md §2, ADR-0011).

data_export (`{"export_id"}`): build the user's JSON export (astro_api.privacy.complete_export),
store it under a random key, mark it ready and schedule its removal. Idempotent: an export that
is no longer queued is skipped. `on_failed` marks it failed so the user may ask again.

account_cleanup: `{"deletion_id"}` removes the report and export files an executed deletion
listed; `{"export_id"}` removes an export file once it has expired. Storage deletes ignore
missing files, so a retried job is harmless. KYC files are never touched here.

Payloads hold ids only; nothing here logs personal data.
"""

import logging
import uuid
from typing import Any

from astro_api import privacy
from astro_api.storage import DocumentStorage, make_storage
from astro_worker.jobs import Context, JobError, register

log = logging.getLogger("astro_worker.privacy")


def _storage(ctx: Context) -> DocumentStorage:
    storage: DocumentStorage | None = ctx.extra.get("storage")
    return storage or make_storage(ctx.settings)


def _id(payload: dict[str, Any], name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(payload[name]))
    except (KeyError, ValueError) as exc:
        raise JobError("bad_payload") from exc


async def build_export(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    export_id = _id(payload, "export_id")
    async with ctx.sessionmaker() as db:
        written = await privacy.complete_export(db, ctx.settings, _storage(ctx), export_id)
    log.info("data_export_done", extra={"export_id": str(export_id), "written": written})


async def export_failed(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    export_id = _id(payload, "export_id")
    async with ctx.sessionmaker() as db:
        await privacy.fail_export(db, export_id, "build_failed")
    log.error("data_export_failed", extra={"job_id": str(job_id), "export_id": str(export_id)})


async def cleanup(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    storage = _storage(ctx)
    async with ctx.sessionmaker() as db:
        if "deletion_id" in payload:
            deletion_id = _id(payload, "deletion_id")
            removed = await privacy.cleanup_deletion_files(db, storage, deletion_id)
            log.info(
                "account_cleanup_done",
                extra={"deletion_id": str(deletion_id), "files": removed},
            )
        elif "export_id" in payload:
            export_id = _id(payload, "export_id")
            expired = await privacy.expire_export(db, storage, export_id)
            log.info("export_expired", extra={"export_id": str(export_id), "removed": expired})
        else:
            raise JobError("bad_payload")


async def cleanup_failed(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    # Ids only. The admin deletions list shows files still pending for a retry.
    log.error("account_cleanup_failed", extra={"job_id": str(job_id)})


register("data_export", build_export, export_failed)
register("account_cleanup", cleanup, cleanup_failed)
