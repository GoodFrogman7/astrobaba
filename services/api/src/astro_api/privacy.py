"""Data export and account deletion (docs/api/trust.md §2, ADR-0011).

Export: `request_export` queues a `data_export` job (one per 24 h); `complete_export` (run by
the worker) builds a JSON file of everything held about the user, stores it with the documents
storage under a random key and schedules its removal (`account_cleanup`, `EXPORT_FILE_TTL`).
Downloads use a 10-minute HMAC link like reports.

Deletion: the user requests (or cancels); an admin executes. `execute_deletion` anonymises the
account in ONE transaction and queues `account_cleanup` for the files. The ledger is never
touched except to forfeit leftover promo credit through the normal expiry posting.

Never logs or audits personal data: ids, counts and amounts only.
"""

import datetime as dt
import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import anyio
from cryptography.exceptions import InvalidTag
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import consent, earnings, jobs, wallet
from astro_api.ai_api import open_answer, open_text
from astro_api.audit import audit
from astro_api.chat_crypto import MessageCipher, Sealed, UnknownKey, aad, cipher_from_settings
from astro_api.config import Settings
from astro_api.models import (
    OPEN_SESSION_STATUSES,
    TOMBSTONE_PREFIX,
    Astrologer,
    AstrologerVerification,
    AuthSession,
    ConsultSession,
    KycDocument,
    Review,
    SavedKundli,
    User,
)
from astro_api.models_ai import AiConversation, AiQuestion
from astro_api.models_analytics import AnalyticsEvent
from astro_api.models_jobs import Job
from astro_api.models_ledger import (
    FreeSessionClaim,
    FreeSessionOverride,
    PromoLot,
    RechargeOrder,
)
from astro_api.models_portal import AstrologerAvailability, Payout, availability_view
from astro_api.models_privacy import Consent, DataExport, DeletionRequest
from astro_api.models_remedies import RemedyLead, note_aad
from astro_api.models_reports import Report, ReportOrder
from astro_api.models_safety import (
    AstrologerStrike,
    ModerationEvent,
    SafetyEvent,
    report_note_aad,
)
from astro_api.models_sessions import ChatMessage
from astro_api.payouts import payout_view
from astro_api.storage import DocumentStorage, new_key

EXPORT_FORMAT = "astro-data-export/1"
EXPORT_WINDOW = dt.timedelta(hours=24)  # one export per user per 24 h
EXPORT_FILE_TTL = dt.timedelta(days=7)  # the file is removed after this
DOWNLOAD_TTL_S = 600  # signed download links: 10 minutes
SYSTEM_ACTOR = "system:privacy"


class ExportRateLimited(Exception):
    def __init__(self, retry_after_s: int) -> None:
        super().__init__("export_rate_limited")
        self.retry_after_s = retry_after_s


class AccountDeleted(Exception):
    """The account was anonymised; nothing more can be exported or requested."""


class DeletionNotFound(Exception):
    pass


class DeletionNotOpen(Exception):
    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


class SessionOpen(Exception):
    def __init__(self, session_ids: list[str]) -> None:
        super().__init__("session_open")
        self.session_ids = session_ids


class BalanceOutstanding(Exception):
    def __init__(self, real_paise: int, payable_paise: int) -> None:
        super().__init__("balance_outstanding")
        self.real_paise = real_paise
        self.payable_paise = payable_paise


class WorkPending(Exception):
    def __init__(self, pending: list[str]) -> None:
        super().__init__("work_pending")
        self.pending = pending


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def _iso(v: dt.datetime | dt.date | None) -> str | None:
    return v.isoformat() if v is not None else None


def is_deleted(user: User) -> bool:
    return user.phone.startswith(TOMBSTONE_PREFIX)


def tombstone(settings: Settings, phone: str, user_id: uuid.UUID) -> str:
    """`deleted:{HMAC(phone)}:{user id}`: unique, not reversible without SECRET_KEY, and lets a
    later abuse check recognise a number that deleted an account (founder/lawyer decision)."""
    return f"{TOMBSTONE_PREFIX}{consent.hmac_hex(settings, 'deleted_phone', phone)}:{user_id}"


# ------------------------------------------------------------------ signed export links


def _sig_key(settings: Settings) -> bytes:
    secret = settings.secret_key.get_secret_value().encode()
    return hmac.new(secret, b"export-links", hashlib.sha256).digest()


def _mac(settings: Settings, export_id: uuid.UUID, expires: str) -> str:
    msg = f"export_file:{export_id}:{expires}".encode()
    return hmac.new(_sig_key(settings), msg, hashlib.sha256).hexdigest()


def sign_export(settings: Settings, export_id: uuid.UUID, ttl_s: int = DOWNLOAD_TTL_S) -> str:
    expires = str(int(time.time()) + ttl_s)
    return f"{expires}.{_mac(settings, export_id, expires)}"


