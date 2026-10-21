"""`seed` and `clean`: synthetic clients and astrologers written straight to the database.

Money goes only through astro_api.wallet (ADR-0002): the credit is a promo lot with campaign
`loadtest` and the deterministic key `loadtest:credit:{user_id}`; on clean, what is left is
forfeited through the ledger's own promo expiry (`promo_lot:{id}:expire`), the same path account
deletion uses. Sign-in tokens are created the way astro_api.auth does (random token, only its
SHA-256 stored) and written to the local state file, never to the repository.
"""

import datetime as dt
import secrets
import uuid
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from astro_api import consent, wallet
from astro_api.auth import hash_token
from astro_api.config import Settings, get_settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.marketplace import busy_until_key, presence_key
from astro_api.models import (
    DEFAULT_FLAGS,
    OPEN_SESSION_STATUSES,
    Astrologer,
    AuthSession,
    ConsultSession,
    User,
)
from astro_api.models_ledger import PromoLot
from astro_api.models_sessions import ChatMessage
from astro_api.taxonomy import taxonomy
from loadtest.common import (
    ASTROLOGER_SLOT,
    CLIENT_SLOT,
    CREDIT_CAMPAIGN,
    PHONE_PREFIX,
    SLUG_PREFIX,
    STATE_FILE,
    Refused,
    ensure_seed_allowed,
    state_dir,
    write_private_json,
)

CREDIT_TTL = dt.timedelta(days=7)  # unused credit lapses on its own even if clean never runs
TOKEN_TTL = dt.timedelta(days=2)
BATCH = 50


def credit_key(user_id: uuid.UUID) -> str:
    return f"loadtest:credit:{user_id}"


async def credit(db: AsyncSession, *, user_id: uuid.UUID, amount_paise: int) -> wallet.Lot:
    """Credit a synthetic client through the ledger (promo lot, campaign `loadtest`).
    Idempotent on `loadtest:credit:{user_id}`. Caller commits."""
    return await wallet.grant_promo(
        db,
        user_id=user_id,
        amount_paise=amount_paise,
        campaign=CREDIT_CAMPAIGN,
        key=credit_key(user_id),
        expires_at=dt.datetime.now(dt.UTC) + CREDIT_TTL,
    )


async def forfeit_credit(db: AsyncSession, user_ids: list[uuid.UUID]) -> int:
    """Expire every open promo lot of these (synthetic) users through the ledger's own expiry.
    Returns paise forfeited. Caller commits."""
    if not user_ids:
        return 0
    lot_ids = list(
        (
            await db.execute(
                select(PromoLot.id)
                .where(PromoLot.user_id.in_(user_ids), PromoLot.remaining_paise > 0)
                .order_by(PromoLot.id)
            )
        ).scalars()
    )
    if not lot_ids:
        return 0
    # Same call account deletion uses (astro_api.privacy._forfeit_promo).
    return await wallet._expire_lots(db, lot_ids, due=None)


@dataclass(frozen=True)
class Pair:
    client_user_id: uuid.UUID
    client_token: str
    astrologer_user_id: uuid.UUID
    astrologer_id: uuid.UUID
    astrologer_token: str

    def as_json(self) -> dict[str, str]:
        return {k: str(v) for k, v in self.__dict__.items()}


def _phone(slot: str, n: int) -> str:
    return f"{PHONE_PREFIX}{slot}{n:06d}"


async def _next_number(db: AsyncSession) -> int:
    phones = (
        await db.execute(
            select(func.max(func.right(User.phone, 6))).where(
                or_(
                    User.phone.like(f"{PHONE_PREFIX}{CLIENT_SLOT}%"),
                    User.phone.like(f"{PHONE_PREFIX}{ASTROLOGER_SLOT}%"),
                )
            )
        )
    ).scalar_one_or_none()
    return int(phones) + 1 if phones else 1


def _session_token(db: AsyncSession, user_id: uuid.UUID, device_id: str, now: dt.datetime) -> str:
    """A bearer token exactly as astro_api.auth.verify_otp makes one."""
    token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            user_id=user_id,
            token_hash=hash_token(token),
            expires_at=now + TOKEN_TTL,
            device_id=device_id,
        )
    )
    return token


async def _accept_consents(
    db: AsyncSession, settings: Settings, user: User, device_id: str, astrologer: bool
) -> None:
    kinds = consent.group_kinds("user")
    if astrologer:
        kinds += consent.group_kinds("astrologer")
    await consent.record(
        db,
        user,
        kinds,
        version=consent.current_version(),
        ip_hash=None,
        device_hash=consent.hmac_hex(settings, "consent_device", device_id),
    )


async def _seed_pair(
    db: AsyncSession, settings: Settings, n: int, price: int, tier: str, credit_paise: int
) -> Pair:
    now = dt.datetime.now(dt.UTC)
    tax = taxonomy()
    client = User(phone=_phone(CLIENT_SLOT, n), device_ids=[], roles=[])
    owner = User(phone=_phone(ASTROLOGER_SLOT, n), device_ids=[], roles=[])
    db.add_all([client, owner])
    await db.flush()
    name = f"Load Test Astrologer {n:06d}"
    a = Astrologer(
        user_id=owner.id,
        display_name=name,
        slug=f"{SLUG_PREFIX}{n:06d}",
        bio=f"[Load test] {name} is synthetic data for a load test, not a real astrologer.",
        bio_hi=None,
        skills=[tax["skills"][0]["id"]],
        languages=[tax["languages"][0]["id"]],
        gender="other",
        tier=tier,
        price_per_min_paise=price,
        requested_price_per_min_paise=price,
        experience_years=1,
        status="approved",
        flags=dict(DEFAULT_FLAGS),
        is_seed=True,
        accepts_terms_at=now,
        approved_at=now,
    )
    db.add(a)
    await db.flush()
    client_device, owner_device = f"loadtest-c{n:06d}", f"loadtest-a{n:06d}"
    await _accept_consents(db, settings, client, client_device, astrologer=False)
    await _accept_consents(db, settings, owner, owner_device, astrologer=True)
    await credit(db, user_id=client.id, amount_paise=credit_paise)
    return Pair(
        client_user_id=client.id,
        client_token=_session_token(db, client.id, client_device, now),
        astrologer_user_id=owner.id,
        astrologer_id=a.id,
        astrologer_token=_session_token(db, owner.id, owner_device, now),
    )


