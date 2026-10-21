"""Astrologer applications, KYC documents and presence (signed-in user's own record)."""

import datetime as dt
import re
import unicodedata
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.audit import audit
from astro_api.auth import CurrentUser
from astro_api.config import Settings
from astro_api.consent import RequireAstrologerConsent
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.growth_api import lock_open_invite, mark_invite_used, require_invite_if_flagged
from astro_api.marketplace import (
    PRESENCE_TTL_S,
    _s,
    is_public,
    presence_key,
    presence_of,
)
from astro_api.models import (
    DEFAULT_FLAGS,
    VERIFICATION_STEPS,
    Astrologer,
    AstrologerVerification,
    KycDocument,
    User,
)
from astro_api.roles import actor
from astro_api.storage import DocumentStorage, digest, new_key, sniff_content_type
from astro_api.taxonomy import check_values, price_range, taxonomy

router = APIRouter(prefix="/v1/astrologer", tags=["astrologer"])

EDITABLE_STATUSES = ("applied", "kyc_submitted")
UPLOAD_STATUSES = ("applied", "kyc_submitted", "interview")


class ApplicationIn(BaseModel):
    display_name: str = Field(min_length=2, max_length=60)
    bio: str = Field(min_length=20, max_length=2000)
    bio_hi: str | None = Field(default=None, max_length=2000)
    skills: list[str] = Field(min_length=1, max_length=9)
    languages: list[str] = Field(min_length=1, max_length=12)
    gender: Literal["female", "male", "other"]
    experience_years: int = Field(ge=0, le=80)
    requested_price_per_min_paise: int = Field(gt=0)
    accepts_terms: bool
    # Admin invite (docs/api/growth.md §2.1); required while flag astrologer_invite_only is on.
    invite_code: str | None = Field(default=None, max_length=64)


class ApplicationPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=60)
    bio: str | None = Field(default=None, min_length=20, max_length=2000)
    bio_hi: str | None = Field(default=None, max_length=2000)
    skills: list[str] | None = Field(default=None, min_length=1, max_length=9)
    languages: list[str] | None = Field(default=None, min_length=1, max_length=12)
    gender: Literal["female", "male", "other"] | None = None
    experience_years: int | None = Field(default=None, ge=0, le=80)
    requested_price_per_min_paise: int | None = Field(default=None, gt=0)


class PresenceIn(BaseModel):
    status: Literal["online", "offline"]


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:60].strip("-") or "astrologer"


async def unique_slug(db: AsyncSession, name: str, exclude: uuid.UUID | None = None) -> str:
    base = slugify(name)
    query = select(Astrologer.slug).where(
        (Astrologer.slug == base) | Astrologer.slug.like(f"{base}-%")
    )
    if exclude is not None:
        query = query.where(Astrologer.id != exclude)
    taken = set((await db.execute(query)).scalars())
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def _check_choices(skills: list[str] | None, languages: list[str] | None) -> None:
    if skills is not None:
        check_values("skills", skills)
        if len(set(skills)) != len(skills):
            raise ApiError(422, "invalid_value", "Skills are listed twice.")
    if languages is not None:
        check_values("languages", languages)
        if len(set(languages)) != len(languages):
            raise ApiError(422, "invalid_value", "Languages are listed twice.")


def _check_requested_price(price: int | None) -> None:
    if price is None:
        return
    low, high = price_range()
    if not low <= price <= high:
        raise ApiError(
            422,
            "price_out_of_range",
            f"Price must be between {low} and {high} paise per minute.",
            min=low,
            max=high,
        )


def sanitize_filename(name: str | None) -> str:
    base = (name or "document").replace("\\", "/").rsplit("/", 1)[-1]
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "document"
    return clean[:100]


async def own_astrologer(db: AsyncSession, user: User, *, lock: bool = False) -> Astrologer:
    query = select(Astrologer).where(Astrologer.user_id == user.id)
    if lock:
        query = query.with_for_update()
    a = (await db.execute(query)).scalar_one_or_none()
    if a is None:
        raise ApiError(404, "not_applied", "You have not applied as an astrologer.")
    return a


