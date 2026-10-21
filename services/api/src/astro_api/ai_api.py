"""AI assistant (docs/api/revenue.md §3; flag ai_assistant; ADR-0010).

Money: a question that may go to the LLM is charged (`wallet.charge_purchase`, key
`ai:{id}:charge`) in the same transaction as its row and its `ai_answer` job
(`ai:{id}:answer`). The worker settles it exactly once with `settle`: answered keeps the charge;
blocked or failed refunds it (`wallet.refund_purchase`, key `refund:ai:{id}`). Questions the
pre-LLM classifier blocks are never charged and never queued, so they also work with an empty
wallet (a person in crisis must not be asked to recharge first).

Privacy: question and answer text are AES-256-GCM ciphertext at rest (chat key set), bound to
the row and field by the AAD; job payloads hold ids only; nothing here logs text.
"""

import datetime as dt
import json
import uuid
from functools import cache
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import ai_safety, jobs, wallet
from astro_api.auth import CurrentUser
from astro_api.chat_crypto import MessageCipher, Sealed, cipher_from_settings
from astro_api.consent import RequireUserConsent
from astro_api.db import Db, redis_of, settings_of
from astro_api.errors import ApiError
from astro_api.flags import flag_enabled
from astro_api.idempotency import Idempotency, body_hash, idempotency_key
from astro_api.models import SavedKundli
from astro_api.models_ai import AiConversation, AiQuestion
from astro_api.shared_files import marketplace_dir

FLAG = "ai_assistant"
PRODUCT = "ai_question"


async def _flag_on() -> None:
    if not flag_enabled(FLAG):
        raise ApiError(404, "not_found", "Not found.")


router = APIRouter(prefix="/v1/ai", tags=["ai"], dependencies=[Depends(_flag_on)])


@cache
def _product() -> dict[str, Any]:
    raw = json.loads((marketplace_dir() / "products.json").read_text(encoding="utf-8"))
    product: dict[str, Any] = raw[PRODUCT]
    return product


def price_paise() -> int:
    return int(_product()["price_paise"])


def max_chars() -> int:
    return int(_product()["max_chars"])


def charge_key(question_id: uuid.UUID) -> str:
    return f"ai:{question_id}:charge"


def refund_key(question_id: uuid.UUID) -> str:
    return f"refund:ai:{question_id}"


def answer_job_key(question_id: uuid.UUID) -> str:
    return f"ai:{question_id}:answer"


# ------------------------------------------------------------------ encryption at rest


def _aad(question_id: uuid.UUID, field: str) -> bytes:
    return f"ai-question:{question_id}:{field}".encode()


def seal_text(cipher: MessageCipher, question_id: uuid.UUID, text: str) -> tuple[bytes, bytes, str]:
    s = cipher.encrypt(text, _aad(question_id, "text"))
    return s.ciphertext, s.nonce, s.key_id


def open_text(cipher: MessageCipher, q: AiQuestion) -> str:
    return cipher.decrypt(
        Sealed(q.text_ciphertext, q.text_nonce, q.text_key_id), _aad(q.id, "text")
    )


def open_answer(cipher: MessageCipher, q: AiQuestion) -> str | None:
    if q.answer_ciphertext is None or q.answer_nonce is None or q.answer_key_id is None:
        return None
    return cipher.decrypt(
        Sealed(q.answer_ciphertext, q.answer_nonce, q.answer_key_id), _aad(q.id, "answer")
    )


def cipher_of(request: Request) -> MessageCipher:
    state = request.app.state
    cipher: MessageCipher | None = getattr(state, "chat_cipher", None)
    if cipher is None:
        cipher = cipher_from_settings(settings_of(request))
        state.chat_cipher = cipher
    return cipher


# ------------------------------------------------------------------ views


def _iso(v: dt.datetime | None) -> str | None:
    return v.astimezone(dt.UTC).isoformat() if v is not None else None


def question_view(cipher: MessageCipher, q: AiQuestion) -> dict[str, Any]:
    """`AiQuestion` (revenue.md §3) plus `label`, `handoff` and `notice` for the UI."""
    return {
        "id": str(q.id),
        "text": open_text(cipher, q),
        "status": q.status,
        "answer": open_answer(cipher, q),
        "blocked_reason": q.blocked_reason,
        "created_at": _iso(q.created_at),
        "answered_at": _iso(q.answered_at),
        "price_paise": q.price_paise,
        "refunded": q.refunded,
        "language": q.language,
        "label": q.ai_label or ai_safety.AI_LABEL[q.language],
        "handoff": q.handoff or ai_safety.HANDOFF[q.language],
        "notice": q.notice,
    }


# ------------------------------------------------------------------ service functions


async def _own_conversation(
    db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID
) -> AiConversation:
    c = await db.get(AiConversation, conversation_id)
    if c is None or c.user_id != user_id:  # other users' ids look exactly like missing ones
        raise ApiError(404, "not_found", "Conversation not found.")
    return c


