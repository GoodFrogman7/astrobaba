"""Admin: astrologer verification lifecycle, KYC documents, flags, review moderation.

Lifecycle (docs/api/marketplace.md): applied → kyc_submitted → interview → probation (public)
→ approved (public); suspended and rejected from the live states. Every action is audited.
"""

import datetime as dt
import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.applicant import me_view
from astro_api.audit import audit
from astro_api.db import Db
from astro_api.errors import ApiError
from astro_api.marketplace import decode_cursor, encode_cursor
from astro_api.models import (
    ASTROLOGER_STATUSES,
    DEFAULT_FLAGS,
    REVIEW_STATUSES,
    VERIFICATION_STEPS,
    Astrologer,
    AstrologerVerification,
    AuditLog,
    KycDocument,
    Review,
    User,
)
from astro_api.phone import mask_phone
from astro_api.reviews import review_for_update
from astro_api.roles import AdminUser, actor
from astro_api.storage import DocumentStorage
from astro_api.taxonomy import tier_bounds

router = APIRouter(prefix="/v1/admin", tags=["admin"])

PROBATION_DAYS = 30
DOC_KIND_FOR_STEP = {"identity": "identity", "qualification": "qualification"}


class VerificationIn(BaseModel):
    status: Literal["passed", "failed"]
    note: str | None = Field(default=None, max_length=1000)


class ApproveIn(BaseModel):
    tier: str
    price_per_min_paise: int = Field(gt=0)


class ReasonIn(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)


class FlagsIn(BaseModel):
    chat_enabled: bool | None = None
    call_enabled: bool | None = None
    show_in_directory: bool | None = None


class AstrologerPatch(BaseModel):
    tier: str | None = None
    price_per_min_paise: int | None = Field(default=None, gt=0)
    flags: FlagsIn | None = None


def _check_price(tier: str, price: int) -> None:
    low, high = tier_bounds(tier)
    if not low <= price <= high:
        raise ApiError(
            422,
            "price_out_of_range",
            f"{tier} prices are {low}-{high} paise per minute.",
            min=low,
            max=high,
        )


async def _astrologer(
    db: AsyncSession, astrologer_id: uuid.UUID, *, lock: bool = True
) -> Astrologer:
    query = select(Astrologer).where(Astrologer.id == astrologer_id)
    if lock:
        query = query.with_for_update()
    a = (await db.execute(query)).scalar_one_or_none()
    if a is None:
        raise ApiError(404, "not_found", "Astrologer not found.")
    return a


async def _steps(db: AsyncSession, astrologer_id: uuid.UUID) -> dict[str, AstrologerVerification]:
    rows = (
        await db.execute(
            select(AstrologerVerification).where(
                AstrologerVerification.astrologer_id == astrologer_id
            )
        )
    ).scalars()
    found = {v.step: v for v in rows}
    for step in VERIFICATION_STEPS:
        if step not in found:
            v = AstrologerVerification(astrologer_id=astrologer_id, step=step, status="pending")
            db.add(v)
            found[step] = v
    return found


async def detail(db: AsyncSession, a: Astrologer) -> dict[str, Any]:
    view = await me_view(db, a)
    user = await db.get(User, a.user_id)
    trail = (
        await db.execute(
            select(AuditLog)
            .where(
                or_(
                    (AuditLog.entity == "astrologer") & (AuditLog.entity_id == str(a.id)),
                    AuditLog.detail["astrologer_id"].astext == str(a.id),
                )
            )
            .order_by(AuditLog.at, AuditLog.id)
        )
    ).scalars()
    view["documents"] = [
        {**d, "content_url": f"/v1/admin/documents/{d['id']}/content"} for d in view["documents"]
    ]
    return {
        **view,
        "phone": mask_phone(user.phone) if user else None,
        "is_seed": a.is_seed,
        "status_before_suspension": a.status_before_suspension,
        "approved_at": a.approved_at,
        "suspended_reason": a.suspended_reason,
        "rejected_reason": a.rejected_reason,
        "updated_at": a.updated_at,
        "audit": [
            {"at": e.at, "actor": e.actor, "action": e.action, "detail": e.detail} for e in trail
        ],
    }


