"""Consents, data export and account deletion (docs/api/trust.md §1-§2, ADR-0011).

Errors `{"detail": {"code", "message", ...}}`. Nothing here logs personal data; audit entries
carry ids only.
"""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

import anyio
from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, tuple_

from astro_api import consent, privacy, wallet
from astro_api.auth import CurrentSession, CurrentUser, client_ip, current_session
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.marketplace import presence_key
from astro_api.models_privacy import DataExport, DeletionRequest
from astro_api.roles import AdminUser, actor
from astro_api.storage import DocumentStorage

router = APIRouter(tags=["privacy"])

PRIVATE = {"Cache-Control": "private, no-store", "X-Robots-Tag": "noindex"}
TO_BE_PUBLISHED = "to be published"

ConsentKind = Literal["age_18", "terms", "privacy", "astrologer_terms"]


# ------------------------------------------------------------------ §1 legal and consents


def _published(value: Any) -> Any:
    """policies.json with every null shown as "to be published" (founder_to_fill markers kept)."""
    if value is None:
        return TO_BE_PUBLISHED
    if isinstance(value, dict):
        return {k: _published(v) for k, v in value.items() if k != "$comment"}
    if isinstance(value, list):
        return [_published(v) for v in value]
    return value


@router.get("/v1/legal")
async def legal() -> JSONResponse:
    p = consent.policies()
    body = {
        key: _published(p.get(key))
        for key in (
            "version",
            "status",
            "documents",
            "operator",
            "grievance_officer",
            "processors",
            "retention",
        )
    }
    return JSONResponse(body, headers={"Cache-Control": "public, max-age=300"})


class ConsentIn(BaseModel):
    version: str = Field(min_length=1, max_length=32)
    kinds: list[ConsentKind] = Field(min_length=1, max_length=4)


@router.get("/v1/me/consents")
async def get_consents(user: CurrentUser, db: Db) -> dict[str, Any]:
    return await consent.state(db, user.id)


@router.post("/v1/me/consents")
async def post_consents(
    body: ConsentIn, request: Request, session_user: CurrentSession, db: Db
) -> dict[str, Any]:
    auth_session, user = session_user
    version = consent.current_version()
    if body.version != version:
        raise ApiError(
            409,
            "consent_version_stale",
            "The terms have changed. Please review the current version.",
            version=version,
        )
    settings = settings_of(request)
    await consent.record(
        db,
        user,
        body.kinds,
        version=version,
        ip_hash=consent.hmac_hex(settings, "consent_ip", client_ip(request, settings)),
        device_hash=(
            consent.hmac_hex(settings, "consent_device", auth_session.device_id)
            if auth_session.device_id
            else None
        ),
    )
    await db.commit()
    return await consent.state(db, user.id)


# ------------------------------------------------------------------ §2 export


def export_view(e: DataExport, request: Request) -> dict[str, Any]:
    ready = e.status == "ready" and e.storage_key is not None
    return {
        "id": str(e.id),
        "status": e.status,
        "created_at": e.created_at.isoformat(),
        "expires_at": e.expires_at.isoformat() if ready and e.expires_at else None,
        "download_url": privacy.export_download_url(settings_of(request), e.id) if ready else None,
    }


@router.post("/v1/me/export", status_code=202)
async def request_export(request: Request, user: CurrentUser, db: Db) -> JSONResponse:
    try:
        export = await privacy.request_export(db, user)
    except privacy.ExportRateLimited as exc:
        raise ApiError(
            429,
            "export_rate_limited",
            "You can request one export per day.",
            headers={"Retry-After": str(exc.retry_after_s)},
            retry_after_s=exc.retry_after_s,
        ) from exc
    except privacy.AccountDeleted as exc:  # pragma: no cover - deleted accounts cannot sign in
        raise ApiError(409, "account_deleted", "This account was deleted.") from exc
    await db.commit()
    return JSONResponse(
        {"id": str(export.id), "status": export.status}, status_code=202, headers=PRIVATE
    )


@router.get("/v1/me/exports")
async def list_exports(request: Request, user: CurrentUser, db: Db) -> JSONResponse:
    rows = (
        await db.execute(
            select(DataExport)
            .where(DataExport.user_id == user.id)
            .order_by(DataExport.created_at.desc(), DataExport.id)
            .limit(20)
        )
    ).scalars()
    return JSONResponse([export_view(e, request) for e in rows], headers=PRIVATE)


