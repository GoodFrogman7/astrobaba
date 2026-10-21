"""First free session eligibility and abuse heuristics. Owned by the wallet work; the session
work calls `check` before creating a free session and `claim` in the same transaction.

Rules (billing.json `free_session`), in order:
1. flag `first_free_session` off → flag_off
2. admin override `block` → blocked
3. the user already claimed one (ever, unless an admin reset it) → already_used
4. admin override `allow` → eligible (heuristics skipped)
5. this device already gave `max_users_per_device` users a free session → device_used
6. this IP gave `max_free_sessions_per_ip_per_day` free sessions today (IST) → ip_limit
7. abuse score >= `score_threshold` → abuse_score. One point each for: the device is signed in on
   another account (`device_shared`), the IP already had a free session today (`ip_seen_today`),
   no device id (`no_device`; "unknown" counts as none).

Devices and IPs are stored only as HMAC-SHA256 keyed with SECRET_KEY; never raw.
"""

import datetime as dt
import hashlib
import hmac
import uuid
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from redis.asyncio import Redis
from sqlalchemy import any_, delete, func, literal, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config
from astro_api.audit import audit
from astro_api.config import get_settings
from astro_api.flags import flag_enabled
from astro_api.models import User
from astro_api.models_ledger import FreeSessionClaim, FreeSessionOverride

IST = ZoneInfo("Asia/Kolkata")
ACTIONS = ("allow", "block", "reset")


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    minutes: int
    reason: str | None  # flag_off | already_used | device_used | ip_limit | blocked | abuse_score


