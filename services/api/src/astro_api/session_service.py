"""Consultation session state machine (docs/api/billing.md "Lifecycle", ADR-0007).

```
create ─┬─ astrologer free → requested
        └─ astrologer busy / pending request / queue not empty → queued
queued    ── head of queue when the astrologer frees up ──> requested
requested ── accept ──> accepted ── both sockets connected ──> active (minute 1 charged)
           (a call also needs both participants in the LiveKit room)
requested ── decline / request_timeout_s ──> cancelled
accepted  ── join_timeout_s ──> failed (join_timeout)
active    ── end / funds out / free minutes used / side gone > grace ──> completed
open      ── user cancel (before active) ──> cancelled
```

Every transition locks the session row (`FOR UPDATE`, `SKIP LOCKED` in the meter) and re-checks
the status under the lock, so concurrent actors (two API processes, a socket and the meter) can
race safely: the loser sees the new status and does nothing. Money calls go through
`wallet.<fn>` / `refunds.<fn>` / `free_session.<fn>` looked up on the module at call time.

Ending is two steps. `finish()` runs inside the caller's transaction (status, end reason, end
time, closing the session's promo lot, a system message). After that commits, `after_end()`
restores presence, promotes the queue, tells both sockets and runs the refund rules in their own
transaction, then stamps `settled_at`. If the process dies in between, the meter's sweep re-runs
`after_end()` (every step is idempotent). For a call, `after_end()` also deletes the LiveKit room
(disconnecting both sides); if LiveKit cannot be reached the end stands, `settled_at` stays
empty and the sweep tries the delete again.
"""

import asyncio
import datetime as dt
import hashlib
import hmac
import logging
import math
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from astro_api import billing_config, chat_bus, livekit_client, refunds, wallet
from astro_api.audit import audit
from astro_api.chat_crypto import MessageCipher, Sealed, aad, cipher_from_settings
from astro_api.config import Settings
from astro_api.marketplace import busy_until_key, presence_key
from astro_api.models import (
    ENDED_SESSION_STATUSES,
    OPEN_SESSION_STATUSES,
    Astrologer,
    ConsultSession,
    Review,
)
from astro_api.models_sessions import ChatMessage

log = logging.getLogger("astro_api.sessions")

BUSY_STATUSES = ("requested", "accepted", "active")  # an astrologer with one of these is not free
ROLES = chat_bus.ROLES


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


# ---------------------------------------------------------------- configuration


@dataclass(frozen=True)
class SessionRules:
    request_timeout_s: float
    join_timeout_s: float
    heartbeat_grace_s: float
    average_session_minutes: int
    min_start_minutes: int
    low_balance_warning_minutes: int


def rules() -> SessionRules:
    s = billing_config.sessions()
    return SessionRules(
        request_timeout_s=float(s["request_timeout_s"]),
        join_timeout_s=float(s["join_timeout_s"]),
        heartbeat_grace_s=float(s["heartbeat_grace_s"]),
        average_session_minutes=int(s["average_session_minutes"]),
        min_start_minutes=int(s["min_start_minutes"]),
        low_balance_warning_minutes=int(s["low_balance_warning_minutes"]),
    )


# ---------------------------------------------------------------- dependencies


@dataclass
class Deps:
    """What the state machine needs from the app; built once per app (or per test)."""

    sessionmaker: async_sessionmaker[AsyncSession]
    redis: Redis
    settings: Settings
    cipher: MessageCipher
    # LiveKit (voice calls); created from the settings on first use when not given.
    calls: livekit_client.CallBackend | None = None

    @property
    def minute(self) -> dt.timedelta:
        return dt.timedelta(seconds=self.settings.billing_minute_seconds)

    def call_backend(self) -> livekit_client.CallBackend:
        if self.calls is None:
            self.calls = livekit_client.backend_from_settings(self.settings)
        return self.calls

    @classmethod
    def of(cls, target: "FastAPI | Deps") -> "Deps":
        if isinstance(target, Deps):
            return target
        state = target.state
        deps: Deps | None = getattr(state, "session_deps", None)
        calls: livekit_client.CallBackend | None = getattr(state, "calls", None)
        if (
            deps is None
            or deps.sessionmaker is not state.sessionmaker
            or (calls is not None and deps.calls is not calls)
        ):
            deps = cls(state.sessionmaker, state.redis, state.settings, cipher_for(state), calls)
            state.session_deps = deps
        return deps


