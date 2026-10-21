"""Safety resources, astrologer reports, the moderation queue and strikes (docs/api/trust.md
§3-§4, ADR-0012).

- `GET /v1/safety/resources` (public): verified crisis helplines (data/safety/helplines.json).
- `GET /v1/safety/conduct` (public): data/safety/conduct.json as is.
- `POST /v1/reports/astrologer` (signed in, Idempotency-Key): one open report per user per
  astrologer; the note is encrypted at rest.
- `GET /v1/admin/moderation`: reports, safety flags and refused astrologer messages, with reason
  codes and counts, never chat text. `GET /v1/admin/moderation/{id}/message` reveals the one
  flagged message of a `safety` item (or a report's note), audited with the admin id.
  `POST /v1/admin/moderation/{id}`: dismiss | warn (a strike) | suspend (a strike plus the
  existing astrologer suspension, admin_marketplace.suspend).
- `GET /v1/astrologer/me/strikes`: the astrologer's own strikes (the admin's note, or the broken
  rule's text when there is none).

Nothing here logs notes, message text or phone numbers; audit entries carry ids and codes.
"""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import admin_marketplace, safety
from astro_api.applicant import own_astrologer
from astro_api.audit import audit
from astro_api.auth import CurrentUser
from astro_api.chat_crypto import Sealed, aad
from astro_api.db import Db, redis_of
from astro_api.errors import ApiError
from astro_api.idempotency import Idempotency, body_hash, idempotency_key
from astro_api.marketplace import decode_cursor, encode_cursor
from astro_api.models import Astrologer, ConsultSession, User
from astro_api.models_safety import (
    NOTE_MAX,
    AstrologerStrike,
    ModerationEvent,
    SafetyEvent,
    report_note_aad,
)
from astro_api.models_sessions import ChatMessage
from astro_api.roles import AdminUser, actor
from astro_api.session_service import cipher_for

router = APIRouter(tags=["safety"])

ReportReason = Literal[
    "harassment", "scam", "fear_selling", "medical_claims", "off_platform", "other"
]
Limit = Annotated[int, Query(ge=1, le=100)]
# The conduct rule a strike points the astrologer to (conduct.json ids).
RULE_FOR_REASON: dict[str, str] = {
    **{r: r for r in safety.REFUSALS},
    "harassment": "harassment",
    "scam": "off_platform_payment",
    "fear_selling": "fear_selling",
    "medical_claims": "cure_claim",
    "off_platform": "contact_details",
    "self_harm": "crisis",
    "emergency": "crisis",
}


def _iso(v: dt.datetime | None) -> str | None:
    return v.astimezone(dt.UTC).isoformat() if v is not None else None


# ---------------------------------------------------------------- public


@router.get("/v1/safety/resources")
async def resources() -> dict[str, Any]:
    """Crisis helplines and the not-a-helpline notice, both languages (trust.ts SafetyResources)."""
    return safety.resources()


@router.get("/v1/safety/conduct")
async def conduct() -> dict[str, Any]:
    """data/safety/conduct.json: the astrologer conduct rules and the crisis guidance."""
    return safety.conduct()


# ---------------------------------------------------------------- reports


class ReportIn(BaseModel):
    astrologer_id: uuid.UUID
    session_id: uuid.UUID | None = None
    reason: ReportReason
    note: str | None = Field(default=None, max_length=NOTE_MAX)


def _report_view(item: ModerationEvent) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "astrologer_id": str(item.astrologer_id),
        "session_id": str(item.session_id) if item.session_id else None,
        "reason": item.reason,
        "status": item.status,
        "has_note": item.note_ciphertext is not None,
        "created_at": _iso(item.created_at),
    }


async def _report_by_key(db: AsyncSession, user: User, key: str) -> ModerationEvent | None:
    return (
        await db.execute(
            select(ModerationEvent).where(
                ModerationEvent.reporter_user_id == user.id,
                ModerationEvent.idempotency_key == key,
            )
        )
    ).scalar_one_or_none()


async def _open_report(
    db: AsyncSession, user: User, astrologer_id: uuid.UUID
) -> ModerationEvent | None:
    return (
        await db.execute(
            select(ModerationEvent).where(
                ModerationEvent.kind == "report",
                ModerationEvent.status == "open",
                ModerationEvent.reporter_user_id == user.id,
                ModerationEvent.astrologer_id == astrologer_id,
            )
        )
    ).scalar_one_or_none()


def _replay(item: ModerationEvent, request_hash: str) -> dict[str, Any]:
    if item.request_hash != request_hash:
        raise ApiError(
            409, "idempotency_conflict", "This Idempotency-Key was used for another request."
        )
    return _report_view(item)


def _already_open(item: ModerationEvent) -> ApiError:
    return ApiError(
        409,
        "report_open",
        "You already have an open report about this astrologer.",
        report_id=str(item.id),
    )