class FreeSessionUnavailable(Exception):
    """Raised by `claim` when the user is not (or no longer) eligible. Nothing was written."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class _Evaluation:
    eligibility: Eligibility
    score: int
    signals: list[str]


def _hmac(kind: str, value: str) -> str:
    key = get_settings().secret_key.get_secret_value().encode()
    return hmac.new(key, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()


def device_hash(device_id: str) -> str:
    return _hmac("free_session_device", device_id)


def ip_hash(client_ip: str) -> str:
    return _hmac("free_session_ip", client_ip)


def ist_day(now: dt.datetime | None = None) -> dt.date:
    return (now or dt.datetime.now(dt.UTC)).astimezone(IST).date()


def _lock_key(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], "big", signed=True)


def _device(device_id: str) -> str:
    """Normalise: a missing device id ("" or "unknown") is not one shared device."""
    value = (device_id or "").strip()
    return "" if value.lower() == "unknown" else value


async def _evaluate(
    db: AsyncSession, *, user_id: uuid.UUID, device_id: str, client_ip: str
) -> _Evaluation:
    device_id = _device(device_id)
    cfg = billing_config.free_session()
    minutes = int(cfg["minutes"])

    def no(reason: str, score: int = 0, signals: list[str] | None = None) -> _Evaluation:
        return _Evaluation(Eligibility(False, minutes, reason), score, signals or [])

    if not flag_enabled(str(cfg["flag"])):
        return no("flag_off")
    override = await db.get(FreeSessionOverride, user_id)
    if override is not None and override.action == "block":
        return no("blocked")
    claimed = (
        await db.execute(select(FreeSessionClaim.id).where(FreeSessionClaim.user_id == user_id))
    ).scalar_one_or_none()
    if claimed is not None:
        return no("already_used")

    abuse = cfg["abuse"]
    dh, ih = device_hash(device_id), ip_hash(client_ip)
    device_claims = (
        await db.execute(
            select(func.count())
            .select_from(FreeSessionClaim)
            .where(FreeSessionClaim.device_hash == dh)
        )
    ).scalar_one()
    ip_claims = (
        await db.execute(
            select(func.count())
            .select_from(FreeSessionClaim)
            .where(FreeSessionClaim.ip_hash == ih, FreeSessionClaim.ip_day == ist_day())
        )
    ).scalar_one()
    shared = False
    if device_id:
        shared = (
            await db.execute(
                select(func.count())
                .select_from(User)
                .where(User.id != user_id, literal(device_id) == any_(User.device_ids))
            )
        ).scalar_one() > 0
    signals = [
        name
        for name, on in (
            ("device_shared", shared),
            ("ip_seen_today", ip_claims > 0),
            ("no_device", not device_id),
        )
        if on
    ]
    score = len(signals)
    if override is not None and override.action == "allow":
        return _Evaluation(Eligibility(True, minutes, None), score, signals)
    if device_id and device_claims >= int(abuse["max_users_per_device"]):
        return no("device_used", score, signals)
    if ip_claims >= int(abuse["max_free_sessions_per_ip_per_day"]):
        return no("ip_limit", score, signals)
    if score >= int(abuse["score_threshold"]):
        return no("abuse_score", score, signals)
    return _Evaluation(Eligibility(True, minutes, None), score, signals)


async def check(
    db: AsyncSession, redis: Redis, *, user_id: uuid.UUID, device_id: str, client_ip: str
) -> Eligibility:
    return (
        await _evaluate(db, user_id=user_id, device_id=device_id, client_ip=client_ip)
    ).eligibility


async def claim(
    db: AsyncSession,
    redis: Redis,
    *,
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    device_id: str,
    client_ip: str,
) -> None:
    """Record the claim (unique per user) so later checks see it. Caller commits.

    Re-checks eligibility under transaction-scoped advisory locks on the device and IP, so two
    users on one device (or IP) cannot both pass the limits at once. Raises
    FreeSessionUnavailable(reason) when not eligible."""
    dh, ih = device_hash(_device(device_id)), ip_hash(client_ip)
    for lock in (f"free_session:device:{dh}", f"free_session:ip:{ih}"):
        await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _lock_key(lock)})
    ev = await _evaluate(db, user_id=user_id, device_id=device_id, client_ip=client_ip)
    if not ev.eligibility.eligible:
        raise FreeSessionUnavailable(ev.eligibility.reason or "unavailable")
    inserted = (
        await db.execute(
            pg_insert(FreeSessionClaim)
            .values(
                id=uuid.uuid4(),
                user_id=user_id,
                session_id=session_id,
                device_hash=dh,
                ip_hash=ih,
                ip_day=ist_day(),
                abuse_score=ev.score,
                reasons=ev.signals,
            )
            .on_conflict_do_nothing(index_elements=["user_id"])
            .returning(FreeSessionClaim.id)
        )
    ).scalar_one_or_none()
    if inserted is None:
        raise FreeSessionUnavailable("already_used")


async def admin_status(db: AsyncSession, user_id: uuid.UUID) -> Eligibility:
    """Eligibility without device/IP heuristics (for the admin wallet view)."""
    minutes = int(billing_config.free_session()["minutes"])
    if not flag_enabled(str(billing_config.free_session()["flag"])):
        return Eligibility(False, minutes, "flag_off")
    override = await db.get(FreeSessionOverride, user_id)
    if override is not None and override.action == "block":
        return Eligibility(False, minutes, "blocked")
    claimed = (
        await db.execute(select(FreeSessionClaim.id).where(FreeSessionClaim.user_id == user_id))
    ).scalar_one_or_none()
    if claimed is not None:
        return Eligibility(False, minutes, "already_used")
    return Eligibility(True, minutes, None)


async def override(
    db: AsyncSession, *, user_id: uuid.UUID, action: str, note: str | None, actor: str
) -> None:
    """Admin override, audited (ids only; the note stays in the override row).
    allow: skip heuristics; block: refuse; reset: forget the user's claim so they can have
    another free session (and clear allow/block). Caller commits."""
    if action not in ACTIONS:
        raise ValueError(f"unknown action: {action}")
    row = await db.get(FreeSessionOverride, user_id, with_for_update=True)
    if row is None:
        row = FreeSessionOverride(user_id=user_id, resets=0, actor=actor)
        db.add(row)
    detail: dict[str, str] = {"decision": action}
    if action == "reset":
        removed = (
            await db.execute(
                delete(FreeSessionClaim)
                .where(FreeSessionClaim.user_id == user_id)
                .returning(FreeSessionClaim.id, FreeSessionClaim.session_id)
            )
        ).one_or_none()
        if removed is not None:
            detail |= {"claim_id": str(removed[0]), "session_id": str(removed[1])}
        row.action = None
        row.resets = (row.resets or 0) + 1
    else:
        row.action = action
    row.note = note
    row.actor = actor
    row.updated_at = dt.datetime.now(dt.UTC)
    await db.flush()
    audit(db, actor, "free_session.override", "user", str(user_id), **detail)