def check_export_sig(
    settings: Settings, export_id: uuid.UUID, sig: str | None
) -> Literal["ok", "invalid", "expired"]:
    if not sig or "." not in sig:
        return "invalid"
    expires, _, mac = sig.partition(".")
    if not expires.isdigit() or not hmac.compare_digest(_mac(settings, export_id, expires), mac):
        return "invalid"
    return "expired" if int(expires) < time.time() else "ok"


def export_download_url(settings: Settings, export_id: uuid.UUID) -> str:
    return f"/v1/me/exports/{export_id}/file?sig={sign_export(settings, export_id)}"


# ------------------------------------------------------------------ jobs


async def _schedule(
    db: AsyncSession, kind: str, payload: dict[str, Any], key: str, run_after: dt.datetime
) -> None:
    """`jobs.enqueue` with a start time (idempotent on key). Caller commits."""
    await db.execute(
        pg_insert(Job)
        .values(id=uuid.uuid4(), kind=kind, key=key, payload=payload, run_after=run_after)
        .on_conflict_do_nothing(index_elements=["key"])
    )


# ------------------------------------------------------------------ export: request


async def request_export(db: AsyncSession, user: User) -> DataExport:
    """Queue an export, at most one per `EXPORT_WINDOW` (failed ones do not count). The user row
    is locked so two concurrent requests cannot both pass the check. Caller commits."""
    if is_deleted(user):
        raise AccountDeleted
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    now = _now()
    last = (
        await db.execute(
            select(func.max(DataExport.created_at)).where(
                DataExport.user_id == user.id,
                DataExport.status != "failed",
                DataExport.created_at > now - EXPORT_WINDOW,
            )
        )
    ).scalar_one_or_none()
    if last is not None:
        raise ExportRateLimited(max(1, int((last + EXPORT_WINDOW - now).total_seconds())))
    export = DataExport(id=uuid.uuid4(), user_id=user.id, status="queued")
    db.add(export)
    await db.flush()
    await jobs.enqueue(
        db, "data_export", {"export_id": str(export.id)}, f"export:{export.id}:build"
    )
    audit(db, f"user:{user.id}", "privacy.export.request", "data_export", str(export.id))
    return export


# ------------------------------------------------------------------ export: build


def _open(cipher: MessageCipher, sealed: Sealed, associated: bytes) -> str | None:
    try:
        return cipher.decrypt(sealed, associated)
    except (UnknownKey, InvalidTag):
        return None  # a retired key or a damaged row: listed, text unavailable


async def _profile(db: AsyncSession, user: User) -> dict[str, Any]:
    sessions = (
        await db.execute(
            select(AuthSession)
            .where(AuthSession.user_id == user.id)
            .order_by(AuthSession.created_at)
        )
    ).scalars()
    return {
        "id": str(user.id),
        "phone": user.phone,
        "locale": user.locale,
        "is_adult_confirmed": user.is_adult_confirmed,
        "roles": list(user.roles or []),
        "created_at": _iso(user.created_at),
        "last_login_at": _iso(user.last_login_at),
        "devices": list(user.device_ids or []),
        "sign_in_sessions": [
            {
                "created_at": _iso(s.created_at),
                "expires_at": _iso(s.expires_at),
                "revoked_at": _iso(s.revoked_at),
                "device_id": s.device_id,
            }
            for s in sessions
        ],
    }


async def _consents(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(Consent).where(Consent.user_id == user_id).order_by(Consent.accepted_at)
        )
    ).scalars()
    return [
        {"kind": c.kind, "version": c.version, "accepted_at": _iso(c.accepted_at)} for c in rows
    ]


async def _kundlis(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(SavedKundli)
            .where(SavedKundli.user_id == user_id)
            .order_by(SavedKundli.created_at)
        )
    ).scalars()
    return [
        {
            "id": str(k.id),
            "name": k.name,
            "gender": k.gender,
            "birth_date": _iso(k.birth_date),
            "birth_time": k.birth_time.isoformat() if k.birth_time else None,
            "unknown_time": k.unknown_time,
            "tz": k.tz,
            "utc_offset": k.utc_offset,
            "lat": k.lat,
            "lon": k.lon,
            "place_label": k.place_label,
            "created_at": _iso(k.created_at),
        }
        for k in rows
    ]


