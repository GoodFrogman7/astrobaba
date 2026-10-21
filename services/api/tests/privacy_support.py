"""Shared helpers for the consent and privacy tests (test_consent*.py, test_privacy*.py)."""

import asyncio
import datetime as dt
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from astro_api import ai_api, wallet
from astro_api.chat_crypto import aad, cipher_from_settings
from astro_api.config import Settings
from astro_api.db import make_sessionmaker
from astro_api.models import ConsultSession, Review, SavedKundli, User
from astro_api.models_ai import AiConversation, AiQuestion
from astro_api.models_ledger import FreeSessionClaim
from astro_api.models_remedies import RemedyLead, note_aad
from astro_api.models_reports import Report, ReportOrder
from astro_api.models_safety import ModerationEvent, report_note_aad
from astro_api.models_sessions import ChatMessage
from astro_api.storage import DocumentStorage, new_key

USER_KINDS = ["age_18", "terms", "privacy"]


def run_db(client: TestClient, fn: Callable[[AsyncSession], Awaitable[Any]]) -> Any:
    """Run `fn(db)` in a fresh database session against the app's database."""

    async def go() -> Any:
        url = client.app.state.settings.database_url.get_secret_value()  # type: ignore[attr-defined]
        engine = create_async_engine(url)
        try:
            async with make_sessionmaker(engine)() as db:
                return await fn(db)
        finally:
            await engine.dispose()

    return asyncio.run(go())


def legal_version(client: TestClient) -> str:
    version: str = client.get("/v1/legal").json()["version"]
    return version


def accept(
    client: TestClient, headers: dict[str, str], kinds: list[str], version: str | None = None
) -> Any:
    return client.post(
        "/v1/me/consents",
        json={"version": version or legal_version(client), "kinds": kinds},
        headers=headers,
    )


def idem(headers: dict[str, str]) -> dict[str, str]:
    return {**headers, "Idempotency-Key": uuid.uuid4().hex}


def user_id(client: TestClient, headers: dict[str, str]) -> uuid.UUID:
    return uuid.UUID(client.get("/v1/me", headers=headers).json()["id"])


# ------------------------------------------------------------------ a client with data everywhere

USER_PHONE = "+919833300001"
OTHER_PHONE = "+919833300002"
MY_MESSAGE = "My own question about career, born in Pune"
ASTRO_MESSAGE = "Thanks for asking, let us look at your chart"
OTHER_MESSAGE = "Other client's private message 7788"
AI_TEXT = "Will my exam go well?"
AI_ANSWER = "Your chart shows Jupiter in the 5th house."
LEAD_NOTE = "Call after 6 pm please"
REPORT_NOTE = "He asked me to pay on another app"
REPORT_PDF = b"%PDF-1.4\n% privacy test report\n%%EOF\n"


@dataclass
class World:
    user_id: uuid.UUID
    other_id: uuid.UUID
    astrologer_id: uuid.UUID
    session_id: uuid.UUID
    other_session_id: uuid.UUID
    kundli_id: uuid.UUID
    question_id: uuid.UUID
    lead_id: uuid.UUID
    order_id: uuid.UUID
    report_id: uuid.UUID
    report_key: str
    review_id: uuid.UUID
    lot_id: uuid.UUID
    moderation_id: uuid.UUID


async def _user(db: AsyncSession, phone: str) -> User:
    return (await db.execute(select(User).where(User.phone == phone))).scalar_one()


async def _session_with_messages(
    db: AsyncSession,
    settings: Settings,
    user_id: uuid.UUID,
    astrologer_id: uuid.UUID,
    texts: list[tuple[str, str]],
) -> uuid.UUID:
    now = dt.datetime.now(dt.UTC)
    s = ConsultSession(
        user_id=user_id,
        astrologer_id=astrologer_id,
        kind="chat",
        status="completed",
        started_at=now - dt.timedelta(minutes=10),
        ended_at=now - dt.timedelta(minutes=5),
        price_per_min_paise=1000,
        commission_bps=3000,
        last_seq=len(texts),
        end_reason="user_ended",
    )
    db.add(s)
    await db.flush()
    cipher = cipher_from_settings(settings)
    for seq, (sender, body) in enumerate(texts, start=1):
        sealed = cipher.encrypt(body, aad(s.id, seq))
        db.add(
            ChatMessage(
                session_id=s.id,
                seq=seq,
                sender=sender,
                ciphertext=sealed.ciphertext,
                nonce=sealed.nonce,
                key_id=sealed.key_id,
            )
        )
    await db.flush()
    return s.id