async def seed(
    sessionmaker: async_sessionmaker[AsyncSession],
    settings: Settings,
    count: int,
    credit_minutes: int,
) -> dict[str, Any]:
    ensure_seed_allowed(settings.app_env)
    if count < 1:
        raise ValueError("count must be at least 1")
    tier = taxonomy()["tiers"][0]
    price = int(tier["min_price_per_min_paise"])
    credit_paise = price * credit_minutes
    pairs: list[Pair] = []
    async with sessionmaker() as db:
        start = await _next_number(db)
    for offset in range(0, count, BATCH):
        async with sessionmaker() as db:
            for n in range(start + offset, start + min(offset + BATCH, count)):
                pairs.append(
                    await _seed_pair(db, settings, n, price, str(tier["id"]), credit_paise)
                )
            await db.commit()
    state = {
        "created_at": dt.datetime.now(dt.UTC).isoformat(),
        "app_env": settings.app_env,
        "price_per_min_paise": price,
        "credit_paise": credit_paise,
        "pairs": [p.as_json() for p in pairs],
    }
    path = state_dir() / STATE_FILE
    write_private_json(path, state)
    return {
        "pairs": len(pairs),
        "numbers": [start, start + count - 1],
        "price_per_min_paise": price,
        "credit_paise_each": credit_paise,
        "state_file": str(path),
    }


async def clean(
    sessionmaker: async_sessionmaker[AsyncSession], redis: Redis, settings: Settings
) -> dict[str, Any]:
    """Remove what may be removed; keep what must stay (see README "What clean keeps")."""
    ensure_seed_allowed(settings.app_env)
    async with sessionmaker() as db:
        user_ids = list(
            (await db.execute(select(User.id).where(User.phone.like(f"{PHONE_PREFIX}%")))).scalars()
        )
        astrologer_ids = list(
            (
                await db.execute(
                    select(Astrologer.id).where(
                        Astrologer.user_id.in_(user_ids),
                        Astrologer.is_seed.is_(True),
                        Astrologer.slug.like(f"{SLUG_PREFIX}%"),
                    )
                )
            ).scalars()
        )
        mine = or_(
            ConsultSession.user_id.in_(user_ids), ConsultSession.astrologer_id.in_(astrologer_ids)
        )
        still_open = (
            await db.execute(
                select(func.count())
                .select_from(ConsultSession)
                .where(mine, ConsultSession.status.in_(OPEN_SESSION_STATUSES))
            )
        ).scalar_one()
        if still_open:
            raise Refused(
                f"{still_open} load-test sessions are still open; the API ends them (meter, "
                "heartbeat grace / request and join timeouts). Run clean again afterwards."
            )
        sessions = select(ConsultSession.id).where(mine)
        messages = await db.execute(delete(ChatMessage).where(ChatMessage.session_id.in_(sessions)))
        tokens = await db.execute(delete(AuthSession).where(AuthSession.user_id.in_(user_ids)))
        hidden = await db.execute(
            update(Astrologer)
            .where(Astrologer.id.in_(astrologer_ids))
            .values(flags={**DEFAULT_FLAGS, "chat_enabled": False, "show_in_directory": False})
        )
        forfeited = await forfeit_credit(db, user_ids)
        await db.commit()
    if astrologer_ids:
        await redis.delete(
            *[presence_key(a) for a in astrologer_ids], *[busy_until_key(a) for a in astrologer_ids]
        )
    state = state_dir() / STATE_FILE
    state.unlink(missing_ok=True)
    return {
        "removed": {
            "chat_messages": messages.rowcount,  # type: ignore[attr-defined]
            "auth_sessions": tokens.rowcount,  # type: ignore[attr-defined]
            "presence_keys_for_astrologers": len(astrologer_ids),
            "state_file": str(state),
        },
        "hidden_astrologers": hidden.rowcount,  # type: ignore[attr-defined]
        "forfeited_credit_paise": forfeited,
        "kept": {
            "users": len(user_ids),
            "reason": (
                "ledger rows are append-only and reference the users; consents are append-only; "
                "consultation rows keep the money facts the ledger points to"
            ),
        },
    }


async def run_seed(count: int, credit_minutes: int) -> dict[str, Any]:
    settings = get_settings()
    ensure_seed_allowed(settings.app_env)
    engine = make_engine(settings.database_url.get_secret_value())
    try:
        return await seed(make_sessionmaker(engine), settings, count, credit_minutes)
    finally:
        await engine.dispose()


async def run_clean() -> dict[str, Any]:
    settings = get_settings()
    ensure_seed_allowed(settings.app_env)
    engine = make_engine(settings.database_url.get_secret_value())
    redis = Redis.from_url(settings.redis_url.get_secret_value())
    try:
        return await clean(make_sessionmaker(engine), redis, settings)
    finally:
        await redis.aclose()
        await engine.dispose()