def cipher_for(state: Any) -> MessageCipher:
    cipher: MessageCipher | None = getattr(state, "chat_cipher", None)
    if cipher is None:
        cipher = cipher_from_settings(state.settings)
        state.chat_cipher = cipher
    return cipher


# ---------------------------------------------------------------- views


def client_label(settings: Settings, user_id: uuid.UUID) -> str:
    """Stable, non-reversible label shown to the astrologer instead of phone or name."""
    digest = hmac.new(
        settings.secret_key.get_secret_value().encode(),
        f"client-label:{user_id}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"Client {digest[:4].upper()}"


def iso(v: dt.datetime | None) -> str | None:
    return v.astimezone(dt.UTC).isoformat() if v is not None else None


async def minutes_left(db: AsyncSession, s: ConsultSession) -> int | None:
    """Whole minutes still covered for an open session (user view only)."""
    if s.status not in OPEN_SESSION_STATUSES or s.price_per_min_paise <= 0:
        return None
    affordable = await wallet.minutes_affordable(
        db, s.user_id, s.price_per_min_paise, session_id=s.id
    )
    if s.is_free and s.free_minutes is not None:
        affordable = min(affordable, max(0, s.free_minutes - s.billed_minutes))
    return affordable


async def queue_info(
    db: AsyncSession, deps: Deps, s: ConsultSession, now: dt.datetime
) -> dict[str, Any] | None:
    """Position in the astrologer's queue and an ETA built only from known facts: the prepaid
    time left in the astrologer's current session (busy_until) plus average_session_minutes per
    request ahead. Null ETA when the current session's remaining time is unknown."""
    if s.status != "queued":
        return None
    queued = (
        await db.execute(
            select(ConsultSession.id)
            .where(
                ConsultSession.astrologer_id == s.astrologer_id,
                ConsultSession.status == "queued",
            )
            .order_by(ConsultSession.queued_at, ConsultSession.id)
        )
    ).scalars()
    order = list(queued)
    position = order.index(s.id) + 1 if s.id in order else len(order) + 1
    current = (
        await db.execute(
            select(ConsultSession.status).where(
                ConsultSession.astrologer_id == s.astrologer_id,
                ConsultSession.status.in_(BUSY_STATUSES),
            )
        )
    ).scalars()
    statuses = list(current)
    ahead = position - 1 + statuses.count("requested")
    eta: int | None = rules().average_session_minutes * ahead
    if "accepted" in statuses or "active" in statuses:
        raw = await deps.redis.get(busy_until_key(s.astrologer_id))
        try:
            until = float(raw.decode() if isinstance(raw, bytes) else raw) if raw else None
        except ValueError:
            until = None
        if until is None:
            eta = None
        else:
            remaining = max(0, math.ceil((until - now.timestamp()) / 60))
            eta = (eta or 0) + remaining
    return {"position": position, "eta_minutes": eta}


async def view(
    db: AsyncSession,
    deps: Deps,
    s: ConsultSession,
    role: str,
    *,
    astrologer: Astrologer | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """`SessionView` (packages/shared/src/chat.ts), JSON-ready."""
    now = now or utcnow()
    a = astrologer or await db.get(Astrologer, s.astrologer_id)
    assert a is not None
    can_review = False
    if role == "user" and s.status == "completed":
        reviewed = (
            await db.execute(select(Review.id).where(Review.session_id == s.id))
        ).scalar_one_or_none()
        can_review = reviewed is None
    return {
        "id": str(s.id),
        "kind": s.kind,
        "status": s.status,
        "end_reason": s.end_reason,
        "role": role,
        "astrologer": {"id": str(a.id), "slug": a.slug, "display_name": a.display_name},
        "client_label": client_label(deps.settings, s.user_id),
        "price_per_min_paise": s.price_per_min_paise,
        "is_free": s.is_free,
        "free_minutes": s.free_minutes,
        "queue": await queue_info(db, deps, s, now),
        "created_at": iso(s.created_at),
        "accepted_at": iso(s.accepted_at),
        "started_at": iso(s.started_at),
        "ended_at": iso(s.ended_at),
        "billed_minutes": s.billed_minutes,
        "billed_paise": s.billed_paise,
        "minutes_left": await minutes_left(db, s) if role == "user" else None,
        "can_review": can_review,
    }


async def publish_state(
    db: AsyncSession, deps: Deps, s: ConsultSession, kind: str = "state"
) -> None:
    """Send each side its own view (`state`, or `ended` which closes the sockets)."""
    for role in ROLES:
        event = {"type": kind, "session": await view(db, deps, s, role)}
        await chat_bus.publish_event(deps.redis, s.id, event, to=role)


# ---------------------------------------------------------------- messages


def message_view(m: ChatMessage, text: str) -> dict[str, Any]:
    return {
        "id": str(m.id),
        "seq": m.seq,
        "sender": m.sender,
        "text": text,
        "sent_at": iso(m.created_at),
        "client_id": m.client_id,
    }


def decrypt(deps: Deps, m: ChatMessage) -> str:
    return deps.cipher.decrypt(Sealed(m.ciphertext, m.nonce, m.key_id), aad(m.session_id, m.seq))


async def add_system_message(
    db: AsyncSession, deps: Deps, s: ConsultSession, code: str, at: dt.datetime
) -> ChatMessage:
    """System messages carry codes only (no personal data). Caller holds the row lock."""
    s.last_seq += 1
    sealed = deps.cipher.encrypt(code, aad(s.id, s.last_seq))
    m = ChatMessage(
        session_id=s.id,
        seq=s.last_seq,
        sender="system",
        ciphertext=sealed.ciphertext,
        nonce=sealed.nonce,
        key_id=sealed.key_id,
        created_at=at,
    )
    db.add(m)
    return m


class NotActive(Exception):
    pass


async def post_message(
    deps: Deps, session_id: uuid.UUID, sender: str, client_id: str, text: str
) -> tuple[dict[str, Any], bool]:
    """Store one chat message (encrypted) and return (ChatMessage view, created). A repeated
    client_id from the same sender returns the stored message with created=False."""
    async with deps.sessionmaker() as db:
        existing = await _by_client_id(db, session_id, sender, client_id)
        if existing is not None:
            return message_view(existing, decrypt(deps, existing)), False
        seq = (
            await db.execute(
                update(ConsultSession)
                .where(ConsultSession.id == session_id, ConsultSession.status == "active")
                .values(last_seq=ConsultSession.last_seq + 1)
                .returning(ConsultSession.last_seq)
            )
        ).scalar_one_or_none()
        if seq is None:
            raise NotActive
        sealed = deps.cipher.encrypt(text, aad(session_id, seq))
        m = ChatMessage(
            session_id=session_id,
            seq=seq,
            sender=sender,
            ciphertext=sealed.ciphertext,
            nonce=sealed.nonce,
            key_id=sealed.key_id,
            client_id=client_id,
        )
        db.add(m)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            existing = await _by_client_id(db, session_id, sender, client_id)
            if existing is None:
                raise
            return message_view(existing, decrypt(deps, existing)), False
        await db.refresh(m)
        return message_view(m, text), True


async def _by_client_id(
    db: AsyncSession, session_id: uuid.UUID, sender: str, client_id: str
) -> ChatMessage | None:
    return (
        await db.execute(
            select(ChatMessage).where(
                ChatMessage.session_id == session_id,
                ChatMessage.sender == sender,
                ChatMessage.client_id == client_id,
            )
        )
    ).scalar_one_or_none()


async def history(
    db: AsyncSession, deps: Deps, session_id: uuid.UUID, after_seq: int, limit: int
) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_id == session_id, ChatMessage.seq > after_seq)
            .order_by(ChatMessage.seq)
            .limit(limit)
        )
    ).scalars()
    return [message_view(m, decrypt(deps, m)) for m in rows]