async def _consultations(
    db: AsyncSession, cipher: MessageCipher, user_id: uuid.UUID
) -> list[dict[str, Any]]:
    """The user's own consultations (as the client). The astrologer appears by display name;
    every message of the conversation is the user's own exchange and is decrypted."""
    rows = (
        await db.execute(
            select(ConsultSession, Astrologer.display_name, Astrologer.slug)
            .join(Astrologer, Astrologer.id == ConsultSession.astrologer_id)
            .where(ConsultSession.user_id == user_id)
            .order_by(ConsultSession.created_at)
        )
    ).all()
    out = []
    for s, name, slug in rows:
        messages = (
            await db.execute(
                select(ChatMessage).where(ChatMessage.session_id == s.id).order_by(ChatMessage.seq)
            )
        ).scalars()
        flags = (
            await db.execute(
                select(SafetyEvent).where(SafetyEvent.session_id == s.id).order_by(SafetyEvent.at)
            )
        ).scalars()
        sender = {"user": "you", "astrologer": name, "system": "system"}
        out.append(
            {
                "id": str(s.id),
                "kind": s.kind,
                "status": s.status,
                "astrologer": {"display_name": name, "slug": slug},
                "created_at": _iso(s.created_at),
                "started_at": _iso(s.started_at),
                "ended_at": _iso(s.ended_at),
                "end_reason": s.end_reason,
                "is_free": s.is_free,
                "price_per_min_paise": s.price_per_min_paise,
                "billed_minutes": s.billed_minutes,
                "billed_paise": s.billed_paise,
                "safety_flags": [
                    {"kind": f.kind, "message_seq": f.message_seq, "at": _iso(f.at)} for f in flags
                ],
                "messages": [
                    {
                        "seq": m.seq,
                        "from": sender.get(m.sender, m.sender),
                        "text": _open(
                            cipher,
                            Sealed(m.ciphertext, m.nonce, m.key_id),
                            aad(m.session_id, m.seq),
                        ),
                        "sent_at": _iso(m.created_at),
                    }
                    for m in messages
                ],
            }
        )
    return out


async def _reviews_written(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(Review, Astrologer.display_name)
            .join(Astrologer, Astrologer.id == Review.astrologer_id)
            .where(Review.user_id == user_id)
            .order_by(Review.created_at)
        )
    ).all()
    return [
        {
            "session_id": str(r.session_id),
            "astrologer": name,
            "rating": r.rating,
            "text": r.text,
            "status": r.status,
            "reply_text": r.reply_text,
            "created_at": _iso(r.created_at),
        }
        for r, name in rows
    ]


async def _wallet(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    history: list[dict[str, Any]] = []
    before: int | None = None
    while True:
        items, before = await wallet.history(db, user_id, before=before, limit=200)
        history += [{**i, "created_at": _iso(i["created_at"])} for i in items]
        if before is None:
            break
    b = await wallet.balances(db, user_id)
    orders = (
        await db.execute(
            select(RechargeOrder)
            .where(RechargeOrder.user_id == user_id)
            .order_by(RechargeOrder.created_at)
        )
    ).scalars()
    return {
        "balance": {"real_paise": b.real_paise, "promo_paise": b.promo_paise},
        "history": history,
        "recharge_orders": [
            {
                "id": str(o.id),
                "amount_paise": o.amount_paise,
                "bonus_paise": o.bonus_paise,
                "status": o.status,
                "provider": o.provider,
                "provider_payment_id": o.provider_payment_id,
                "created_at": _iso(o.created_at),
                "paid_at": _iso(o.paid_at),
            }
            for o in orders
        ],
    }


async def _reports(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    orders = (
        await db.execute(
            select(ReportOrder)
            .where(ReportOrder.user_id == user_id)
            .order_by(ReportOrder.created_at)
        )
    ).scalars()
    reports = (
        await db.execute(
            select(Report).where(Report.user_id == user_id).order_by(Report.created_at)
        )
    ).scalars()
    return {
        "orders": [
            {
                "id": str(o.id),
                "sku": o.sku,
                "language": o.language,
                "kundli_ids": [str(k) for k in o.kundli_ids],
                "pay_with": o.pay_with,
                "price_paise": o.price_paise,
                "status": o.status,
                "created_at": _iso(o.created_at),
                "paid_at": _iso(o.paid_at),
            }
            for o in orders
        ],
        # The PDFs themselves are downloadable from the reports page.
        "reports": [
            {
                "id": str(r.id),
                "sku": r.sku,
                "language": r.language,
                "status": r.status,
                "pages": r.pages,
                "created_at": _iso(r.created_at),
                "ready_at": _iso(r.ready_at),
            }
            for r in reports
        ],
    }


async def _ai_questions(
    db: AsyncSession, cipher: MessageCipher, user_id: uuid.UUID
) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(AiQuestion, AiConversation.kundli_id)
            .join(AiConversation, AiConversation.id == AiQuestion.conversation_id)
            .where(AiQuestion.user_id == user_id)
            .order_by(AiQuestion.created_at)
        )
    ).all()
    out = []
    for q, kundli_id in rows:
        try:
            question: str | None = open_text(cipher, q)
            answer = open_answer(cipher, q)
        except (UnknownKey, InvalidTag):
            question = answer = None
        out.append(
            {
                "id": str(q.id),
                "kundli_id": str(kundli_id),
                "label": "AI",
                "question": question,
                "answer": answer,
                "status": q.status,
                "blocked_reason": q.blocked_reason,
                "language": q.language,
                "price_paise": q.price_paise,
                "refunded": q.refunded,
                "created_at": _iso(q.created_at),
                "answered_at": _iso(q.answered_at),
            }
        )
    return out


