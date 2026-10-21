"""Server-side per-minute metering and session timeouts (ADR-0002 §5, ADR-0007).

A loop in every API process calls `tick()` every `meter_tick_seconds`. Nothing in memory matters
for correctness: everything a tick decides comes from Postgres (status, started_at, the highest
posted minute = billed_minutes) and Redis heartbeats, and every change happens under a row lock
taken with `FOR UPDATE SKIP LOCKED`, so several processes (or a restarted one) never act on the
same session at once. The ledger key `session:{id}:minute:{n}` makes a double charge impossible
even if they did.

Each tick:
1. requested past request_timeout_s → cancelled (request_timeout);
   accepted past join_timeout_s → failed (join_timeout);
   accepted with both sockets connected → active (fallback for a cross-process race).
2. active sessions: if a side has not been seen for heartbeat_grace_s (or was gone for longer
   than that and came back, e.g. after an API outage), end at its last-seen time
   (`user_dropped`/`astrologer_dropped`) without charging anything that started later.
   Otherwise charge every minute that is due (minute n+1 at started_at + n * minute): free
   sessions stop at free_minutes (`free_minutes_used`), an empty wallet ends at the boundary
   (`insufficient_funds`), and `low_balance` is sent when exactly one more minute is covered.
3. ended sessions whose after-end steps did not finish (crash) are settled again.
4. astrologers who are free with a non-empty queue get the head promoted.

The background loop is skipped when meter_tick_seconds <= 0, and in APP_ENV=test unless
`app.state.meter_enabled` is set before startup: tests drive `tick(app_or_deps, now=...)`.
"""

import asyncio
import contextlib
import datetime as dt
import logging
import uuid
from dataclasses import dataclass, field

from fastapi import FastAPI
from sqlalchemy import ColumnElement, func, select

from astro_api import chat_bus, wallet
from astro_api import session_service as svc
from astro_api.models import ConsultSession

log = logging.getLogger("astro_api.meter")

SETTLE_RETRY_AFTER_S = 30
SETTLE_LOOKBACK = dt.timedelta(days=2)


@dataclass
class TickReport:
    charged: list[tuple[uuid.UUID, int]] = field(default_factory=list)
    ended: list[tuple[uuid.UUID, str]] = field(default_factory=list)
    activated: list[uuid.UUID] = field(default_factory=list)
    promoted: list[uuid.UUID] = field(default_factory=list)


async def tick(target: "FastAPI | svc.Deps", now: dt.datetime | None = None) -> TickReport:
    deps = svc.Deps.of(target)
    now = now or svc.utcnow()
    report = TickReport()
    await _timeouts(deps, now, report)
    await _activate_ready(deps, now, report)
    await _meter_active(deps, now, report)
    await _settle(deps, now)
    await _promote_free(deps, now, report)
    return report


# ---------------------------------------------------------------- timeouts and activation


async def _ids(deps: svc.Deps, *where: ColumnElement[bool]) -> list[uuid.UUID]:
    async with deps.sessionmaker() as db:
        return list((await db.execute(select(ConsultSession.id).where(*where))).scalars())


async def _timeouts(deps: svc.Deps, now: dt.datetime, report: TickReport) -> None:
    r = svc.rules()
    request_cutoff = now - dt.timedelta(seconds=r.request_timeout_s)
    join_cutoff = now - dt.timedelta(seconds=r.join_timeout_s)
    requested_since = func.coalesce(ConsultSession.requested_at, ConsultSession.created_at)
    checks = (
        (
            "requested",
            requested_since < request_cutoff,
            "cancelled",
            "request_timeout",
        ),
        ("accepted", ConsultSession.accepted_at < join_cutoff, "failed", "join_timeout"),
    )
    for status, condition, new_status, reason in checks:
        for sid in await _ids(deps, ConsultSession.status == status, condition):
            async with deps.sessionmaker() as db:
                s = await svc.lock(db, sid, skip_locked=True)
                if s is None or s.status != status:
                    continue
                since = s.requested_at or s.created_at if status == "requested" else s.accepted_at
                cutoff = request_cutoff if status == "requested" else join_cutoff
                if since is None or since >= cutoff:
                    continue
                await svc.finish(db, deps, s, new_status, reason, now)
                await db.commit()
            report.ended.append((sid, reason))
            await svc.after_end(deps, sid, now)


async def _activate_ready(deps: svc.Deps, now: dt.datetime, report: TickReport) -> None:
    for sid in await _ids(deps, ConsultSession.status == "accepted"):
        if await chat_bus.both_connected(deps.redis, sid) and await svc.activate(deps, sid, now):
            report.activated.append(sid)


# ---------------------------------------------------------------- metering


@dataclass(frozen=True)
class Drop:
    role: str
    at: dt.datetime