# ---------------------------------------------------------------- presence


async def set_busy(redis: Redis, astrologer_id: uuid.UUID, until: dt.datetime) -> None:
    """presence = busy while a session is accepted/active; busy_until = end of the minutes the
    client's wallet covers (never estimated)."""
    ttl = max(120, math.ceil((until - utcnow()).total_seconds()) + 300)
    await redis.set(presence_key(astrologer_id), "busy", ex=ttl)
    await redis.set(busy_until_key(astrologer_id), f"{until.timestamp():.3f}", ex=ttl)


_CLEAR_BUSY = """
if redis.call('GET', KEYS[1]) == 'busy' then redis.call('DEL', KEYS[1]) end
return redis.call('DEL', KEYS[2])
"""


async def clear_busy(redis: Redis, astrologer_id: uuid.UUID) -> None:
    """Drop busy; the console's next presence heartbeat (applicant.set_presence) sets online
    again if the astrologer is still there. Online/offline set by the astrologer is untouched."""
    await redis.eval(_CLEAR_BUSY, 2, presence_key(astrologer_id), busy_until_key(astrologer_id))


async def refresh_busy(db: AsyncSession, deps: Deps, s: ConsultSession, now: dt.datetime) -> None:
    left = await minutes_left(db, s) or 0
    if s.status == "active" and s.started_at is not None:
        base = s.started_at + deps.minute * s.billed_minutes
    else:
        base = now
    await set_busy(deps.redis, s.astrologer_id, max(base, now) + deps.minute * left)


