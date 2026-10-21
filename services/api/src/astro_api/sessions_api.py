"""Consultation sessions: request, queue, accept/decline, cancel/end, history, messages and
WebSocket tickets (docs/api/billing.md "Sessions"; state machine in session_service.py)."""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import case, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import free_session, wallet
from astro_api import session_service as svc
from astro_api.audit import audit
from astro_api.auth import client_ip, current_session
from astro_api.db import get_db
from astro_api.errors import ApiError
from astro_api.idempotency import Idempotency, body_hash, idempotency_key
from astro_api.marketplace import decode_cursor, encode_cursor, is_public
from astro_api.models import (
    OPEN_SESSION_STATUSES,
    Astrologer,
    AuthSession,
    ConsultSession,
    User,
)
from astro_api.roles import actor, require_admin
from astro_api.ws_tickets import TICKET_TTL_S, issue

router = APIRouter(prefix="/v1", tags=["sessions"])

# Same values as models.SESSION_STATUSES (checked in tests).
Status = Literal["queued", "requested", "accepted", "active", "completed", "cancelled", "failed"]


class SessionIn(BaseModel):
    astrologer_id: uuid.UUID
    kind: Literal["chat"] = "chat"
    free: bool = False


def _deps(request: Request) -> svc.Deps:
    return svc.Deps.of(request.app)


def _redis(request: Request) -> Redis:
    redis: Redis = request.app.state.redis
    return redis


SessionUser = Annotated[tuple[AuthSession, User], Depends(current_session)]
Db = Annotated[AsyncSession, Depends(get_db)]


async def _astrologer_of(db: AsyncSession, user: User) -> Astrologer | None:
    return (
        await db.execute(select(Astrologer).where(Astrologer.user_id == user.id))
    ).scalar_one_or_none()


async def participant(
    db: AsyncSession, session_id: uuid.UUID, user: User, *, lock: bool = False
) -> tuple[ConsultSession, str]:
    """The session and the caller's role in it; 404 for anyone else."""
    s = await svc.lock(db, session_id) if lock else await db.get(ConsultSession, session_id)
    if s is not None:
        if s.user_id == user.id:
            return s, "user"
        mine = await _astrologer_of(db, user)
        if mine is not None and mine.id == s.astrologer_id:
            return s, "astrologer"
    raise ApiError(404, "not_found", "Session not found.")


def _need_role(role: str, wanted: str) -> None:
    if role != wanted:
        raise ApiError(403, "forbidden", f"Only the {wanted} can do this.")


# ---------------------------------------------------------------- create


async def _existing_by_key(db: AsyncSession, user: User, key: str) -> ConsultSession | None:
    return (
        await db.execute(
            select(ConsultSession).where(
                ConsultSession.user_id == user.id, ConsultSession.idempotency_key == key
            )
        )
    ).scalar_one_or_none()


async def _replay(
    db: AsyncSession, deps: svc.Deps, s: ConsultSession, request_hash: str
) -> dict[str, Any]:
    if s.request_hash != request_hash:
        raise ApiError(
            409, "idempotency_conflict", "This Idempotency-Key was used for another request."
        )
    return await svc.view(db, deps, s, "user")


async def _open_session(db: AsyncSession, user: User) -> ConsultSession | None:
    return (
        await db.execute(
            select(ConsultSession)
            .where(
                ConsultSession.user_id == user.id,
                ConsultSession.status.in_(OPEN_SESSION_STATUSES),
            )
            .limit(1)
        )
    ).scalar_one_or_none()