async def _remedy_leads(
    db: AsyncSession, cipher: MessageCipher, user_id: uuid.UUID
) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(RemedyLead).where(RemedyLead.user_id == user_id).order_by(RemedyLead.created_at)
        )
    ).scalars()
    out = []
    for lead in rows:
        note = None
        if lead.note_ciphertext and lead.note_nonce and lead.note_key_id:
            note = _open(
                cipher,
                Sealed(lead.note_ciphertext, lead.note_nonce, lead.note_key_id),
                note_aad(lead.id),
            )
        out.append(
            {
                "id": str(lead.id),
                "remedy_id": lead.remedy_id,
                "partner_id": lead.partner_id,
                "language": lead.language,
                "preferred_date": _iso(lead.preferred_date),
                "phone_shared": lead.phone,
                "note": note,
                "status": lead.status,
                "shared_with_partner_at": _iso(lead.notified_at),
                "created_at": _iso(lead.created_at),
            }
        )
    return out


async def _reports_filed(
    db: AsyncSession, cipher: MessageCipher, user_id: uuid.UUID
) -> list[dict[str, Any]]:
    """Astrologer reports the user filed: reason, own note, status. The admin's resolution
    note is internal and not included."""
    rows = (
        await db.execute(
            select(ModerationEvent, Astrologer.display_name)
            .join(Astrologer, Astrologer.id == ModerationEvent.astrologer_id)
            .where(ModerationEvent.reporter_user_id == user_id, ModerationEvent.kind == "report")
            .order_by(ModerationEvent.created_at)
        )
    ).all()
    out = []
    for m, name in rows:
        note = None
        if m.note_ciphertext and m.note_nonce and m.note_key_id:
            note = _open(
                cipher,
                Sealed(m.note_ciphertext, m.note_nonce, m.note_key_id),
                report_note_aad(m.id),
            )
        out.append(
            {
                "id": str(m.id),
                "astrologer": name,
                "session_id": str(m.session_id) if m.session_id else None,
                "reason": m.reason,
                "note": note,
                "status": m.status,
                "created_at": _iso(m.created_at),
                "closed_at": _iso(m.closed_at),
            }
        )
    return out


