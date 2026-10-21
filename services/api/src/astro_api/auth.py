"""Phone OTP sign-in and bearer sessions. Tokens are random and stored only as SHA-256."""

import datetime as dt
import hashlib
import secrets
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from astro_api.config import Settings
from astro_api.db import Db, settings_of
from astro_api.errors import ApiError
from astro_api.models import Astrologer, AuthSession, User
from astro_api.otp import OtpService
from astro_api.phone import mask_phone, normalize_phone

router = APIRouter(prefix="/v1", tags=["auth"])

DEVICE_ID = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_\-:.]+$")


class OtpRequest(BaseModel):
    phone: str = Field(min_length=10, max_length=20)
    device_id: str = DEVICE_ID


class OtpRequested(BaseModel):
    challenge_id: str
    expires_in: int
    resend_after: int


class OtpVerify(BaseModel):
    challenge_id: str = Field(min_length=8, max_length=64)
    code: str = Field(pattern=r"^\s*\d{6}\s*$")
    device_id: str = DEVICE_ID


class SessionUser(BaseModel):
    id: uuid.UUID
    is_new: bool


class SessionOut(BaseModel):
    token: str
    expires_at: dt.datetime
    user: SessionUser


class MeAstrologer(BaseModel):
    id: uuid.UUID
    status: str
    slug: str


class MeOut(BaseModel):
    id: uuid.UUID
    phone: str  # masked
    locale: str
    is_adult_confirmed: bool
    created_at: dt.datetime
    roles: list[str]
    astrologer: MeAstrologer | None


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def client_ip(request: Request, settings: Settings) -> str:
    if settings.client_ip_header:
        forwarded = request.headers.get(settings.client_ip_header, "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def _otp(request: Request) -> OtpService:
    service: OtpService = request.app.state.otp
    return service


@router.post("/auth/otp/request", status_code=202, response_model=OtpRequested)
async def request_otp(body: OtpRequest, request: Request) -> OtpRequested:
    phone = normalize_phone(body.phone)
    challenge = await _otp(request).request(
        phone, body.device_id, client_ip(request, settings_of(request))
    )
    return OtpRequested(**challenge.__dict__)


@router.post("/auth/otp/verify", response_model=SessionOut)
async def verify_otp(body: OtpVerify, request: Request, db: Db) -> SessionOut:
    phone = await _otp(request).verify(body.challenge_id, body.code)
    now = dt.datetime.now(dt.UTC)
    user = (await db.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
    is_new = user is None
    if user is None:
        user = User(phone=phone, device_ids=[])
        db.add(user)
    user.last_login_at = now
    if body.device_id not in user.device_ids:
        user.device_ids = [*user.device_ids, body.device_id][-10:]
    await db.flush()

    token = secrets.token_urlsafe(32)
    expires = now + dt.timedelta(days=settings_of(request).session_days)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=expires,
            device_id=body.device_id,
        )
    )
    await db.commit()
    return SessionOut(token=token, expires_at=expires, user=SessionUser(id=user.id, is_new=is_new))


async def current_session(
    db: Db, authorization: Annotated[str | None, Header()] = None
) -> tuple[AuthSession, User]:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "unauthenticated", "Sign in to continue.")
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(AuthSession.token_hash == hash_token(token.strip()))
        )
    ).one_or_none()
    now = dt.datetime.now(dt.UTC)
    if row is None or row[0].revoked_at is not None or row[0].expires_at <= now:
        raise ApiError(401, "unauthenticated", "Sign in to continue.")
    return row[0], row[1]


CurrentSession = Annotated[tuple[AuthSession, User], Depends(current_session)]


async def current_user(session_user: CurrentSession) -> User:
    return session_user[1]


CurrentUser = Annotated[User, Depends(current_user)]


@router.post("/auth/logout", status_code=204)
async def logout(session_user: CurrentSession, db: Db) -> None:
    auth_session = await db.get(AuthSession, session_user[0].id)
    if auth_session is not None:
        auth_session.revoked_at = dt.datetime.now(dt.UTC)
        await db.commit()


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser, db: Db) -> dict[str, Any]:
    row = (
        await db.execute(
            select(Astrologer.id, Astrologer.status, Astrologer.slug).where(
                Astrologer.user_id == user.id
            )
        )
    ).one_or_none()
    return {
        "id": user.id,
        "phone": mask_phone(user.phone),
        "locale": user.locale,
        "is_adult_confirmed": user.is_adult_confirmed,
        "created_at": user.created_at,
        "roles": list(user.roles or []),
        "astrologer": {"id": row[0], "status": row[1], "slug": row[2]} if row else None,
    }