async def me_view(db: AsyncSession, a: Astrologer) -> dict[str, Any]:
    steps = {
        v.step: v
        for v in (
            await db.execute(
                select(AstrologerVerification).where(AstrologerVerification.astrologer_id == a.id)
            )
        ).scalars()
    }
    docs = (
        await db.execute(
            select(KycDocument)
            .where(KycDocument.astrologer_id == a.id)
            .order_by(KycDocument.uploaded_at, KycDocument.id)
        )
    ).scalars()
    return {
        "id": a.id,
        "slug": a.slug,
        "status": a.status,
        "display_name": a.display_name,
        "bio": a.bio,
        "bio_hi": a.bio_hi,
        "skills": a.skills,
        "languages": a.languages,
        "gender": a.gender,
        "experience_years": a.experience_years,
        "requested_price_per_min_paise": a.requested_price_per_min_paise,
        "tier": a.tier,
        "price_per_min_paise": a.price_per_min_paise,
        "flags": a.flags,
        "probation_until": a.probation_until,
        "created_at": a.created_at,
        "verifications": [
            {
                "step": step,
                "status": steps[step].status if step in steps else "pending",
                "note": steps[step].note if step in steps else None,
                "at": steps[step].at if step in steps else None,
            }
            for step in VERIFICATION_STEPS
        ],
        "documents": [
            {
                "id": d.id,
                "kind": d.kind,
                "filename": d.filename,
                "size": d.size,
                "uploaded_at": d.uploaded_at,
                "review_status": d.review_status,
            }
            for d in docs
        ],
    }


async def create_application(
    db: AsyncSession, settings: Settings, user: User, body: ApplicationIn
) -> Astrologer:
    """Create the application and commit. An invite code is claimed (row locked, marked used)
    in the same transaction, so one code can never admit two applicants."""
    code = (body.invite_code or "").strip() or None
    require_invite_if_flagged(code)
    if not body.accepts_terms:
        raise ApiError(422, "terms_required", "Please accept the terms to apply.")
    _check_choices(body.skills, body.languages)
    _check_requested_price(body.requested_price_per_min_paise)
    existing = (
        await db.execute(select(Astrologer.id).where(Astrologer.user_id == user.id))
    ).scalar_one_or_none()
    if existing is not None:
        raise ApiError(409, "already_applied", "You have already applied.")
    invite = await lock_open_invite(db, settings, code) if code else None
    a = Astrologer(
        user_id=user.id,
        display_name=body.display_name.strip(),
        slug=await unique_slug(db, body.display_name),
        bio=body.bio.strip(),
        bio_hi=(body.bio_hi or "").strip() or None,
        skills=body.skills,
        languages=body.languages,
        gender=body.gender,
        experience_years=body.experience_years,
        requested_price_per_min_paise=body.requested_price_per_min_paise,
        status="applied",
        flags=dict(DEFAULT_FLAGS),
        accepts_terms_at=dt.datetime.now(dt.UTC),
        invite_id=invite.id if invite else None,
    )
    db.add(a)
    await db.flush()
    if invite is not None:
        mark_invite_used(invite, a.id)
    for step in VERIFICATION_STEPS:
        db.add(AstrologerVerification(astrologer_id=a.id, step=step, status="pending"))
    audit(db, actor(user), "astrologer.apply", "astrologer", str(a.id), invited=invite is not None)
    await db.commit()
    return a


@router.post("/application", status_code=201)
async def apply(body: ApplicationIn, user: CurrentUser, db: Db, request: Request) -> dict[str, Any]:
    a = await create_application(db, settings_of(request), user, body)
    return await me_view(db, a)


@router.get("/me")
async def get_me(user: CurrentUser, db: Db) -> dict[str, Any]:
    return await me_view(db, await own_astrologer(db, user))


@router.patch("/me")
async def patch_me(body: ApplicationPatch, user: CurrentUser, db: Db) -> dict[str, Any]:
    a = await own_astrologer(db, user, lock=True)
    if a.status not in EDITABLE_STATUSES:
        raise ApiError(409, "locked", "Your profile can no longer be edited here.")
    _check_choices(body.skills, body.languages)
    _check_requested_price(body.requested_price_per_min_paise)
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if field in ("display_name", "bio") and value is not None:
            value = value.strip()
        if field == "bio_hi":
            value = (value or "").strip() or None
        if value is None and field != "bio_hi":
            continue
        setattr(a, field, value)
    if changes.get("display_name"):
        a.slug = await unique_slug(db, a.display_name, exclude=a.id)
    audit(db, actor(user), "astrologer.update", "astrologer", str(a.id), fields=sorted(changes))
    await db.commit()
    return await me_view(db, a)