async def ask(
    db: AsyncSession,
    cipher: MessageCipher,
    *,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    text: str,
    key: str,
    request_hash: str | None = None,
) -> AiQuestion:
    """Create a question (idempotent on (user, key)) and commit. Blocked questions are stored
    uncharged; others are charged and queued in the same transaction. Raises ApiError (404, 402,
    409)."""
    request_hash = request_hash or body_hash({"text": text})
    previous = await _replay(db, user_id, conversation_id, key, request_hash)
    if previous is not None:
        return previous
    await _own_conversation(db, user_id, conversation_id)

    language = ai_safety.detect_language(text)
    verdict = ai_safety.classify(text)
    qid = uuid.uuid4()
    ct, nonce, key_id = seal_text(cipher, qid, text)
    q = AiQuestion(
        id=qid,
        conversation_id=conversation_id,
        user_id=user_id,
        idempotency_key=key,
        request_hash=request_hash,
        text_ciphertext=ct,
        text_nonce=nonce,
        text_key_id=key_id,
        language=language,
        status="queued",
        price_paise=price_paise(),
        refunded=False,
    )
    blocked = verdict.reason is not None and verdict.kind is not None
    if verdict.reason is not None and verdict.kind is not None:
        q.status = "blocked"
        q.blocked_reason = verdict.reason
        q.notice = ai_safety.notice(verdict.kind, language)
        q.ai_label = ai_safety.AI_LABEL[language]
        q.handoff = ai_safety.HANDOFF[language]
        q.price_paise = 0
        q.prompt_version = "classifier"
    try:
        db.add(q)
        await db.flush()
        if not blocked:
            await _charge_and_queue(db, q)
        await db.commit()
    except IntegrityError:
        # The same key raced in from another request (UNIQUE(user_id, idempotency_key)); our
        # charge and job rolled back with it, so return the winner.
        await db.rollback()
        winner = await _replay(db, user_id, conversation_id, key, request_hash)
        if winner is None:
            raise
        return winner
    return q


async def _charge_and_queue(db: AsyncSession, q: AiQuestion) -> None:
    """Charge and enqueue in the caller's transaction (the question row is already flushed)."""
    try:
        await wallet.charge_purchase(
            db,
            user_id=q.user_id,
            key=charge_key(q.id),
            product=PRODUCT,
            ref_id=str(q.id),
            amount_paise=q.price_paise,
        )
    except wallet.InsufficientFunds:
        await db.rollback()
        available = (await wallet.balances(db, q.user_id)).total_paise
        raise ApiError(
            402,
            "insufficient_funds",
            "Recharge your wallet to ask the AI assistant.",
            required_paise=price_paise(),
            available_paise=available,
        ) from None
    await jobs.enqueue(
        db,
        "ai_answer",
        {"question_id": str(q.id), "user_id": str(q.user_id)},
        answer_job_key(q.id),
    )


async def _replay(
    db: AsyncSession, user_id: uuid.UUID, conversation_id: uuid.UUID, key: str, request_hash: str
) -> AiQuestion | None:
    previous = (
        await db.execute(
            select(AiQuestion).where(
                AiQuestion.user_id == user_id, AiQuestion.idempotency_key == key
            )
        )
    ).scalar_one_or_none()
    if previous is not None and (
        previous.request_hash != request_hash or previous.conversation_id != conversation_id
    ):
        raise ApiError(
            409, "idempotency_conflict", "This Idempotency-Key was used for another request."
        )
    return previous


async def settle(
    db: AsyncSession,
    question_id: uuid.UUID,
    *,
    status: str,
    cipher: MessageCipher | None = None,
    answer: str | None = None,
    blocked_reason: str | None = None,
    notice_kind: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    error_code: str | None = None,
) -> bool:
    """Decide a queued question exactly once and commit: `answered` (keeps the charge),
    `blocked` or `failed` (refund to the same buckets, key `refund:ai:{id}`). Returns False when
    the question is gone or already decided (nothing changes)."""
    q = (
        await db.execute(select(AiQuestion).where(AiQuestion.id == question_id).with_for_update())
    ).scalar_one_or_none()
    if q is None or q.status != "queued":
        await db.rollback()
        return False
    now = dt.datetime.now(dt.UTC)
    q.status = status
    q.ai_label = ai_safety.AI_LABEL[q.language]
    q.handoff = ai_safety.HANDOFF[q.language]
    q.model, q.prompt_version, q.error_code = model, prompt_version, error_code
    if status == "answered":
        assert cipher is not None and answer is not None
        s = cipher.encrypt(answer, _aad(q.id, "answer"))
        q.answer_ciphertext, q.answer_nonce, q.answer_key_id = s.ciphertext, s.nonce, s.key_id
        q.answered_at = now
    else:
        if status == "blocked":
            q.blocked_reason = blocked_reason or "other"
        refunded = await refund(db, q.user_id, q.id) if q.price_paise > 0 else False
        q.refunded = refunded
        q.refunded_at = now if refunded else None
        q.notice = ai_safety.notice(notice_kind or "failed", q.language, refunded=refunded)
    await db.commit()
    return True


