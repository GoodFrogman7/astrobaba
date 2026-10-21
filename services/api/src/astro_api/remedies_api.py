"""Remedies catalogue and partner leads (docs/api/revenue.md §4).

We list services that partners perform and pass on enquiries; we sell nothing ourselves, hold no
inventory and promise no outcome. The catalogue is static data (data/marketplace/remedies.json).
Entries whose partner is inactive, unknown, or `dev_only` outside development/test are never
shown, so staging/production return an empty catalogue until a real partner is configured; the
API never makes up an entry.

Leads hold the phone number the user agreed to share (for the partner hand-off only; masked in
every view) and an optional note encrypted at rest with the chat key. A `remedy_lead_notify` job,
enqueued in the same transaction, sends the lead to the partner. Phones and notes are never
logged.
"""

import base64
import datetime as dt
import json
import uuid
from functools import cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, and_, or_, select, true
from sqlalchemy.exc import IntegrityError

from astro_api import jobs
from astro_api.audit import audit
from astro_api.auth import CurrentUser
from astro_api.config import Settings
from astro_api.consent import RequireUserConsent
from astro_api.db import Db, redis_of, settings_of
from astro_api.earnings import IST
from astro_api.errors import ApiError
from astro_api.idempotency import Idempotency, idempotency_key
from astro_api.models_remedies import RemedyLead, note_aad
from astro_api.phone import mask_phone
from astro_api.ratelimit import bucket_key, incr_window
from astro_api.roles import AdminUser, actor
from astro_api.session_service import cipher_for
from astro_api.shared_files import marketplace_dir

router = APIRouter(prefix="/v1", tags=["remedies"])

LEADS_PER_DAY = 5
LEAD_WINDOW_S = 24 * 3600
NOTE_MAX = 500
MAX_DAYS_AHEAD = 365
NOTIFY_JOB = "remedy_lead_notify"
Limit = Annotated[int, Query(ge=1, le=100)]


# ---------------------------------------------------------------- catalogue


@cache
def catalogue_file() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (marketplace_dir() / "remedies.json").read_text(encoding="utf-8")
    )
    return data


def partner(partner_id: str, settings: Settings) -> dict[str, Any] | None:
    """The partner if leads may go to it in this environment, else None."""
    p: dict[str, Any] | None = next(
        (x for x in catalogue_file()["partners"] if x["id"] == partner_id), None
    )
    if p is None or not p.get("active", False):
        return None
    if p.get("dev_only", False) and settings.is_production:
        return None
    return p


def visible_remedies(settings: Settings) -> list[dict[str, Any]]:
    return [
        r
        for r in catalogue_file()["remedies"]
        if r.get("active", True) and partner(r["partner_id"], settings) is not None
    ]


def find_remedy(remedy_id: str, settings: Settings) -> dict[str, Any] | None:
    return next((r for r in visible_remedies(settings) if r["id"] == remedy_id), None)


def remedy_name(remedy_id: str) -> dict[str, str] | None:
    """Name of any catalogue entry, shown or not (admin and partner hand-off)."""
    r = next((x for x in catalogue_file()["remedies"] if x["id"] == remedy_id), None)
    return dict(r["name"]) if r else None


def remedy_view(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "kind": r["kind"],
        "name": r["name"],
        "description": r["description"],
        "price_note": r["price_note"],
        "review": r.get("review", catalogue_file().get("review")),
    }


@router.get("/remedies")
async def list_remedies(request: Request) -> dict[str, Any]:
    items = [remedy_view(r) for r in visible_remedies(settings_of(request))]
    return {"items": items, "notice": catalogue_file()["notice"]}


# ---------------------------------------------------------------- leads


class LeadIn(BaseModel):
    remedy_id: str = Field(min_length=1, max_length=64)
    preferred_date: dt.date | None = None
    language: Literal["en", "hi"]
    note: str | None = Field(default=None, max_length=NOTE_MAX)
    consent: bool = False


def _today_ist() -> dt.date:
    return dt.datetime.now(dt.UTC).astimezone(IST).date()


def _validate(body: LeadIn, settings: Settings) -> dict[str, Any]:
    if body.consent is not True:
        raise ApiError(
            422,
            "consent_required",
            "Agree to share your phone number with the partner to send this enquiry.",
        )
    remedy = find_remedy(body.remedy_id, settings)
    if remedy is None:
        raise ApiError(404, "remedy_not_found", "This service is not available.")
    if body.preferred_date is not None:
        today = _today_ist()
        if not today <= body.preferred_date <= today + dt.timedelta(days=MAX_DAYS_AHEAD):
            raise ApiError(
                422,
                "invalid_preferred_date",
                f"Choose a date from today up to {MAX_DAYS_AHEAD} days ahead.",
            )
    return remedy