def _storage(request: Request) -> DocumentStorage:
    storage: DocumentStorage = request.app.state.storage
    return storage


async def _kinds(db: AsyncSession, astrologer_id: uuid.UUID) -> set[str]:
    return set(
        (
            await db.execute(
                select(KycDocument.kind).where(KycDocument.astrologer_id == astrologer_id)
            )
        ).scalars()
    )


@router.post("/me/documents", status_code=201)
async def upload_document(
    request: Request,
    user: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    kind: Annotated[Literal["identity", "qualification", "other"], Form()],
) -> dict[str, Any]:
    limits = taxonomy()["kyc"]
    a = await own_astrologer(db, user, lock=True)
    if a.status not in UPLOAD_STATUSES:
        raise ApiError(409, "locked", "Documents can no longer be added.")
    count = (
        await db.execute(select(func.count()).where(KycDocument.astrologer_id == a.id))
    ).scalar_one()
    if count >= int(limits["max_documents"]):
        raise ApiError(409, "too_many_documents", "You have uploaded the maximum number of files.")
    max_bytes = int(limits["max_file_bytes"])
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ApiError(413, "file_too_large", f"Files must be at most {max_bytes} bytes.")
    if not data:
        raise ApiError(422, "empty_file", "The file is empty.")
    content_type = sniff_content_type(data)
    if content_type is None or content_type not in limits["content_types"]:
        raise ApiError(415, "unsupported_file_type", "Upload a PDF, JPEG or PNG file.")
    key = new_key()
    _storage(request).put(key, data)
    doc = KycDocument(
        astrologer_id=a.id,
        kind=kind,
        filename=sanitize_filename(file.filename),
        content_type=content_type,
        size=len(data),
        sha256=digest(data),
        storage_key=key,
    )
    db.add(doc)
    await db.flush()
    if a.status == "applied" and {"identity", "qualification"} <= await _kinds(db, a.id):
        a.status = "kyc_submitted"
    audit(
        db,
        actor(user),
        "kyc_document.upload",
        "astrologer",
        str(a.id),
        document_id=str(doc.id),
        kind=kind,
    )
    await db.commit()
    return {
        "id": doc.id,
        "kind": doc.kind,
        "filename": doc.filename,
        "size": doc.size,
        "uploaded_at": doc.uploaded_at,
        "review_status": doc.review_status,
        "astrologer_status": a.status,
    }


@router.delete("/me/documents/{document_id}", status_code=204)
async def delete_document(
    document_id: uuid.UUID, request: Request, user: CurrentUser, db: Db
) -> None:
    a = await own_astrologer(db, user, lock=True)
    doc = await db.get(KycDocument, document_id)
    if doc is None or doc.astrologer_id != a.id:
        raise ApiError(404, "not_found", "Document not found.")
    if a.status not in EDITABLE_STATUSES or doc.review_status != "pending":
        raise ApiError(409, "locked", "This document has been reviewed and cannot be removed.")
    await db.delete(doc)
    await db.flush()
    if a.status == "kyc_submitted" and not {"identity", "qualification"} <= await _kinds(db, a.id):
        a.status = "applied"
    audit(db, actor(user), "kyc_document.delete", "astrologer", str(a.id), document_id=str(doc.id))
    await db.commit()
    _storage(request).delete(doc.storage_key)


@router.post("/me/presence", dependencies=[RequireAstrologerConsent])
async def set_presence(
    body: PresenceIn, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    settings = settings_of(request)
    redis = redis_of(request)
    a = await own_astrologer(db, user)
    if not is_public(a, settings):
        raise ApiError(409, "not_live", "Only live astrologers can set presence.")
    key = presence_key(a.id)
    current = _s(await redis.get(key))
    if body.status == "online":
        # A session in progress (busy) is not overridden by a heartbeat.
        if current != "busy":
            await redis.set(key, "online", ex=PRESENCE_TTL_S)
    elif current == "online":
        await redis.delete(key)
    presence, wait = (await presence_of(redis, [a.id]))[a.id]
    return {"presence": presence, "wait_minutes": wait, "ttl_s": PRESENCE_TTL_S}