async def refund(db: AsyncSession, user_id: uuid.UUID, question_id: uuid.UUID) -> bool:
    """Full refund of a question's charge (idempotent on its key). False if it was never
    charged. Caller commits."""
    try:
        await wallet.refund_purchase(
            db, user_id=user_id, key=refund_key(question_id), original_key=charge_key(question_id)
        )
    except LookupError:
        return False
    return True


# ------------------------------------------------------------------ endpoints


class ConversationIn(BaseModel):
    kundli_id: uuid.UUID


class QuestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)


def _conversation_out(c: AiConversation) -> dict[str, Any]:
    return {"id": str(c.id), "kundli_id": str(c.kundli_id), "created_at": _iso(c.created_at)}


@router.get("/pricing")
async def pricing() -> dict[str, Any]:
    """Public. 404 like everything else here while the flag is off, so `enabled` is always
    true when it answers."""
    return {"price_paise": price_paise(), "max_chars": max_chars(), "enabled": True}


@router.get("/conversations")
async def list_conversations(user: CurrentUser, db: Db) -> dict[str, Any]:
    """Own conversations, newest first; `questions` is how many each holds."""
    counts = (
        select(AiQuestion.conversation_id, func.count().label("n"))
        .group_by(AiQuestion.conversation_id)
        .subquery()
    )
    rows = await db.execute(
        select(AiConversation, SavedKundli.name, func.coalesce(counts.c.n, 0))
        .join(SavedKundli, SavedKundli.id == AiConversation.kundli_id)
        .outerjoin(counts, counts.c.conversation_id == AiConversation.id)
        .where(AiConversation.user_id == user.id)
        .order_by(AiConversation.created_at.desc(), AiConversation.id.desc())
    )
    return {
        "items": [
            {**_conversation_out(c), "kundli_label": name, "questions": int(n)}
            for c, name, n in rows.all()
        ]
    }


@router.post("/conversations", status_code=201)
async def create_conversation(body: ConversationIn, user: CurrentUser, db: Db) -> dict[str, Any]:
    k = await db.get(SavedKundli, body.kundli_id)
    if k is None or k.user_id != user.id:
        raise ApiError(404, "kundli_not_found", "Kundli not found.")
    c = AiConversation(user_id=user.id, kundli_id=k.id)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _conversation_out(c)


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: uuid.UUID, request: Request, user: CurrentUser, db: Db
) -> dict[str, Any]:
    c = await _own_conversation(db, user.id, conversation_id)
    k = await db.get(SavedKundli, c.kundli_id)
    assert k is not None  # conversations are deleted with their kundli
    rows = (
        await db.execute(
            select(AiQuestion)
            .where(AiQuestion.conversation_id == c.id)
            .order_by(AiQuestion.created_at, AiQuestion.id)
        )
    ).scalars()
    cipher = cipher_of(request)
    return {
        **_conversation_out(c),
        "label": ai_safety.AI_LABEL["en"],
        "labels": ai_safety.AI_LABEL,
        "kundli": {
            "id": str(k.id),
            "name": k.name,
            "label": k.name,
            "unknown_time": k.unknown_time,
        },
        "questions": [question_view(cipher, q) for q in rows],
    }


@router.post(
    "/conversations/{conversation_id}/questions",
    status_code=202,
    dependencies=[RequireUserConsent],
)
async def create_question(
    conversation_id: uuid.UUID,
    body: QuestionIn,
    request: Request,
    user: CurrentUser,
    db: Db,
    key: Annotated[str, Depends(idempotency_key)],
) -> JSONResponse:
    text = body.text.strip()
    if not text or len(text) > max_chars():
        raise ApiError(422, "invalid_text", f"Ask in 1-{max_chars()} characters.")
    payload = {"conversation_id": str(conversation_id), "text": text}
    idem = Idempotency(redis_of(request), scope=f"ai:{user.id}", key=key, payload=payload)
    if (hit := await idem.begin()) is not None:
        return JSONResponse(hit.body, status_code=hit.status)
    try:
        cipher = cipher_of(request)
        q = await ask(
            db,
            cipher,
            user_id=user.id,
            conversation_id=conversation_id,
            text=text,
            key=key,
            request_hash=body_hash(payload),
        )
        out = question_view(cipher, q)
    except BaseException:
        await idem.abandon()
        raise
    await idem.finish(202, out)
    return JSONResponse(out, status_code=202)