@router.get("/astrologers")
async def list_astrologers(
    _: AdminUser,
    db: Db,
    status: str | None = None,
    q: Annotated[str | None, Query(max_length=60)] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    if status is not None and status not in ASTROLOGER_STATUSES:
        raise ApiError(422, "invalid_filter", f"Unknown status: {status}")
    offset = decode_cursor(cursor)
    query = select(Astrologer)
    if status:
        query = query.where(Astrologer.status == status)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(Astrologer.display_name.ilike(like), Astrologer.slug.ilike(like)))
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = list(
        (
            await db.execute(
                query.order_by(Astrologer.created_at.desc(), Astrologer.id)
                .offset(offset)
                .limit(limit)
            )
        ).scalars()
    )
    aids = [a.id for a in rows]
    steps: dict[uuid.UUID, dict[str, str]] = {aid: {} for aid in aids}
    doc_counts: dict[uuid.UUID, int] = {}
    if aids:
        for v in (
            await db.execute(
                select(AstrologerVerification).where(AstrologerVerification.astrologer_id.in_(aids))
            )
        ).scalars():
            steps[v.astrologer_id][v.step] = v.status
        doc_counts = {
            aid: int(n)
            for aid, n in (
                await db.execute(
                    select(KycDocument.astrologer_id, func.count())
                    .where(KycDocument.astrologer_id.in_(aids))
                    .group_by(KycDocument.astrologer_id)
                )
            ).all()
        }
    return {
        "items": [
            {
                "id": a.id,
                "slug": a.slug,
                "display_name": a.display_name,
                "status": a.status,
                "tier": a.tier,
                "price_per_min_paise": a.price_per_min_paise,
                "requested_price_per_min_paise": a.requested_price_per_min_paise,
                "verifications": {s: steps[a.id].get(s, "pending") for s in VERIFICATION_STEPS},
                "documents_count": doc_counts.get(a.id, 0),
                "is_seed": a.is_seed,
                "created_at": a.created_at,
                "updated_at": a.updated_at,
            }
            for a in rows
        ],
        "next_cursor": encode_cursor(offset + limit) if offset + limit < total else None,
        "total": total,
    }


@router.get("/astrologers/{astrologer_id}")
async def get_astrologer(_: AdminUser, astrologer_id: uuid.UUID, db: Db) -> dict[str, Any]:
    return await detail(db, await _astrologer(db, astrologer_id, lock=False))