@router.post("/remedies/leads", status_code=201, dependencies=[RequireUserConsent])
async def create_lead(
    body: LeadIn,
    request: Request,
    user: CurrentUser,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    settings = settings_of(request)
    redis = redis_of(request)
    remedy = _validate(body, settings)
    note = (body.note or "").strip() or None
    idem = Idempotency(redis, scope=f"remedy_lead:{user.id}", key=key, payload=body.model_dump())
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        existing = (
            await db.execute(
                select(RemedyLead).where(
                    RemedyLead.user_id == user.id, RemedyLead.idempotency_key == key
                )
            )
        ).scalar_one_or_none()
        if existing is not None:  # Redis forgot the key; Postgres did not
            if (existing.remedy_id, existing.language, existing.preferred_date) != (
                body.remedy_id,
                body.language,
                body.preferred_date,
            ):
                raise ApiError(
                    409,
                    "idempotency_conflict",
                    "This Idempotency-Key was used for another request.",
                )
            lead = existing
        else:
            rl_key = bucket_key(settings.secret_key.get_secret_value(), "remedy_lead", str(user.id))
            if await incr_window(redis, rl_key, LEAD_WINDOW_S) > LEADS_PER_DAY:
                retry_after = max(int(await redis.ttl(rl_key)), 1)
                raise ApiError(
                    429,
                    "rate_limited",
                    f"You can send up to {LEADS_PER_DAY} enquiries a day. Try again later.",
                    headers={"Retry-After": str(retry_after)},
                    retry_after=retry_after,
                )
            lead_id = uuid.uuid4()
            sealed = (
                cipher_for(request.app.state).encrypt(note, note_aad(lead_id)) if note else None
            )
            lead = RemedyLead(
                id=lead_id,
                user_id=user.id,
                idempotency_key=key,
                remedy_id=remedy["id"],
                partner_id=remedy["partner_id"],
                language=body.language,
                preferred_date=body.preferred_date,
                phone=user.phone,
                note_ciphertext=sealed.ciphertext if sealed else None,
                note_nonce=sealed.nonce if sealed else None,
                note_key_id=sealed.key_id if sealed else None,
                consent_at=dt.datetime.now(dt.UTC),
                status="new",
            )
            db.add(lead)
            try:
                await db.flush()
            except IntegrityError as exc:
                raise ApiError(
                    409, "idempotency_in_progress", "The same request is still running."
                ) from exc
            await jobs.enqueue(db, NOTIFY_JOB, {"lead_id": str(lead.id)}, f"lead:{lead.id}:notify")
            audit(
                db,
                actor(user),
                "remedy_lead.create",
                "remedy_lead",
                str(lead.id),
                remedy_id=lead.remedy_id,
                partner_id=lead.partner_id,
            )
            await db.commit()
        out = jsonable_encoder({"id": lead.id, "status": "new"})
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    return JSONResponse(out, status_code=201)


# ---------------------------------------------------------------- admin


def _encode(at: dt.datetime, row_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{at.isoformat()}|{row_id}".encode()).decode()


def _after(cursor: str | None) -> ColumnElement[bool]:
    """Keyset condition: rows after the cursor in (created_at desc, id desc) order."""
    if not cursor:
        return true()
    try:
        raw_at, raw_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|")
        at, row_id = dt.datetime.fromisoformat(raw_at), uuid.UUID(raw_id)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(422, "invalid_cursor", "Bad cursor.") from exc
    return or_(
        RemedyLead.created_at < at, and_(RemedyLead.created_at == at, RemedyLead.id < row_id)
    )


def admin_lead_view(lead: RemedyLead) -> dict[str, Any]:
    """Phone masked; the note is never shown here (it is for the partner only)."""
    return {
        "id": str(lead.id),
        "user_id": str(lead.user_id),
        "remedy_id": lead.remedy_id,
        "remedy_name": remedy_name(lead.remedy_id),
        "partner_id": lead.partner_id,
        "language": lead.language,
        "preferred_date": lead.preferred_date,
        "phone_masked": mask_phone(lead.phone),
        "has_note": lead.note_ciphertext is not None,
        "status": lead.status,
        "admin_note": lead.admin_note,
        "status_changed_at": lead.status_changed_at,
        "notified_at": lead.notified_at,
        "created_at": lead.created_at,
    }


@router.get("/admin/remedies/leads")
async def admin_list_leads(
    _: AdminUser,
    db: Db,
    status: Literal["new", "contacted", "closed", "spam"] | None = None,
    cursor: str | None = None,
    limit: Limit = 50,
) -> dict[str, Any]:
    q = select(RemedyLead).where(_after(cursor))
    if status is not None:
        q = q.where(RemedyLead.status == status)
    q = q.order_by(RemedyLead.created_at.desc(), RemedyLead.id.desc()).limit(limit + 1)
    rows = list((await db.execute(q)).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [admin_lead_view(r) for r in rows],
        "next_cursor": _encode(rows[-1].created_at, rows[-1].id) if more and rows else None,
    }


class LeadStatusIn(BaseModel):
    status: Literal["contacted", "closed", "spam"]
    note: str = Field(default="", max_length=NOTE_MAX)


@router.post("/admin/remedies/leads/{lead_id}")
async def admin_update_lead(
    lead_id: uuid.UUID, body: LeadStatusIn, admin: AdminUser, db: Db
) -> dict[str, Any]:
    lead = (
        await db.execute(select(RemedyLead).where(RemedyLead.id == lead_id).with_for_update())
    ).scalar_one_or_none()
    if lead is None:
        raise ApiError(404, "not_found", "Lead not found.")
    before = lead.status
    lead.status = body.status
    lead.admin_note = body.note.strip() or None
    lead.status_changed_at = dt.datetime.now(dt.UTC)
    lead.status_changed_by = actor(admin)
    # Ids and statuses only: the admin's note may mention the user.
    audit(
        db,
        actor(admin),
        "remedy_lead.status",
        "remedy_lead",
        str(lead.id),
        from_status=before,
        to_status=body.status,
    )
    await db.commit()
    out: dict[str, Any] = jsonable_encoder(admin_lead_view(lead))
    return out