async def build_world(
    db: AsyncSession, settings: Settings, storage: DocumentStorage, astrologer_id: uuid.UUID
) -> World:
    """USER_PHONE and OTHER_PHONE must already exist (login). Gives USER_PHONE a saved kundli, a
    completed chat paid with promo credit (promo left over), a review, an answered AI question, a
    remedy lead with a note, a ready report with its file and a free-session claim. OTHER_PHONE
    gets a chat with the same astrologer."""
    user = await _user(db, USER_PHONE)
    other = await _user(db, OTHER_PHONE)
    now = dt.datetime.now(dt.UTC)
    k = SavedKundli(
        user_id=user.id,
        name="Ravi Kumar",
        gender="male",
        birth_date=dt.date(1990, 5, 17),
        birth_time=dt.time(6, 30),
        unknown_time=False,
        birth_datetime_utc=dt.datetime(1990, 5, 17, 1, 0, tzinfo=dt.UTC),
        tz="Asia/Kolkata",
        utc_offset="+05:30",
        lat=18.52,
        lon=73.86,
        place_label="Pune, Maharashtra",
    )
    db.add(k)
    await db.flush()
    sid = await _session_with_messages(
        db,
        settings,
        user.id,
        astrologer_id,
        [("user", MY_MESSAGE), ("astrologer", ASTRO_MESSAGE), ("system", "session_ended")],
    )
    other_sid = await _session_with_messages(
        db, settings, other.id, astrologer_id, [("user", OTHER_MESSAGE)]
    )
    review = Review(
        session_id=sid,
        astrologer_id=astrologer_id,
        user_id=user.id,
        rating=5,
        text="Calm and clear",
        status="published",
    )
    db.add(review)
    # Money: a promo lot, one minute spent from it, the rest left over (forfeited on deletion).
    lot = await wallet.grant_promo(
        db,
        user_id=user.id,
        amount_paise=5000,
        campaign="test",
        key=f"promo:test:{user.id}",
        expires_at=now + dt.timedelta(days=30),
    )
    await wallet.charge_minute(
        db,
        session_id=sid,
        user_id=user.id,
        astrologer_id=astrologer_id,
        minute=1,
        price_paise=1000,
        commission_bps=3000,
    )
    conv = AiConversation(user_id=user.id, kundli_id=k.id)
    db.add(conv)
    await db.flush()
    cipher = cipher_from_settings(settings)
    qid = uuid.uuid4()
    ct, nonce, kid = ai_api.seal_text(cipher, qid, AI_TEXT)
    answer = cipher.encrypt(AI_ANSWER, f"ai-question:{qid}:answer".encode())
    db.add(
        AiQuestion(
            id=qid,
            conversation_id=conv.id,
            user_id=user.id,
            idempotency_key="q" * 12,
            request_hash="h",
            text_ciphertext=ct,
            text_nonce=nonce,
            text_key_id=kid,
            language="en",
            status="answered",
            answer_ciphertext=answer.ciphertext,
            answer_nonce=answer.nonce,
            answer_key_id=answer.key_id,
            price_paise=0,
            answered_at=now,
        )
    )
    lead_id = uuid.uuid4()
    note = cipher.encrypt(LEAD_NOTE, note_aad(lead_id))
    db.add(
        RemedyLead(
            id=lead_id,
            user_id=user.id,
            idempotency_key="l" * 12,
            remedy_id="ganesh-puja",
            partner_id="demo-partner",
            language="en",
            phone=USER_PHONE,
            note_ciphertext=note.ciphertext,
            note_nonce=note.nonce,
            note_key_id=note.key_id,
            consent_at=now,
        )
    )
    order_id, report_id, key = uuid.uuid4(), uuid.uuid4(), new_key()
    email = cipher.encrypt("ravi@example.com", f"report_order:{order_id}:email".encode())
    db.add(
        ReportOrder(
            id=order_id,
            user_id=user.id,
            idempotency_key="o" * 12,
            sku="kundli_report",
            language="en",
            kundli_ids=[k.id],
            pay_with="razorpay",
            price_paise=49900,
            currency="INR",
            status="paid",
            snapshot=None,
            engine_version="test",
            email_ciphertext=email.ciphertext,
            email_nonce=email.nonce,
            email_key_id=email.key_id,
            report_id=report_id,
            paid_at=now,
        )
    )
    await db.flush()
    storage.put(key, REPORT_PDF)
    db.add(
        Report(
            id=report_id,
            user_id=user.id,
            order_id=order_id,
            sku="kundli_report",
            language="en",
            status="ready",
            snapshot={"birth": {"name": "Ravi Kumar", "place": "Pune"}},
            engine_version="test",
            storage_key=key,
            pages=16,
            size_bytes=len(REPORT_PDF),
            render_job_key=f"report:{report_id}:render",
            ready_at=now,
        )
    )
    report_id_ = uuid.uuid4()
    rnote = cipher.encrypt(REPORT_NOTE, report_note_aad(report_id_))
    db.add(
        ModerationEvent(
            id=report_id_,
            kind="report",
            status="open",
            reason="off_platform",
            astrologer_id=astrologer_id,
            session_id=sid,
            reporter_user_id=user.id,
            idempotency_key="r" * 12,
            note_ciphertext=rnote.ciphertext,
            note_nonce=rnote.nonce,
            note_key_id=rnote.key_id,
        )
    )
    db.add(
        FreeSessionClaim(
            user_id=user.id,
            session_id=sid,
            device_hash="d" * 64,
            ip_hash="i" * 64,
            ip_day=now.date(),
        )
    )
    await db.commit()
    return World(
        user_id=user.id,
        other_id=other.id,
        astrologer_id=astrologer_id,
        session_id=sid,
        other_session_id=other_sid,
        kundli_id=k.id,
        question_id=qid,
        lead_id=lead_id,
        order_id=order_id,
        report_id=report_id,
        report_key=key,
        review_id=review.id,
        lot_id=lot.lot_id,
        moderation_id=report_id_,
    )


def make_world(client: TestClient, astrologer_id: str) -> World:
    settings = client.app.state.settings  # type: ignore[attr-defined]
    storage = client.app.state.storage  # type: ignore[attr-defined]
    world: World = run_db(
        client, lambda db: build_world(db, settings, storage, uuid.UUID(astrologer_id))
    )
    return world