async def _drop(deps: svc.Deps, s: ConsultSession, now: dt.datetime) -> Drop | None:
    """The earliest side gone for longer than the grace period, with its last-seen time. Also
    copies the heartbeats into the row (they survive a Redis loss and feed the refund rules)."""
    assert s.started_at is not None
    grace = dt.timedelta(seconds=svc.rules().heartbeat_grace_s)
    seen = await chat_bus.last_seen(deps.redis, s.id)
    drops: list[Drop] = []
    for role in svc.ROLES:
        redis_seen, gap = seen[role]
        stored: dt.datetime | None = getattr(s, f"{role}_last_seen_at")
        candidates = [t for t in (redis_seen, stored) if t is not None]
        last = min(max(candidates), now) if candidates else s.started_at
        if gap is not None and gap >= s.started_at:
            # Silent for longer than the grace period at some point, even if back now.
            drops.append(Drop(role, gap))
            last = min(last, gap)
        elif now - last > grace:
            drops.append(Drop(role, max(last, s.started_at)))
        if stored is None or last > stored or (gap is not None and gap >= s.started_at):
            setattr(s, f"{role}_last_seen_at", last)
    return min(drops, key=lambda d: d.at) if drops else None


async def _meter_active(deps: svc.Deps, now: dt.datetime, report: TickReport) -> None:
    for sid in await _ids(deps, ConsultSession.status == "active"):
        await _meter_one(deps, sid, now, report)


async def _meter_one(deps: svc.Deps, sid: uuid.UUID, now: dt.datetime, report: TickReport) -> None:
    minute = deps.minute
    low_balance: int | None = None
    ended = False
    async with deps.sessionmaker() as db:
        s = await svc.lock(db, sid, skip_locked=True)
        if s is None or s.status != "active" or s.started_at is None:
            return  # another process holds it, or it changed meanwhile
        drop = await _drop(deps, s, now)
        # Minutes starting before the cut-off are owed; with nobody gone that is "now".
        horizon = drop.at if drop else now
        charged_any = False
        while not ended:
            boundary = s.started_at + minute * s.billed_minutes  # start of the next minute
            due = boundary < horizon if drop else boundary <= horizon
            if not due:
                break
            n = s.billed_minutes + 1
            if s.is_free and s.free_minutes is not None and n > s.free_minutes:
                await svc.finish(db, deps, s, "completed", "free_minutes_used", boundary)
                report.ended.append((sid, "free_minutes_used"))
                ended = True
                break
            try:
                charge = await wallet.charge_minute(
                    db,
                    session_id=s.id,
                    user_id=s.user_id,
                    astrologer_id=s.astrologer_id,
                    minute=n,
                    price_paise=s.price_per_min_paise,
                    commission_bps=s.commission_bps,
                )
            except wallet.InsufficientFunds:
                await svc.finish(db, deps, s, "completed", "insufficient_funds", boundary)
                report.ended.append((sid, "insufficient_funds"))
                ended = True
                break
            s.billed_minutes = n
            s.billed_paise += charge.promo_paise + charge.real_paise
            report.charged.append((sid, n))
            charged_any = True
        if drop is not None and not ended:
            reason = f"{drop.role}_dropped"
            await svc.finish(db, deps, s, "completed", reason, drop.at)
            report.ended.append((sid, reason))
            ended = True
        if charged_any and not ended:
            left = await svc.minutes_left(db, s)
            if left is not None and left == svc.rules().low_balance_warning_minutes:
                low_balance = left
                await svc.add_system_message(db, deps, s, "low_balance", now)
        await db.commit()
        if charged_any and not ended:
            await svc.refresh_busy(db, deps, s, now)
            if low_balance is not None:
                event = {"type": "low_balance", "minutes_left": low_balance}
                await chat_bus.publish_event(deps.redis, sid, event, to="both")
            await svc.publish_state(db, deps, s)
    if ended:
        await svc.after_end(deps, sid, now)


# ---------------------------------------------------------------- settle and promote


async def _settle(deps: svc.Deps, now: dt.datetime) -> None:
    stale = now - dt.timedelta(seconds=SETTLE_RETRY_AFTER_S)
    for sid in await _ids(
        deps,
        ConsultSession.status.in_(("completed", "cancelled", "failed")),
        ConsultSession.settled_at.is_(None),
        ConsultSession.ended_at < stale,
        ConsultSession.ended_at > now - SETTLE_LOOKBACK,
    ):
        await svc.after_end(deps, sid, now)


async def _promote_free(deps: svc.Deps, now: dt.datetime, report: TickReport) -> None:
    async with deps.sessionmaker() as db:
        waiting = list(
            (
                await db.execute(
                    select(ConsultSession.astrologer_id)
                    .where(ConsultSession.status == "queued")
                    .distinct()
                )
            ).scalars()
        )
    for astrologer_id in waiting:
        promoted = await svc.promote(deps, astrologer_id, now)
        if promoted is not None:
            report.promoted.append(promoted)


# ---------------------------------------------------------------- background loop


async def _loop(app: FastAPI, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            await tick(app)
        except Exception:
            log.exception("meter tick failed")


async def start(app: FastAPI) -> None:
    """Start the background meter task (see module docstring for when it is skipped)."""
    settings = app.state.settings
    if settings.meter_tick_seconds <= 0:
        return
    if settings.app_env == "test" and not getattr(app.state, "meter_enabled", False):
        return
    app.state.meter_task = asyncio.create_task(_loop(app, settings.meter_tick_seconds))


async def stop(app: FastAPI) -> None:
    """Stop the background meter task."""
    task: asyncio.Task[None] | None = getattr(app.state, "meter_task", None)
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    app.state.meter_task = None