@router.get("/documents/{document_id}/content")
async def document_content(
    admin_user: AdminUser, document_id: uuid.UUID, request: Request, db: Db
) -> Response:
    doc = await db.get(KycDocument, document_id)
    if doc is None:
        raise ApiError(404, "not_found", "Document not found.")
    storage: DocumentStorage = request.app.state.storage
    data = storage.get(doc.storage_key)
    audit(
        db,
        actor(admin_user),
        "kyc_document.view",
        "kyc_document",
        str(doc.id),
        astrologer_id=str(doc.astrologer_id),
    )
    await db.commit()
    return Response(
        content=data,
        media_type=doc.content_type,
        headers={
            "Content-Disposition": f'inline; filename="{doc.filename}"',
            "Cache-Control": "no-store",
            # Uploaded files are untrusted: never run script in our origin.
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/astrologers/{astrologer_id}/verifications/{step}")
async def verify_step(
    admin_user: AdminUser,
    astrologer_id: uuid.UUID,
    step: Literal["identity", "qualification", "interview", "probation"],
    body: VerificationIn,
    db: Db,
) -> dict[str, Any]:
    a = await _astrologer(db, astrologer_id)
    steps = await _steps(db, a.id)
    order = list(VERIFICATION_STEPS)
    earlier = order[: order.index(step)]
    if any(steps[s].status != "passed" for s in earlier):
        raise ApiError(409, "out_of_order", "Pass the earlier verification steps first.")
    allowed_status = {
        "identity": ("kyc_submitted",),
        "qualification": ("kyc_submitted",),
        "interview": ("interview",),
        "probation": ("probation",),
    }[step]
    if a.status not in allowed_status:
        raise ApiError(
            409,
            "invalid_transition",
            f"The {step} step cannot be recorded while the astrologer is {a.status}.",
        )
    now = dt.datetime.now(dt.UTC)
    v = steps[step]
    v.status, v.note, v.at, v.reviewer_user_id = body.status, body.note, now, admin_user.id
    kind = DOC_KIND_FOR_STEP.get(step)
    if kind:
        for doc in (
            await db.execute(
                select(KycDocument).where(
                    KycDocument.astrologer_id == a.id, KycDocument.kind == kind
                )
            )
        ).scalars():
            doc.review_status = "accepted" if body.status == "passed" else "rejected"
    documents_cleared = all(steps[s].status == "passed" for s in ("identity", "qualification"))
    if documents_cleared and a.status == "kyc_submitted":
        a.status = "interview"
    if step == "probation":
        if body.status == "passed":
            a.status = "approved"
        else:
            a.status = "rejected"
            a.rejected_reason = body.note or "probation not passed"
    audit(
        db,
        actor(admin_user),
        f"astrologer.verify.{step}",
        "astrologer",
        str(a.id),
        result=body.status,
    )
    await db.commit()
    return await detail(db, a)


@router.post("/astrologers/{astrologer_id}/approve")
async def approve(
    admin_user: AdminUser, astrologer_id: uuid.UUID, body: ApproveIn, db: Db
) -> dict[str, Any]:
    a = await _astrologer(db, astrologer_id)
    steps = await _steps(db, a.id)
    if a.status != "interview" or any(
        steps[s].status != "passed" for s in ("identity", "qualification", "interview")
    ):
        raise ApiError(
            409,
            "not_ready",
            "Identity, qualification and interview must all be passed before approval.",
        )
    _check_price(body.tier, body.price_per_min_paise)
    now = dt.datetime.now(dt.UTC)
    a.tier, a.price_per_min_paise = body.tier, body.price_per_min_paise
    a.status, a.approved_at = "probation", now
    a.probation_until = now + dt.timedelta(days=PROBATION_DAYS)
    audit(
        db,
        actor(admin_user),
        "astrologer.approve",
        "astrologer",
        str(a.id),
        tier=body.tier,
        price_per_min_paise=body.price_per_min_paise,
    )
    await db.commit()
    return await detail(db, a)


@router.post("/astrologers/{astrologer_id}/suspend")
async def suspend(
    admin_user: AdminUser, astrologer_id: uuid.UUID, body: ReasonIn, db: Db
) -> dict[str, Any]:
    a = await _astrologer(db, astrologer_id)
    if a.status not in ("probation", "approved"):
        raise ApiError(409, "invalid_transition", "Only live astrologers can be suspended.")
    a.status_before_suspension, a.status = a.status, "suspended"
    a.suspended_reason = body.reason
    audit(db, actor(admin_user), "astrologer.suspend", "astrologer", str(a.id))
    await db.commit()
    return await detail(db, a)


@router.post("/astrologers/{astrologer_id}/reinstate")
async def reinstate(admin_user: AdminUser, astrologer_id: uuid.UUID, db: Db) -> dict[str, Any]:
    a = await _astrologer(db, astrologer_id)
    if a.status != "suspended":
        raise ApiError(409, "invalid_transition", "Only suspended astrologers can be reinstated.")
    a.status = a.status_before_suspension or "probation"
    a.status_before_suspension, a.suspended_reason = None, None
    audit(db, actor(admin_user), "astrologer.reinstate", "astrologer", str(a.id))
    await db.commit()
    return await detail(db, a)


@router.post("/astrologers/{astrologer_id}/reject")
async def reject(
    admin_user: AdminUser, astrologer_id: uuid.UUID, body: ReasonIn, db: Db
) -> dict[str, Any]:
    a = await _astrologer(db, astrologer_id)
    if a.status == "rejected":
        raise ApiError(409, "invalid_transition", "Already rejected.")
    a.status, a.rejected_reason = "rejected", body.reason
    audit(db, actor(admin_user), "astrologer.reject", "astrologer", str(a.id))
    await db.commit()
    return await detail(db, a)


@router.patch("/astrologers/{astrologer_id}")
async def patch_astrologer(
    admin_user: AdminUser, astrologer_id: uuid.UUID, body: AstrologerPatch, db: Db
) -> dict[str, Any]:
    a = await _astrologer(db, astrologer_id)
    changes: dict[str, Any] = {}
    if body.tier is not None or body.price_per_min_paise is not None:
        if a.tier is None:
            raise ApiError(409, "not_approved", "Set tier and price through approval first.")
        tier = body.tier or a.tier
        price = body.price_per_min_paise or a.price_per_min_paise or 0
        _check_price(tier, price)
        a.tier, a.price_per_min_paise = tier, price
        changes.update(tier=tier, price_per_min_paise=price)
    if body.flags is not None:
        flags = {**DEFAULT_FLAGS, **(a.flags or {})}
        flags.update(body.flags.model_dump(exclude_none=True))
        a.flags = flags
        changes["flags"] = body.flags.model_dump(exclude_none=True)
    audit(db, actor(admin_user), "astrologer.update", "astrologer", str(a.id), **changes)
    await db.commit()
    return await detail(db, a)


def admin_review(r: Review, a: Astrologer | None) -> dict[str, Any]:
    return {
        "id": r.id,
        "astrologer": {"id": a.id, "slug": a.slug, "display_name": a.display_name} if a else None,
        "session_id": r.session_id,
        "rating": r.rating,
        "text": r.text,
        "status": r.status,
        "held": r.auto_flag_reason is not None,
        "auto_flag_reason": r.auto_flag_reason,
        "report_count": r.report_count,
        "reply": {"text": r.reply_text, "at": r.reply_at} if r.reply_text else None,
        "moderation_note": r.moderation_note,
        "moderated_at": r.moderated_at,
        "created_at": r.created_at,
    }


@router.get("/reviews")
async def list_reviews(
    _: AdminUser,
    db: Db,
    status: str = "flagged",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    if status not in REVIEW_STATUSES:
        raise ApiError(422, "invalid_filter", f"Unknown status: {status}")
    offset = decode_cursor(cursor)
    query = select(Review, Astrologer).join(Astrologer, Astrologer.id == Review.astrologer_id)
    query = query.where(cast(Review.status, String) == status)
    total = (
        await db.execute(select(func.count()).where(cast(Review.status, String) == status))
    ).scalar_one()
    rows = (
        await db.execute(
            query.order_by(Review.report_count.desc(), Review.created_at.desc(), Review.id)
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return {
        "items": [admin_review(r, a) for r, a in rows],
        "next_cursor": encode_cursor(offset + limit) if offset + limit < total else None,
        "total": total,
    }


@router.post("/reviews/{review_id}/hide")
async def hide_review(
    admin_user: AdminUser, review_id: uuid.UUID, body: ReasonIn, db: Db
) -> dict[str, Any]:
    r = await review_for_update(db, review_id)
    r.status, r.moderation_note = "hidden", body.reason
    r.moderated_by, r.moderated_at = admin_user.id, dt.datetime.now(dt.UTC)
    audit(db, actor(admin_user), "review.hide", "review", str(r.id))
    await db.commit()
    return admin_review(r, await db.get(Astrologer, r.astrologer_id))


@router.post("/reviews/{review_id}/unhide")
async def unhide_review(admin_user: AdminUser, review_id: uuid.UUID, db: Db) -> dict[str, Any]:
    """Publish: clears an automatic hold or a hide after a moderator has looked."""
    r = await review_for_update(db, review_id)
    r.status, r.auto_flag_reason = "published", None
    r.moderated_by, r.moderated_at = admin_user.id, dt.datetime.now(dt.UTC)
    audit(db, actor(admin_user), "review.publish", "review", str(r.id))
    await db.commit()
    return admin_review(r, await db.get(Astrologer, r.astrologer_id))