@router.post("/sessions", status_code=201)
async def create_session(
    body: SessionIn,
    request: Request,
    session_user: SessionUser,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    auth_session, user = session_user
    deps = _deps(request)
    payload = body.model_dump(mode="json")
    idem = Idempotency(_redis(request), scope=f"session:{user.id}", key=key, payload=payload)
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        out = await _create(db, deps, request, auth_session, user, body, key, body_hash(payload))
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(201, out)
    return JSONResponse(out, status_code=201)


async def _create(
    db: AsyncSession,
    deps: svc.Deps,
    request: Request,
    auth_session: AuthSession,
    user: User,
    body: SessionIn,
    key: str,
    request_hash: str,
) -> dict[str, Any]:
    # Backed by UNIQUE(user_id, idempotency_key): survives a Redis flush.
    previous = await _existing_by_key(db, user, key)
    if previous is not None:
        return await _replay(db, deps, previous, request_hash)

    now = svc.utcnow()
    # Lock the astrologer: requests for one astrologer are decided one at a time, so two
    # clients can never both become `requested`.
    a = (
        await db.execute(
            select(Astrologer).where(Astrologer.id == body.astrologer_id).with_for_update()
        )
    ).scalar_one_or_none()
    if a is None or not is_public(a, deps.settings):
        raise ApiError(404, "not_found", "Astrologer not found.")
    bps = svc.commission_bps(a.tier)
    price = a.price_per_min_paise
    if not (a.flags or {}).get("chat_enabled") or price is None or price <= 0 or a.tier is None:
        raise ApiError(409, "chat_unavailable", "This astrologer is not taking chats.")
    if a.user_id == user.id:
        raise ApiError(409, "own_profile", "You cannot consult yourself.")
    open_session = await _open_session(db, user)
    if open_session is not None:
        raise ApiError(
            409,
            "session_open",
            "Finish your current session first.",
            session_id=str(open_session.id),
        )

    rules = svc.rules()
    device_id = auth_session.device_id or "unknown"
    ip = client_ip(request, deps.settings)
    free_minutes: int | None = None
    if body.free:
        eligibility = await free_session.check(
            db, deps.redis, user_id=user.id, device_id=device_id, client_ip=ip
        )
        if not eligibility.eligible:
            raise ApiError(
                403,
                "free_session_unavailable",
                "The free first session is not available.",
                reason=eligibility.reason,
            )
        free_minutes = eligibility.minutes
    else:
        affordable = await wallet.minutes_affordable(db, user.id, price)
        if affordable < rules.min_start_minutes:
            raise ApiError(
                402,
                "insufficient_funds",
                f"Recharge to cover at least {rules.min_start_minutes} minutes.",
                minutes_affordable=affordable,
                required_paise=price * rules.min_start_minutes,
            )

    busy = (
        await db.execute(
            select(ConsultSession.id)
            .where(
                ConsultSession.astrologer_id == a.id,
                ConsultSession.status.in_(("queued", *svc.BUSY_STATUSES)),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    s = ConsultSession(
        user_id=user.id,
        astrologer_id=a.id,
        kind=body.kind,
        status="queued" if busy else "requested",
        queued_at=now if busy else None,
        requested_at=None if busy else now,
        price_per_min_paise=price,
        commission_bps=bps,
        is_free=body.free,
        free_minutes=free_minutes,
        idempotency_key=key,
        request_hash=request_hash,
    )
    db.add(s)
    try:
        await db.flush()
        if body.free and free_minutes is not None:
            # The claim re-checks eligibility under locks (two users on one device cannot both
            # pass); then the session-restricted lot is granted, in the same transaction.
            await free_session.claim(
                db, deps.redis, user_id=user.id, session_id=s.id, device_id=device_id, client_ip=ip
            )
            await wallet.grant_free_session(
                db, user_id=user.id, session_id=s.id, amount_paise=price * free_minutes
            )
        audit(
            db,
            actor(user),
            "session.create",
            "consult_session",
            str(s.id),
            astrologer_id=str(a.id),
            status=s.status,
            free=body.free,
        )
        await db.commit()
    except free_session.FreeSessionUnavailable as exc:
        await db.rollback()
        raise ApiError(
            403,
            "free_session_unavailable",
            "The free first session is not available.",
            reason=exc.reason,
        ) from None
    except IntegrityError:
        # A concurrent request won: same key (replay it) or another open session.
        await db.rollback()
        previous = await _existing_by_key(db, user, key)
        if previous is not None:
            return await _replay(db, deps, previous, request_hash)
        other = await _open_session(db, user)
        raise ApiError(
            409,
            "session_open",
            "Finish your current session first.",
            session_id=str(other.id) if other else None,
        ) from None
    return await svc.view(db, deps, s, "user", astrologer=a, now=now)


# ---------------------------------------------------------------- reads


@router.get("/sessions")
async def list_sessions(
    request: Request,
    session_user: SessionUser,
    db: Db,
    role: Literal["user", "astrologer"] = "user",
    status: Annotated[list[Status] | None, Query()] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    _, user = session_user
    deps = _deps(request)
    offset = decode_cursor(cursor)
    query = select(ConsultSession)
    if role == "user":
        query = query.where(ConsultSession.user_id == user.id)
    else:
        mine = await _astrologer_of(db, user)
        if mine is None:
            return {"items": [], "next_cursor": None}
        query = query.where(ConsultSession.astrologer_id == mine.id)
    if status:
        query = query.where(ConsultSession.status.in_(status))
    rows = list(
        (
            await db.execute(
                query.order_by(ConsultSession.created_at.desc(), ConsultSession.id.desc())
                .offset(offset)
                .limit(limit + 1)
            )
        ).scalars()
    )
    items = [await svc.view(db, deps, s, role) for s in rows[:limit]]
    return {
        "items": items,
        "next_cursor": encode_cursor(offset + limit) if len(rows) > limit else None,
    }


@router.get("/admin/sessions")
async def admin_sessions(
    request: Request,
    _: Annotated[User, Depends(require_admin)],
    db: Db,
    status: Annotated[list[Status] | None, Query()] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    """Recent sessions for support. Metadata only: never message content or the client's phone."""
    deps = _deps(request)
    offset = decode_cursor(cursor)
    query = select(ConsultSession)
    if status:
        query = query.where(ConsultSession.status.in_(status))
    rows = list(
        (
            await db.execute(
                query.order_by(ConsultSession.created_at.desc(), ConsultSession.id.desc())
                .offset(offset)
                .limit(limit + 1)
            )
        ).scalars()
    )
    items = []
    for s in rows[:limit]:
        v = await svc.view(db, deps, s, "astrologer")
        v.pop("role")
        v.pop("minutes_left")
        v.pop("can_review")
        items.append({**v, "user_id": str(s.user_id)})
    return {
        "items": items,
        "next_cursor": encode_cursor(offset + limit) if len(rows) > limit else None,
    }


@router.get("/sessions/{session_id}")
async def get_session(
    session_id: uuid.UUID, request: Request, session_user: SessionUser, db: Db
) -> dict[str, Any]:
    s, role = await participant(db, session_id, session_user[1])
    return await svc.view(db, _deps(request), s, role)


@router.get("/astrologer/me/sessions/incoming")
async def incoming(request: Request, session_user: SessionUser, db: Db) -> dict[str, Any]:
    mine = await _astrologer_of(db, session_user[1])
    if mine is None:
        raise ApiError(404, "not_applied", "You have not applied as an astrologer.")
    order = case(
        (ConsultSession.status == "requested", 0),
        (ConsultSession.status == "accepted", 1),
        (ConsultSession.status == "active", 2),
        else_=3,
    )
    rows = (
        await db.execute(
            select(ConsultSession)
            .where(
                ConsultSession.astrologer_id == mine.id,
                ConsultSession.status.in_(OPEN_SESSION_STATUSES),
            )
            .order_by(order, ConsultSession.queued_at, ConsultSession.created_at)
        )
    ).scalars()
    deps = _deps(request)
    return {"items": [await svc.view(db, deps, s, "astrologer", astrologer=mine) for s in rows]}


@router.get("/sessions/{session_id}/messages")
async def messages(
    session_id: uuid.UUID,
    request: Request,
    session_user: SessionUser,
    db: Db,
    after_seq: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> dict[str, Any]:
    await participant(db, session_id, session_user[1])
    return {"items": await svc.history(db, _deps(request), session_id, after_seq, limit)}


@router.post("/sessions/{session_id}/ws-ticket")
async def ws_ticket(
    session_id: uuid.UUID, request: Request, session_user: SessionUser, db: Db
) -> dict[str, Any]:
    user = session_user[1]
    s, role = await participant(db, session_id, user)
    ticket = await issue(_redis(request), user_id=user.id, session_id=s.id, role=role)
    return {"ticket": ticket, "expires_in": TICKET_TTL_S, "path": f"/v1/sessions/{s.id}/ws"}


# ---------------------------------------------------------------- transitions


async def _done(
    db: AsyncSession, deps: svc.Deps, s: ConsultSession, role: str, now: dt.datetime
) -> dict[str, Any]:
    out = await svc.view(db, deps, s, role, now=now)
    await db.close()
    await svc.after_end(deps, s.id, now)
    return out


@router.post("/sessions/{session_id}/accept")
async def accept(
    session_id: uuid.UUID, request: Request, session_user: SessionUser, db: Db
) -> dict[str, Any]:
    user = session_user[1]
    deps = _deps(request)
    s, role = await participant(db, session_id, user, lock=True)
    _need_role(role, "astrologer")
    if s.status != "requested":
        raise ApiError(409, "session_not_requested", "Only a waiting request can be accepted.")
    now = svc.utcnow()
    s.status = "accepted"
    s.accepted_at = now
    audit(db, actor(user), "session.accept", "consult_session", str(s.id))
    await db.commit()
    await svc.refresh_busy(db, deps, s, now)
    await svc.publish_state(db, deps, s)
    return await svc.view(db, deps, s, role, now=now)


@router.post("/sessions/{session_id}/decline")
async def decline(
    session_id: uuid.UUID, request: Request, session_user: SessionUser, db: Db
) -> dict[str, Any]:
    user = session_user[1]
    deps = _deps(request)
    s, role = await participant(db, session_id, user, lock=True)
    _need_role(role, "astrologer")
    if s.status not in ("requested", "queued"):
        raise ApiError(409, "session_not_requested", "Only a waiting request can be declined.")
    now = svc.utcnow()
    await svc.finish(db, deps, s, "cancelled", "astrologer_declined", now, actor(user))
    await db.commit()
    return await _done(db, deps, s, role, now)


@router.post("/sessions/{session_id}/cancel")
async def cancel(
    session_id: uuid.UUID, request: Request, session_user: SessionUser, db: Db
) -> dict[str, Any]:
    user = session_user[1]
    deps = _deps(request)
    s, role = await participant(db, session_id, user, lock=True)
    _need_role(role, "user")
    if s.status == "active":
        raise ApiError(409, "session_active", "The session has started; end it instead.")
    if s.status not in ("queued", "requested", "accepted"):
        raise ApiError(409, "session_over", "This session has already ended.")
    now = svc.utcnow()
    await svc.finish(db, deps, s, "cancelled", "user_cancelled", now, actor(user))
    await db.commit()
    return await _done(db, deps, s, role, now)


@router.post("/sessions/{session_id}/end")
async def end(
    session_id: uuid.UUID, request: Request, session_user: SessionUser, db: Db
) -> dict[str, Any]:
    user = session_user[1]
    deps = _deps(request)
    s, role = await participant(db, session_id, user, lock=True)
    if s.status != "active":
        raise ApiError(409, "session_not_active", "Only an active session can be ended.")
    now = svc.utcnow()
    await svc.finish(db, deps, s, "completed", f"{role}_ended", now, actor(user))
    await db.commit()
    return await _done(db, deps, s, role, now)