async def _privacy(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    exports = (
        await db.execute(
            select(DataExport).where(DataExport.user_id == user_id).order_by(DataExport.created_at)
        )
    ).scalars()
    deletions = (
        await db.execute(
            select(DeletionRequest)
            .where(DeletionRequest.user_id == user_id)
            .order_by(DeletionRequest.requested_at)
        )
    ).scalars()
    claim = (
        await db.execute(select(FreeSessionClaim).where(FreeSessionClaim.user_id == user_id))
    ).scalar_one_or_none()
    return {
        "exports": [
            {"id": str(e.id), "status": e.status, "created_at": _iso(e.created_at)} for e in exports
        ],
        "deletion_requests": [
            {
                "id": str(d.id),
                "status": d.status,
                "requested_at": _iso(d.requested_at),
                "cancelled_at": _iso(d.cancelled_at),
            }
            for d in deletions
        ],
        "free_session": (
            {"session_id": str(claim.session_id), "claimed_at": _iso(claim.claimed_at)}
            if claim
            else None
        ),
    }


async def _analytics(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    """Product analytics events recorded with the user's id (docs/api/growth.md §1.2)."""
    rows = (
        await db.execute(
            select(AnalyticsEvent.event, AnalyticsEvent.occurred_at, AnalyticsEvent.properties)
            .where(AnalyticsEvent.user_id == user_id)
            .order_by(AnalyticsEvent.occurred_at, AnalyticsEvent.id)
        )
    ).all()
    return [
        {"event": event, "occurred_at": _iso(at), "properties": properties}
        for event, at, properties in rows
    ]


async def _astrologer(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Any] | None:
    """The astrologer's own records. Clients appear in none of them (no ids, no messages)."""
    a = (
        await db.execute(select(Astrologer).where(Astrologer.user_id == user_id))
    ).scalar_one_or_none()
    if a is None:
        return None
    verifications = (
        await db.execute(
            select(AstrologerVerification)
            .where(AstrologerVerification.astrologer_id == a.id)
            .order_by(AstrologerVerification.id)
        )
    ).scalars()
    docs = (
        await db.execute(
            select(KycDocument)
            .where(KycDocument.astrologer_id == a.id)
            .order_by(KycDocument.uploaded_at)
        )
    ).scalars()
    payouts = (
        await db.execute(select(Payout).where(Payout.astrologer_id == a.id).order_by(Payout.period))
    ).scalars()
    served = (
        await db.execute(
            select(ConsultSession)
            .where(ConsultSession.astrologer_id == a.id)
            .order_by(ConsultSession.created_at)
        )
    ).scalars()
    reviews = (
        await db.execute(
            select(Review).where(Review.astrologer_id == a.id).order_by(Review.created_at)
        )
    ).scalars()
    strikes = (
        await db.execute(
            select(AstrologerStrike)
            .where(AstrologerStrike.astrologer_id == a.id)
            .order_by(AstrologerStrike.created_at)
        )
    ).scalars()
    all_time = await earnings.totals(
        db, a.id, dt.datetime(2000, 1, 1, tzinfo=dt.UTC), _now() + dt.timedelta(days=1)
    )
    return {
        "application": {
            "id": str(a.id),
            "display_name": a.display_name,
            "slug": a.slug,
            "bio": a.bio,
            "bio_hi": a.bio_hi,
            "skills": list(a.skills),
            "languages": list(a.languages),
            "gender": a.gender,
            "experience_years": a.experience_years,
            "tier": a.tier,
            "price_per_min_paise": a.price_per_min_paise,
            "requested_price_per_min_paise": a.requested_price_per_min_paise,
            "status": a.status,
            "accepts_terms_at": _iso(a.accepts_terms_at),
            "created_at": _iso(a.created_at),
            "approved_at": _iso(a.approved_at),
            "consultation_settings": dict(a.flags or {}),
        },
        "verification_steps": [
            {"step": v.step, "status": v.status, "at": _iso(v.at)} for v in verifications
        ],
        # Listed, not embedded (the files stay in KYC storage).
        "kyc_documents": [
            {
                "id": str(d.id),
                "kind": d.kind,
                "filename": d.filename,
                "content_type": d.content_type,
                "size": d.size,
                "sha256": d.sha256,
                "uploaded_at": _iso(d.uploaded_at),
                "review_status": d.review_status,
            }
            for d in docs
        ],
        "availability": await availability_view(db, a.id),
        "earnings": {
            "all_time": all_time.as_dict(),
            "payable_paise": await wallet.account_balance(db, wallet.payable_account(a.id)),
        },
        "payouts": [payout_view(p) for p in payouts],
        "consultations_served": [
            {
                "id": str(s.id),
                "kind": s.kind,
                "status": s.status,
                "created_at": _iso(s.created_at),
                "started_at": _iso(s.started_at),
                "ended_at": _iso(s.ended_at),
                "billed_minutes": s.billed_minutes,
                "billed_paise": s.billed_paise,
            }
            for s in served
        ],
        "strikes": [
            {
                "reason": k.reason,
                "action": k.action,
                "note": k.note,
                "created_at": _iso(k.created_at),
            }
            for k in strikes
        ],
        "reviews_received": [
            {
                "rating": r.rating,
                "text": r.text,
                "status": r.status,
                "reply_text": r.reply_text,
                "created_at": _iso(r.created_at),
            }
            for r in reviews
        ],
    }


async def build_export(db: AsyncSession, settings: Settings, user_id: uuid.UUID) -> dict[str, Any]:
    """Everything we hold about the user, as one JSON-ready dict (trust.md §2)."""
    user = await db.get(User, user_id)
    if user is None or is_deleted(user):
        raise AccountDeleted
    cipher = cipher_from_settings(settings)
    return {
        "format": EXPORT_FORMAT,
        "generated_at": _iso(_now()),
        "policies_version": consent.current_version(),
        "profile": await _profile(db, user),
        "consents": await _consents(db, user_id),
        "saved_kundlis": await _kundlis(db, user_id),
        "consultations": await _consultations(db, cipher, user_id),
        "reviews": await _reviews_written(db, user_id),
        "wallet": await _wallet(db, user_id),
        "reports": await _reports(db, user_id),
        "ai_questions": await _ai_questions(db, cipher, user_id),
        "remedy_leads": await _remedy_leads(db, cipher, user_id),
        "astrologer_reports_filed": await _reports_filed(db, cipher, user_id),
        "privacy": await _privacy(db, user_id),
        "analytics_events": await _analytics(db, user_id),
        "astrologer": await _astrologer(db, user_id),
    }


def export_bytes(data: dict[str, Any]) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str).encode("utf-8")


async def complete_export(
    db: AsyncSession, settings: Settings, storage: DocumentStorage, export_id: uuid.UUID
) -> bool:
    """Build, store and mark ready (the `data_export` job). Idempotent: an export that is no
    longer queued is left alone. Returns True when a file was written. Commits."""
    export = (
        await db.execute(select(DataExport).where(DataExport.id == export_id).with_for_update())
    ).scalar_one_or_none()
    if export is None or export.status != "queued":
        return False
    try:
        data = export_bytes(await build_export(db, settings, export.user_id))
    except AccountDeleted:
        export.status = "failed"
        export.last_error_code = "account_deleted"
        await db.commit()
        return False
    key = new_key()
    await anyio.to_thread.run_sync(storage.put, key, data)
    now = _now()
    export.status = "ready"
    export.storage_key = key
    export.size_bytes = len(data)
    export.ready_at = now
    export.expires_at = now + EXPORT_FILE_TTL
    await _schedule(
        db,
        "account_cleanup",
        {"export_id": str(export.id)},
        f"export:{export.id}:expire",
        export.expires_at,
    )
    audit(db, SYSTEM_ACTOR, "privacy.export.ready", "data_export", str(export.id))
    try:
        await db.commit()
    except Exception:
        await anyio.to_thread.run_sync(
            storage.delete, key
        )  # never leave an unreferenced copy of someone's data behind
        raise
    return True


async def fail_export(db: AsyncSession, export_id: uuid.UUID, code: str) -> None:
    await db.execute(
        update(DataExport)
        .where(DataExport.id == export_id, DataExport.status == "queued")
        .values(status="failed", last_error_code=code[:64])
    )
    await db.commit()


async def expire_export(
    db: AsyncSession, storage: DocumentStorage, export_id: uuid.UUID, now: dt.datetime | None = None
) -> bool:
    """Remove an export's file once it is due (`account_cleanup` with `export_id`). Commits."""
    now = now or _now()
    export = (
        await db.execute(select(DataExport).where(DataExport.id == export_id).with_for_update())
    ).scalar_one_or_none()
    if export is None or export.storage_key is None:
        return False
    if export.expires_at is not None and export.expires_at > now:
        return False
    await anyio.to_thread.run_sync(storage.delete, export.storage_key)
    export.storage_key = None
    export.status = "expired"
    audit(db, SYSTEM_ACTOR, "privacy.export.expired", "data_export", str(export.id))
    await db.commit()
    return True


# ------------------------------------------------------------------ deletion: request / cancel


async def open_deletion(db: AsyncSession, user_id: uuid.UUID) -> DeletionRequest | None:
    found: DeletionRequest | None = (
        await db.execute(
            select(DeletionRequest).where(
                DeletionRequest.user_id == user_id, DeletionRequest.status == "requested"
            )
        )
    ).scalar_one_or_none()
    return found


async def request_deletion(db: AsyncSession, user: User) -> DeletionRequest:
    """Open a request, or return the open one. Caller commits."""
    did = uuid.uuid4()
    inserted = (
        await db.execute(
            pg_insert(DeletionRequest)
            .values(id=did, user_id=user.id, status="requested", pending_files=[])
            .on_conflict_do_nothing(
                index_elements=["user_id"], index_where=DeletionRequest.status == "requested"
            )
            .returning(DeletionRequest.id)
        )
    ).scalar_one_or_none()
    if inserted is not None:
        audit(db, f"user:{user.id}", "privacy.deletion.request", "deletion_request", str(did))
    found = await open_deletion(db, user.id)
    assert found is not None
    return found


async def cancel_deletion(db: AsyncSession, user: User) -> DeletionRequest | None:
    d = (
        await db.execute(
            select(DeletionRequest)
            .where(DeletionRequest.user_id == user.id, DeletionRequest.status == "requested")
            .with_for_update()
        )
    ).scalar_one_or_none()
    if d is None:
        return None
    d.status = "cancelled"
    d.cancelled_at = _now()
    audit(db, f"user:{user.id}", "privacy.deletion.cancel", "deletion_request", str(d.id))
    await db.flush()
    return d


# ------------------------------------------------------------------ deletion: execute


@dataclass
class DeletionResult:
    request: DeletionRequest
    astrologer_id: uuid.UUID | None
    summary: dict[str, Any] = field(default_factory=dict)


async def open_session_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Open consultations of the account, as the client or (for astrologers) as the astrologer."""
    astrologer_id = select(Astrologer.id).where(Astrologer.user_id == user_id).scalar_subquery()
    q = (
        select(func.count())
        .select_from(ConsultSession)
        .where(
            (ConsultSession.user_id == user_id) | (ConsultSession.astrologer_id == astrologer_id),
            ConsultSession.status.in_(OPEN_SESSION_STATUSES),
        )
    )
    return int((await db.execute(q)).scalar_one())


async def _check_executable(
    db: AsyncSession, user_id: uuid.UUID, astrologer_id: uuid.UUID | None
) -> None:
    """Refuse (nothing written) while a consultation is open, money is outstanding or paid work
    is still queued. Locks the user's balance rows (and the astrologer's payable row)."""
    who = ConsultSession.user_id == user_id
    if astrologer_id is not None:
        who = who | (ConsultSession.astrologer_id == astrologer_id)
    open_ids = (
        await db.execute(
            select(ConsultSession.id)
            .where(who, ConsultSession.status.in_(OPEN_SESSION_STATUSES))
            .order_by(ConsultSession.created_at)
        )
    ).scalars()
    if found := [str(i) for i in open_ids]:
        raise SessionOpen(found)
    real, _promo = await wallet.lock_user(db, user_id)
    payable = await wallet.lock_payable(db, astrologer_id) if astrologer_id is not None else 0
    if real != 0 or payable != 0:
        raise BalanceOutstanding(real, payable)
    pending = []
    if (
        await db.execute(
            select(Report.id)
            .where(Report.user_id == user_id, Report.status.in_(("queued", "rendering")))
            .limit(1)
        )
    ).first():
        pending.append("report")
    if (
        await db.execute(
            select(AiQuestion.id)
            .where(AiQuestion.user_id == user_id, AiQuestion.status == "queued")
            .limit(1)
        )
    ).first():
        pending.append("ai_question")
    if (
        await db.execute(
            select(DataExport.id)
            .where(DataExport.user_id == user_id, DataExport.status == "queued")
            .limit(1)
        )
    ).first():
        pending.append("export")
    if pending:
        raise WorkPending(pending)


async def _forfeit_promo(db: AsyncSession, user_id: uuid.UUID) -> tuple[list[str], int]:
    """Leftover promo credit has no cash value and lapses with the account: posted as the normal
    expiry (`promo_lot:{id}:expire`, debit user promo, credit platform:promo_expired)."""
    lot_ids = list(
        (
            await db.execute(
                select(PromoLot.id)
                .where(PromoLot.user_id == user_id, PromoLot.remaining_paise > 0)
                .order_by(PromoLot.id)
            )
        ).scalars()
    )
    if not lot_ids:
        return [], 0
    amount = await wallet._expire_lots(db, lot_ids, due=None)  # the ledger's own expiry
    return [str(i) for i in lot_ids], amount


async def _count(db: AsyncSession, stmt: Any) -> int:
    result = await db.execute(stmt)
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def execute_deletion(
    db: AsyncSession, deletion_id: uuid.UUID, *, actor: str, settings: Settings
) -> DeletionResult:
    """Anonymise the account in the caller's transaction (the caller commits once). Raises
    before writing anything when the request is not open or `_check_executable` refuses.

    Kept: the users row (anonymised: tombstone phone, no devices, roles or locale), consents,
    every ledger row, consultations (money facts), reviews (now pointing at the anonymised
    user), report orders/reports without their personal parts, recharge orders, payouts,
    free-session claims (HMACs), audit entries, KYC documents (flagged for review).
    Deleted: saved kundlis (with their AI conversations), AI questions, chat messages of the
    user's own consultations, remedy leads, analytics events (with the user's id, or with an
    anonymous id ever linked to the user); report and export files via `account_cleanup`.
    """
    d = (
        await db.execute(
            select(DeletionRequest).where(DeletionRequest.id == deletion_id).with_for_update()
        )
    ).scalar_one_or_none()
    if d is None:
        raise DeletionNotFound
    if d.status != "requested":
        raise DeletionNotOpen(d.status)
    user = (
        await db.execute(select(User).where(User.id == d.user_id).with_for_update())
    ).scalar_one()
    uid = user.id
    a = (
        await db.execute(select(Astrologer).where(Astrologer.user_id == uid).with_for_update())
    ).scalar_one_or_none()
    await _check_executable(db, uid, a.id if a else None)
    now = _now()
    entity = ("deletion_request", str(d.id))

    def step(action: str, **detail: Any) -> None:
        audit(db, actor, f"privacy.deletion.{action}", *entity, user_id=str(uid), **detail)

    # 1. Money: promo credit forfeited through the ledger; nothing else in the ledger changes.
    lots, forfeited = await _forfeit_promo(db, uid)
    step("promo_forfeit", lot_ids=lots, amount_paise=forfeited)

    # 2. Sign-in: every token revoked, device ids dropped.
    revoked = await _count(
        db,
        update(AuthSession)
        .where(AuthSession.user_id == uid, AuthSession.revoked_at.is_(None))
        .values(revoked_at=now),
    )
    await db.execute(update(AuthSession).where(AuthSession.user_id == uid).values(device_id=None))
    step("sign_in_revoked", sessions=revoked)

    # 3. Content deleted with the account.
    my_sessions = select(ConsultSession.id).where(ConsultSession.user_id == uid)
    messages = await _count(db, delete(ChatMessage).where(ChatMessage.session_id.in_(my_sessions)))
    questions = await _count(db, delete(AiQuestion).where(AiQuestion.user_id == uid))
    await db.execute(delete(AiConversation).where(AiConversation.user_id == uid))
    kundlis = await _count(db, delete(SavedKundli).where(SavedKundli.user_id == uid))
    leads = await _count(db, delete(RemedyLead).where(RemedyLead.user_id == uid))
    # Analytics: the user's events, and every event of an anonymous id ever linked to the user
    # (any row carrying both), so the pre-sign-in browsing goes too (growth.md §1.2).
    linked = select(AnalyticsEvent.anonymous_id).where(AnalyticsEvent.user_id == uid)
    analytics_events = await _count(
        db,
        delete(AnalyticsEvent).where(
            (AnalyticsEvent.user_id == uid) | AnalyticsEvent.anonymous_id.in_(linked)
        ),
    )
    # Reports the user filed stay in the moderation record (reason, status), without the note.
    report_notes = await _count(
        db,
        update(ModerationEvent)
        .where(
            ModerationEvent.reporter_user_id == uid, ModerationEvent.note_ciphertext.is_not(None)
        )
        .values(note_ciphertext=None, note_nonce=None, note_key_id=None),
    )
    step(
        "content_deleted",
        chat_messages=messages,
        ai_questions=questions,
        saved_kundlis=kundlis,
        remedy_leads=leads,
        report_notes=report_notes,
        analytics_events=analytics_events,
    )

    # 4. Reports and exports: rows kept (purchase record), personal parts erased, files queued.
    files: list[dict[str, Any]] = []
    reports = list((await db.execute(select(Report).where(Report.user_id == uid))).scalars())
    for r in reports:
        if r.storage_key:
            files.append({"kind": "report", "id": str(r.id), "key": r.storage_key})
        r.storage_key = None
        r.snapshot = {}
    await db.execute(
        update(ReportOrder)
        .where(ReportOrder.user_id == uid)
        .values(snapshot=None, email_ciphertext=None, email_nonce=None, email_key_id=None)
    )
    exports = list(
        (await db.execute(select(DataExport).where(DataExport.user_id == uid))).scalars()
    )
    for e in exports:
        if e.storage_key:
            files.append({"kind": "export", "id": str(e.id), "key": e.storage_key})
        e.storage_key = None
        if e.status in ("ready", "queued"):
            e.status = "expired"
    step(
        "files_queued",
        report_ids=[f["id"] for f in files if f["kind"] == "report"],
        export_ids=[f["id"] for f in files if f["kind"] == "export"],
    )

    # 5. Reviews stay (the astrologer's rating) on the anonymised user.
    reviews = list((await db.execute(select(Review.id).where(Review.user_id == uid))).scalars())
    step("reviews_anonymised", review_ids=[str(i) for i in reviews])

    # 6. Astrologer profile hidden; schedule removed; KYC kept for a retention review.
    kyc_ids: list[str] = []
    if a is not None:
        a.display_name = "Former astrologer"
        a.bio = ""
        a.bio_hi = None
        if a.status != "suspended":
            a.status_before_suspension = a.status
        a.status = "suspended"
        a.suspended_reason = "account_deleted"
        a.flags = {
            **(a.flags or {}),
            "show_in_directory": False,
            "chat_enabled": False,
            "call_enabled": False,
        }
        await db.execute(
            delete(AstrologerAvailability).where(AstrologerAvailability.astrologer_id == a.id)
        )
        kyc_ids = [
            str(i)
            for i in (
                await db.execute(select(KycDocument.id).where(KycDocument.astrologer_id == a.id))
            ).scalars()
        ]
        step("astrologer_hidden", astrologer_id=str(a.id), kyc_document_ids=kyc_ids)

    # 7. Admin free-text notes about the user.
    await db.execute(
        update(FreeSessionOverride).where(FreeSessionOverride.user_id == uid).values(note=None)
    )

    # 8. The user row: phone tombstoned (the number can sign up again), the rest cleared.
    user.phone = tombstone(settings, user.phone, uid)
    user.device_ids = []
    user.roles = []
    user.locale = "en"
    user.last_login_at = None

    d.status = "executed"
    d.executed_at = now
    d.executed_by = actor
    d.pending_files = files
    d.kyc_review_required = bool(kyc_ids)
    await db.flush()
    await jobs.enqueue(
        db, "account_cleanup", {"deletion_id": str(d.id)}, f"deletion:{d.id}:cleanup"
    )
    summary = {
        "promo_forfeited_paise": forfeited,
        "files_pending": len(files),
        "kyc_review_required": d.kyc_review_required,
    }
    step("execute", **summary)
    return DeletionResult(request=d, astrologer_id=a.id if a else None, summary=summary)


async def cleanup_deletion_files(
    db: AsyncSession, storage: DocumentStorage, deletion_id: uuid.UUID
) -> int:
    """Remove the files an executed deletion listed (`account_cleanup` with `deletion_id`).
    Idempotent: storage deletes ignore missing files and the list is cleared at the end.
    KYC files are never listed here (kept until the retention decision). Commits."""
    d = (
        await db.execute(
            select(DeletionRequest).where(DeletionRequest.id == deletion_id).with_for_update()
        )
    ).scalar_one_or_none()
    if d is None or d.status != "executed" or not d.pending_files:
        return 0
    removed = 0
    for item in d.pending_files:
        await anyio.to_thread.run_sync(storage.delete, str(item["key"]))
        removed += 1
    d.pending_files = []
    d.files_cleaned_at = _now()
    audit(
        db,
        SYSTEM_ACTOR,
        "privacy.deletion.files_removed",
        "deletion_request",
        str(d.id),
        user_id=str(d.user_id),
        files=removed,
    )
    await db.commit()
    return removed
