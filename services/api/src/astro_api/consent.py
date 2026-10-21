"""Consent records and enforcement (docs/api/trust.md §1, ADR-0011).

- The kinds a user must accept come from data/legal/policies.json (`consents.user` for everyone,
  `consents.astrologer` for astrologer portal writes); a consent counts only at the current
  policies `version`, so a new version asks everyone again.
- Records are append-only (`consents`, a trigger rejects UPDATE/DELETE). IP and device are kept
  only as HMAC-SHA256 keyed with SECRET_KEY.
- `require_consent("user")` / `require_consent("astrologer")` is the FastAPI dependency for
  endpoints that move money or start a consultation, and for astrologer portal writes:
  `403 consent_required` with `missing: [kind]` and the current `version`.
"""

import hashlib
import hmac
import json
import uuid
from collections.abc import Awaitable, Callable, Iterable
from functools import cache
from typing import Any, Literal

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.auth import CurrentUser
from astro_api.config import Settings
from astro_api.db import Db
from astro_api.errors import ApiError
from astro_api.models import Astrologer, User
from astro_api.models_privacy import CONSENT_KINDS, Consent
from astro_api.shared_files import legal_dir

ConsentGroup = Literal["user", "astrologer"]


@cache
def policies() -> dict[str, Any]:
    data: dict[str, Any] = json.loads((legal_dir() / "policies.json").read_text(encoding="utf-8"))
    return data


def current_version() -> str:
    return str(policies()["version"])


def group_kinds(group: ConsentGroup) -> list[str]:
    kinds = [str(k) for k in policies()["consents"][group]]
    unknown = set(kinds) - set(CONSENT_KINDS)
    if unknown:  # policies.json and the table's CHECK must agree
        raise RuntimeError(f"policies.json names unknown consent kinds: {sorted(unknown)}")
    return kinds


def hmac_hex(settings: Settings, purpose: str, value: str) -> str:
    """HMAC-SHA256(SECRET_KEY, "{purpose}:{value}"), hex. Never store the raw value."""
    key = settings.secret_key.get_secret_value().encode()
    return hmac.new(key, f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()


async def is_astrologer(db: AsyncSession, user_id: uuid.UUID) -> bool:
    found = (
        await db.execute(select(Astrologer.id).where(Astrologer.user_id == user_id))
    ).scalar_one_or_none()
    return found is not None


async def required_for(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    """Every kind this account must hold: the user kinds, plus astrologer kinds for astrologers."""
    kinds = group_kinds("user")
    if await is_astrologer(db, user_id):
        kinds += [k for k in group_kinds("astrologer") if k not in kinds]
    return kinds


async def accepted_kinds(db: AsyncSession, user_id: uuid.UUID, version: str) -> set[str]:
    rows = await db.execute(
        select(Consent.kind).where(Consent.user_id == user_id, Consent.version == version)
    )
    return set(rows.scalars())


async def missing_kinds(db: AsyncSession, user_id: uuid.UUID, kinds: Iterable[str]) -> list[str]:
    have = await accepted_kinds(db, user_id, current_version())
    return [k for k in kinds if k not in have]


async def record(
    db: AsyncSession,
    user: User,
    kinds: Iterable[str],
    *,
    version: str,
    ip_hash: str | None,
    device_hash: str | None,
) -> list[str]:
    """Append one row per kind not yet accepted at `version`. Accepting `age_18` confirms the
    user is an adult (`users.is_adult_confirmed`). Returns the kinds newly recorded. Caller
    commits."""
    wanted = list(dict.fromkeys(kinds))
    new: list[str] = []
    for kind in wanted:
        if kind not in CONSENT_KINDS:
            raise ValueError(f"unknown consent kind {kind!r}")
        inserted = (
            await db.execute(
                pg_insert(Consent)
                .values(
                    id=uuid.uuid4(),
                    user_id=user.id,
                    kind=kind,
                    version=version,
                    ip_hash=ip_hash,
                    device_hash=device_hash,
                )
                .on_conflict_do_nothing(constraint="uq_consents_user_kind_version")
                .returning(Consent.id)
            )
        ).scalar_one_or_none()
        if inserted is not None:
            new.append(kind)
    if "age_18" in wanted:
        user.is_adult_confirmed = True
    await db.flush()
    return new


async def state(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    """`ConsentState`: the current version, every kind required for this account's roles
    (astrologers also `astrologer_terms`), the required kinds not accepted at the current
    version (`missing`), the latest acceptance of each kind (any version) and `current`
    (true when nothing is missing)."""
    version = current_version()
    required = await required_for(db, user_id)
    rows = (
        await db.execute(
            select(Consent)
            .where(Consent.user_id == user_id)
            .order_by(Consent.accepted_at.desc(), Consent.kind)
        )
    ).scalars()
    latest: dict[str, Consent] = {}
    for c in rows:
        latest.setdefault(c.kind, c)
    accepted = [
        {"kind": c.kind, "version": c.version, "accepted_at": c.accepted_at.isoformat()}
        for c in sorted(latest.values(), key=lambda c: CONSENT_KINDS.index(c.kind))
    ]
    current = {a["kind"] for a in accepted if a["version"] == version}
    missing = [k for k in required if k not in current]
    return {
        "version": version,
        "required": required,
        "missing": missing,
        "accepted": accepted,
        "current": not missing,
    }


def require_consent(group: ConsentGroup) -> Callable[..., Awaitable[User]]:
    """FastAPI dependency: the signed-in user must hold every `group` kind at the current
    version, else `403 consent_required` with `missing`."""
    kinds = group_kinds(group)

    async def dependency(user: CurrentUser, db: Db) -> User:
        missing = await missing_kinds(db, user.id, kinds)
        if missing:
            raise ApiError(
                403,
                "consent_required",
                "Please review and accept the current terms to continue.",
                missing=missing,
                version=current_version(),
            )
        return user

    return dependency


RequireUserConsent = Depends(require_consent("user"))
RequireAstrologerConsent = Depends(require_consent("astrologer"))