# ---------------------------------------------------------------- transitions


async def lock(
    db: AsyncSession, session_id: uuid.UUID, *, skip_locked: bool = False
) -> ConsultSession | None:
    return (
        await db.execute(
            select(ConsultSession)
            .where(ConsultSession.id == session_id)
            .with_for_update(skip_locked=skip_locked)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def finish(
    db: AsyncSession,
    deps: Deps,
    s: ConsultSession,
    status: str,
    reason: str,
    at: dt.datetime,
    actor: str = "system",
) -> None:
    """End a session inside the caller's transaction (row locked). Caller commits, then calls
    after_end()."""
    assert status in ENDED_SESSION_STATUSES
    s.status = status
    s.end_reason = reason
    s.ended_at = at
    # The rest of a session-restricted promo lot (first free session) expires with it.
    await wallet.close_session_lots(db, session_id=s.id)
    await add_system_message(db, deps, s, f"session_ended:{reason}", at)
    audit(
        db,
        actor,
        "session.end",
        "consult_session",
        str(s.id),
        status=status,
        reason=reason,
        billed_minutes=s.billed_minutes,
        billed_paise=s.billed_paise,
    )


async def after_end(deps: Deps, session_id: uuid.UUID, now: dt.datetime | None = None) -> None:
    """Post-commit steps of an end. Idempotent; the meter re-runs it until settled_at is set."""
    now = now or utcnow()
    async with deps.sessionmaker() as db:
        s = await db.get(ConsultSession, session_id)
        if s is None or s.status not in ENDED_SESSION_STATUSES or s.settled_at is not None:
            return
        still_busy = (
            await db.execute(
                select(func.count())
                .select_from(ConsultSession)
                .where(
                    ConsultSession.astrologer_id == s.astrologer_id,
                    ConsultSession.status.in_(("accepted", "active")),
                )
            )
        ).scalar_one()
        if not still_busy:
            await clear_busy(deps.redis, s.astrologer_id)
        await publish_state(db, deps, s, "ended")
    # No room can exist before accept (call tokens are only issued from `accepted`).
    room_closed = s.kind != "call" or s.accepted_at is None or await close_room(deps, s.id)
    await promote(deps, s.astrologer_id, now)

    facts = refunds.SessionFacts(
        session_id=s.id,
        user_id=s.user_id,
        astrologer_id=s.astrologer_id,
        status=s.status,
        end_reason=s.end_reason,
        accepted_at=s.accepted_at,
        started_at=s.started_at,
        ended_at=s.ended_at,
        billed_minutes=s.billed_minutes,
        price_per_min_paise=s.price_per_min_paise,
        commission_bps=s.commission_bps,
        is_free=s.is_free,
        astrologer_last_seen_at=s.astrologer_last_seen_at,
    )
    async with deps.sessionmaker() as db:
        try:
            await refunds.on_session_end(
                db, facts, minute_seconds=deps.settings.billing_minute_seconds
            )
            row = await lock(db, session_id)
            if row is not None and row.settled_at is None and room_closed:
                row.settled_at = now
            await db.commit()
        except Exception:
            # Retried by the meter's sweep; the id is not personal data.
            log.exception("session settle failed", extra={"session_id": str(session_id)})
            await db.rollback()


async def close_room(deps: Deps, session_id: uuid.UUID) -> bool:
    """Delete the call's LiveKit room, which disconnects both sides at once. Best effort: never
    raises and never delays the end by more than the LiveKit timeout; False means "try again"
    (after_end then leaves settled_at empty so the meter's sweep retries)."""
    try:
        room = livekit_client.room_name(session_id)
        await asyncio.wait_for(
            deps.call_backend().delete_room(room), livekit_client.LIVEKIT_TIMEOUT_S + 1
        )
    except Exception as exc:
        log.warning(
            "call room delete failed",
            extra={"session_id": str(session_id), "error": type(exc).__name__},
        )
        return False
    return True


async def call_participant(
    deps: Deps,
    session_id: uuid.UUID,
    role: str,
    *,
    joined: bool,
    participant_sid: str,
    at: dt.datetime,
) -> bool:
    """Record that `role` joined or left the call's LiveKit room at `at` (from a webhook, or
    from the meter's room listing with an empty participant sid); tell both sockets; activate
    when ready. False when it changed nothing (duplicate, out of order, replaced connection)."""
    changed = await chat_bus.call_mark(
        deps.redis,
        session_id,
        role,
        joined=joined,
        participant_sid=participant_sid,
        at=at,
        grace_s=rules().heartbeat_grace_s,
    )
    if not changed:
        return False
    state = await chat_bus.call_state(deps.redis, session_id)
    await chat_bus.publish_event(
        deps.redis, session_id, {"type": "call", "joined": chat_bus.joined_view(state)}
    )
    ready = joined and all(side.joined for side in state.values())
    if ready and await chat_bus.both_connected(deps.redis, session_id):
        await activate(deps, session_id)
    return True


async def call_ready(deps: Deps, s: ConsultSession) -> bool:
    """A call becomes active only once both participants are in the LiveKit room too."""
    return s.kind != "call" or await chat_bus.both_joined(deps.redis, s.id)


async def promote(deps: Deps, astrologer_id: uuid.UUID, now: dt.datetime) -> uuid.UUID | None:
    """Move the head of the astrologer's queue to `requested` once they are free."""
    async with deps.sessionmaker() as db:
        # Same lock as create(), so a new request and a promotion never both win.
        await db.execute(
            select(Astrologer.id).where(Astrologer.id == astrologer_id).with_for_update()
        )
        busy = (
            await db.execute(
                select(func.count())
                .select_from(ConsultSession)
                .where(
                    ConsultSession.astrologer_id == astrologer_id,
                    ConsultSession.status.in_(BUSY_STATUSES),
                )
            )
        ).scalar_one()
        if busy:
            return None
        head = (
            await db.execute(
                select(ConsultSession)
                .where(
                    ConsultSession.astrologer_id == astrologer_id,
                    ConsultSession.status == "queued",
                )
                .order_by(ConsultSession.queued_at, ConsultSession.id)
                .limit(1)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if head is None:
            return None
        head.status = "requested"
        head.requested_at = now
        head_id = head.id
        await db.commit()
        await publish_state(db, deps, head)
        # Everyone behind moved up one place.
        rest = (
            await db.execute(
                select(ConsultSession).where(
                    ConsultSession.astrologer_id == astrologer_id,
                    ConsultSession.status == "queued",
                )
            )
        ).scalars()
        for other in rest:
            await publish_state(db, deps, other)
        return head_id


async def activate(deps: Deps, session_id: uuid.UUID, now: dt.datetime | None = None) -> bool:
    """accepted → active once both sockets are connected (and, for a call, both participants
    are in the LiveKit room): minute 1 is charged first. If the wallet no longer covers it, the
    session is cancelled (insufficient_funds)."""
    now = now or utcnow()
    ended = False
    async with deps.sessionmaker() as db:
        s = await lock(db, session_id)
        if s is None or s.status != "accepted" or not await call_ready(deps, s):
            return False
        try:
            charge = await wallet.charge_minute(
                db,
                session_id=s.id,
                user_id=s.user_id,
                astrologer_id=s.astrologer_id,
                minute=1,
                price_paise=s.price_per_min_paise,
                commission_bps=s.commission_bps,
            )
        except wallet.InsufficientFunds:
            await finish(db, deps, s, "cancelled", "insufficient_funds", now)
            ended = True
        else:
            s.status = "active"
            s.started_at = now
            s.billed_minutes = 1
            s.billed_paise = charge.promo_paise + charge.real_paise
            s.user_last_seen_at = s.astrologer_last_seen_at = now
            await add_system_message(db, deps, s, "session_started", now)
            audit(db, "system", "session.start", "consult_session", str(s.id))
        await db.commit()
        if not ended:
            await chat_bus.clear_gaps(deps.redis, s.id)
            await refresh_busy(db, deps, s, now)
            await publish_state(db, deps, s)
    if ended:
        await after_end(deps, session_id, now)
    return not ended