@router.get("/v1/me/exports/{export_id}/file")
async def download_export(
    export_id: uuid.UUID,
    request: Request,
    db: Db,
    sig: str | None = None,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    """The JSON file: with a valid 10-minute signed link, or with the owner's session."""
    settings = settings_of(request)
    status = privacy.check_export_sig(settings, export_id, sig)
    export = await db.get(DataExport, export_id)
    allowed = status == "ok"
    if not allowed and authorization:
        _, user = await current_session(db, authorization)
        allowed = export is not None and export.user_id == user.id
    if not allowed:
        if status == "expired":
            raise ApiError(410, "link_expired", "This link has expired.")
        if sig:
            raise ApiError(403, "invalid_signature", "This link is invalid.")
        raise ApiError(401, "unauthenticated", "Sign in to continue.")
    if export is None or export.status != "ready" or export.storage_key is None:
        raise ApiError(404, "not_found", "Export not found.")
    storage: DocumentStorage = request.app.state.storage
    data = await anyio.to_thread.run_sync(storage.get, export.storage_key)
    name = f"astro-data-export-{str(export.id)[:8]}.json"
    return Response(
        data,
        media_type="application/json",
        headers={**PRIVATE, "Content-Disposition": f'attachment; filename="{name}"'},
    )


# ------------------------------------------------------------------ §2 deletion


class DeletionIn(BaseModel):
    confirm: str


def deletion_view(d: DeletionRequest) -> dict[str, Any]:
    return {
        "id": str(d.id),
        "status": d.status,
        "requested_at": d.requested_at.isoformat(),
        "cancelled_at": d.cancelled_at.isoformat() if d.cancelled_at else None,
        "executed_at": d.executed_at.isoformat() if d.executed_at else None,
    }


@router.post("/v1/me/deletion", status_code=202)
async def request_deletion(body: DeletionIn, user: CurrentUser, db: Db) -> JSONResponse:
    if body.confirm != "DELETE":
        raise ApiError(422, "confirm_required", 'Type "DELETE" to confirm.')
    d = await privacy.request_deletion(db, user)
    await db.commit()
    return JSONResponse(deletion_view(d), status_code=202, headers=PRIVATE)


@router.get("/v1/me/deletion")
async def get_deletion(user: CurrentUser, db: Db) -> JSONResponse:
    d = await privacy.open_deletion(db, user.id)
    if d is None:
        raise ApiError(404, "not_found", "No open deletion request.")
    return JSONResponse(deletion_view(d), headers=PRIVATE)


@router.delete("/v1/me/deletion")
async def cancel_deletion(user: CurrentUser, db: Db) -> JSONResponse:
    d = await privacy.cancel_deletion(db, user)
    if d is None:
        raise ApiError(404, "not_found", "No open deletion request.")
    await db.commit()
    return JSONResponse(deletion_view(d), headers=PRIVATE)


ADMIN_PAGE = 50


def _cursor(requested_at: dt.datetime, deletion_id: uuid.UUID) -> str:
    return f"{int(requested_at.timestamp() * 1_000_000)}_{deletion_id}"


def _parse_cursor(raw: str) -> tuple[dt.datetime, uuid.UUID]:
    micros, _, rid = raw.partition("_")
    try:
        return dt.datetime.fromtimestamp(int(micros) / 1_000_000, dt.UTC), uuid.UUID(rid)
    except ValueError as exc:
        raise ApiError(422, "invalid_cursor", "Bad cursor.") from exc


@router.get("/v1/admin/deletions", tags=["admin"])
async def admin_list_deletions(
    admin: AdminUser,
    db: Db,
    status: Literal["requested", "all"] = "requested",
    cursor: str | None = None,
) -> JSONResponse:
    """Oldest first. Each item says what would block execution: open sessions (as client or
    astrologer) and the wallet balance (real must be settled; promo is forfeited)."""
    query = select(DeletionRequest)
    if status == "requested":
        query = query.where(DeletionRequest.status == "requested")
    if cursor:
        at, rid = _parse_cursor(cursor)
        query = query.where(tuple_(DeletionRequest.requested_at, DeletionRequest.id) > (at, rid))
    rows = list(
        (
            await db.execute(
                query.order_by(DeletionRequest.requested_at, DeletionRequest.id).limit(
                    ADMIN_PAGE + 1
                )
            )
        ).scalars()
    )
    items = []
    for d in rows[:ADMIN_PAGE]:
        balances = await wallet.balances(db, d.user_id)
        items.append(
            {
                "id": str(d.id),
                "user_id": str(d.user_id),
                "status": d.status,
                "requested_at": d.requested_at.isoformat(),
                "open_sessions": await privacy.open_session_count(db, d.user_id),
                "wallet_balance_paise": {
                    "real": balances.real_paise,
                    "promo": balances.promo_paise,
                },
                # Additions: execution and cleanup state.
                "executed_at": d.executed_at.isoformat() if d.executed_at else None,
                "files_pending": len(d.pending_files or []),
                "kyc_review_required": d.kyc_review_required,
            }
        )
    last = rows[ADMIN_PAGE - 1] if len(rows) > ADMIN_PAGE else None
    next_cursor = _cursor(last.requested_at, last.id) if last else None
    return JSONResponse({"items": items, "next_cursor": next_cursor}, headers=PRIVATE)


@router.post("/v1/admin/deletions/{deletion_id}/execute", tags=["admin"])
async def admin_execute_deletion(
    deletion_id: uuid.UUID, request: Request, admin: AdminUser, db: Db
) -> JSONResponse:
    try:
        result = await privacy.execute_deletion(
            db, deletion_id, actor=actor(admin), settings=settings_of(request)
        )
    except privacy.DeletionNotFound as exc:
        raise ApiError(404, "not_found", "Deletion request not found.") from exc
    except privacy.DeletionNotOpen as exc:
        raise ApiError(
            409, "deletion_not_open", "This request is not open.", request_status=exc.status
        ) from exc
    except privacy.SessionOpen as exc:
        raise ApiError(
            409,
            "session_open",
            "The account has a consultation in progress.",
            session_ids=exc.session_ids,
        ) from exc
    except privacy.BalanceOutstanding as exc:
        raise ApiError(
            409,
            "balance_outstanding",
            "Settle the wallet or astrologer balance first.",
            real_paise=exc.real_paise,
            payable_paise=exc.payable_paise,
        ) from exc
    except privacy.WorkPending as exc:
        raise ApiError(
            409, "work_pending", "Wait for queued work to finish.", pending=exc.pending
        ) from exc
    await db.commit()
    if result.astrologer_id is not None:
        # Presence is a Redis key with a TTL; drop it now so the profile is offline at once.
        await redis_of(request).delete(presence_key(result.astrologer_id))
    return JSONResponse({**deletion_view(result.request), **result.summary}, headers=PRIVATE)