@router.post("/v1/reports/astrologer", status_code=201)
async def report_astrologer(
    body: ReportIn,
    request: Request,
    user: CurrentUser,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    payload = body.model_dump(mode="json")
    idem = Idempotency(redis_of(request), scope=f"report:{user.id}", key=key, payload=payload)
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        out = await _report(db, request, user, body, key, body_hash(payload))
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    return JSONResponse(out, status_code=201)


async def _report(
    db: AsyncSession, request: Request, user: User, body: ReportIn, key: str, request_hash: str
) -> dict[str, Any]:
    # Backed by UNIQUE(reporter_user_id, idempotency_key): survives a Redis flush.
    previous = await _report_by_key(db, user, key)
    if previous is not None:
        return _replay(previous, request_hash)
    a = await db.get(Astrologer, body.astrologer_id)
    if a is None:
        raise ApiError(404, "not_found", "Astrologer not found.")
    if a.user_id == user.id:
        raise ApiError(409, "own_profile", "You cannot report yourself.")
    if body.session_id is not None:
        s = await db.get(ConsultSession, body.session_id)
        if s is None or s.user_id != user.id or s.astrologer_id != a.id:
            raise ApiError(404, "session_not_found", "Session not found.")
    if (existing := await _open_report(db, user, a.id)) is not None:
        raise _already_open(existing)

    item_id = uuid.uuid4()
    note = (body.note or "").strip() or None
    sealed = cipher_for(request.app.state).encrypt(note, report_note_aad(item_id)) if note else None
    item = ModerationEvent(
        id=item_id,
        kind="report",
        reason=body.reason,
        astrologer_id=a.id,
        session_id=body.session_id,
        reporter_user_id=user.id,
        idempotency_key=key,
        request_hash=request_hash,
        note_ciphertext=sealed.ciphertext if sealed else None,
        note_nonce=sealed.nonce if sealed else None,
        note_key_id=sealed.key_id if sealed else None,
    )
    db.add(item)
    # Reason code and ids only: the note may name people.
    audit(db, actor(user), "astrologer.report", "astrologer", str(a.id), report_id=str(item_id))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if (again := await _report_by_key(db, user, key)) is not None:
            return _replay(again, request_hash)
        if (existing := await _open_report(db, user, a.id)) is not None:
            raise _already_open(existing) from None
        raise
    await db.refresh(item)
    return _report_view(item)


# ---------------------------------------------------------------- admin queue


async def _counts(db: AsyncSession, astrologer_ids: set[uuid.UUID]) -> dict[uuid.UUID, Any]:
    """Per astrologer, over open items: reports, safety flags, and refused messages (repeats
    of one rule in one session are one item with a count)."""
    out: dict[uuid.UUID, dict[str, int]] = {
        a: {"reports": 0, "safety": 0, "refused": 0} for a in astrologer_ids
    }
    if not astrologer_ids:
        return out
    rows = await db.execute(
        select(ModerationEvent.astrologer_id, ModerationEvent.kind, func.sum(ModerationEvent.count))
        .where(
            ModerationEvent.astrologer_id.in_(astrologer_ids),
            ModerationEvent.status == "open",
        )
        .group_by(ModerationEvent.astrologer_id, ModerationEvent.kind)
    )
    field = {"report": "reports", "safety": "safety", "refused": "refused"}
    for aid, kind, total in rows.all():
        out[aid][field[kind]] = int(total or 0)
    return out


def _item_view(
    item: ModerationEvent, a: Astrologer | None, counts: dict[str, int]
) -> dict[str, Any]:
    resolution = (
        {
            "action": item.action,
            "note": item.action_note,
            "by": item.closed_by,
            "at": _iso(item.closed_at),
        }
        if item.status == "closed"
        else None
    )
    return {
        "id": str(item.id),
        "kind": item.kind,
        "status": item.status,
        "astrologer": {
            "id": str(item.astrologer_id),
            "slug": a.slug if a else None,
            "display_name": a.display_name if a else None,
        },
        "reasons": [item.reason],
        "session_id": str(item.session_id) if item.session_id else None,
        "counts": counts,
        "created_at": _iso(item.created_at),
        "resolution": resolution,
    }


async def _views(db: AsyncSession, items: list[ModerationEvent]) -> list[dict[str, Any]]:
    ids = {i.astrologer_id for i in items}
    found = await db.execute(select(Astrologer).where(Astrologer.id.in_(ids))) if ids else None
    astrologers = {a.id: a for a in found.scalars()} if found is not None else {}
    counts = await _counts(db, ids)
    return [_item_view(i, astrologers.get(i.astrologer_id), counts[i.astrologer_id]) for i in items]


@router.get("/v1/admin/moderation")
async def queue(
    admin_user: AdminUser,
    db: Db,
    kind: Literal["report", "safety", "refused"] | None = None,
    status: Literal["open", "closed"] = "open",
    cursor: str | None = None,
    limit: Limit = 50,
) -> dict[str, Any]:
    offset = decode_cursor(cursor)
    q = select(ModerationEvent).where(ModerationEvent.status == status)
    if kind is not None:
        q = q.where(ModerationEvent.kind == kind)
    rows = list(
        (
            await db.execute(
                q.order_by(ModerationEvent.last_at.desc(), ModerationEvent.id.desc())
                .offset(offset)
                .limit(limit + 1)
            )
        ).scalars()
    )
    return {
        "items": await _views(db, rows[:limit]),
        "next_cursor": encode_cursor(offset + limit) if len(rows) > limit else None,
    }


async def _item(db: AsyncSession, item_id: uuid.UUID, *, lock: bool = False) -> ModerationEvent:
    q = select(ModerationEvent).where(ModerationEvent.id == item_id)
    if lock:
        q = q.with_for_update()
    item = (await db.execute(q)).scalar_one_or_none()
    if item is None:
        raise ApiError(404, "not_found", "Moderation item not found.")
    return item


@router.get("/v1/admin/moderation/{item_id}/message")
async def reveal(
    admin_user: AdminUser, item_id: uuid.UUID, request: Request, db: Db
) -> dict[str, Any]:
    """The one flagged message of a `safety` item, decrypted; audited with the admin id.
    Refused messages were never stored and reports point at no message, so those are 404."""
    item = await _item(db, item_id)
    ev = await db.get(SafetyEvent, item.safety_event_id) if item.safety_event_id else None
    if item.kind != "safety" or ev is None:
        raise ApiError(404, "no_message", "No message is stored for this item.")
    m = (
        await db.execute(
            select(ChatMessage).where(
                ChatMessage.session_id == ev.session_id, ChatMessage.seq == ev.message_seq
            )
        )
    ).scalar_one_or_none()
    if m is None:
        raise ApiError(404, "message_gone", "The flagged message no longer exists.")
    sealed = Sealed(m.ciphertext, m.nonce, m.key_id)
    text = cipher_for(request.app.state).decrypt(sealed, aad(m.session_id, m.seq))
    audit(
        db,
        actor(admin_user),
        "moderation.reveal",
        "moderation_event",
        str(item.id),
        session_id=str(m.session_id),
        seq=m.seq,
    )
    await db.commit()
    return {
        "message": {"seq": m.seq, "sender": m.sender, "text": text, "sent_at": _iso(m.created_at)}
    }


class ActionIn(BaseModel):
    action: Literal["dismiss", "warn", "suspend"]
    note: str = Field(default="", max_length=NOTE_MAX)


@router.post("/v1/admin/moderation/{item_id}")
async def act(admin_user: AdminUser, item_id: uuid.UUID, body: ActionIn, db: Db) -> dict[str, Any]:
    item = await _item(db, item_id, lock=True)
    if item.status != "open":
        raise ApiError(409, "already_closed", "This item has already been handled.")
    who = actor(admin_user)
    item.status, item.action = "closed", body.action
    item.closed_at, item.closed_by = dt.datetime.now(dt.UTC), who
    item.action_note = body.note.strip() or None
    if body.action in ("warn", "suspend"):
        # The astrologer sees this note; without one, the text of the rule that was broken.
        db.add(
            AstrologerStrike(
                astrologer_id=item.astrologer_id,
                moderation_event_id=item.id,
                kind=item.kind,
                reason=item.reason,
                action=body.action,
                note=item.action_note or _rule_text(item.reason),
                created_by=who,
            )
        )
    # Ids and codes only: the admin's note may mention the client.
    audit(
        db,
        who,
        f"moderation.{body.action}",
        "moderation_event",
        str(item.id),
        kind=item.kind,
        reason=item.reason,
        astrologer_id=str(item.astrologer_id),
    )
    if body.action == "suspend":
        # The existing suspension path (status, reason, audit); it commits everything above
        # together, or raises (e.g. 409 invalid_transition) and nothing is written.
        reason = admin_marketplace.ReasonIn(reason=f"Moderation ({item.kind}): {item.reason}")
        await admin_marketplace.suspend(admin_user, item.astrologer_id, reason, db)
    else:
        await db.commit()
    return (await _views(db, [item]))[0]


# ---------------------------------------------------------------- astrologer portal


def _rule_text(reason: str) -> str:
    rules = {r["id"]: r for r in safety.conduct()["rules"]}
    rule = rules.get(RULE_FOR_REASON.get(reason, ""))
    return str(rule["rule"]["en"]) if rule else "Please review the platform's conduct rules."


@router.get("/v1/astrologer/me/strikes")
async def my_strikes(user: CurrentUser, db: Db) -> dict[str, Any]:
    """The astrologer's own strikes, newest first (the warn note, never client data)."""
    a = await own_astrologer(db, user)
    rows = (
        await db.execute(
            select(AstrologerStrike)
            .where(AstrologerStrike.astrologer_id == a.id)
            .order_by(AstrologerStrike.created_at.desc(), AstrologerStrike.id)
        )
    ).scalars()
    return {
        "items": [{"id": str(x.id), "note": x.note, "created_at": _iso(x.created_at)} for x in rows]
    }
