"""ai_answer jobs (docs/api/revenue.md §3, ADR-0010). Written before the handler (money paths).

Engine responses are the recorded fixtures (services/api/tests/fixtures/ai_engine_*.json, made by
record_ai_engine.py); LLMs are the FakeProvider or scripted fakes. No network calls.

- valid answer -> answered, encrypted, labelled, still charged once
- invalid twice -> blocked (other) + refund; invalid once -> retried with the errors
- LLM error on every attempt -> failed + refund via on_failed
- every refund happens exactly once, however often the handler or hook runs
- the worker re-runs the safety classifier and never sends a blocked question to the LLM
- question text never reaches the logs
"""

import asyncio
import json
import logging
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from astro_api import ai_api, wallet
from astro_api import jobs as queue
from astro_api.chat_crypto import cipher_from_settings
from astro_api.config import get_settings
from astro_api.db import make_sessionmaker
from astro_api.models import SavedKundli, User
from astro_api.models_ai import AiConversation, AiQuestion
from astro_api.models_jobs import Job
from astro_api.models_ledger import LedgerTransaction
from astro_worker import jobs
from astro_worker.config import WorkerSettings
from astro_worker.handlers import ai as ai_handler
from astro_worker.llm import FakeProvider, LlmRequest, LlmResult, ProviderError

pytestmark = pytest.mark.integration

FIXTURES = Path(__file__).resolve().parents[2] / "api" / "tests" / "fixtures"
PRICE = 1000


def recorded(name: str = "known_time") -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"ai_engine_{name}.json").read_text())
    return data


def engine_transport(name: str = "known_time", status: int = 200) -> httpx.MockTransport:
    data = recorded(name)

    def handler(request: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status, json={"detail": {"code": "down"}})
        path = request.url.path
        if path == "/v1/kundli":
            return httpx.Response(200, json=data["kundli"])
        if path == "/v1/dasha":
            return httpx.Response(200, json=data["dasha"])
        if path == "/v1/transits":
            return httpx.Response(200, json=data["transits"])
        return httpx.Response(404)

    return httpx.MockTransport(handler)


class Scripted:
    """Returns the given answers in turn; a ProviderError instance is raised instead."""

    name = "scripted"

    def __init__(self, *answers: str | ProviderError) -> None:
        self.answers = list(answers)
        self.prompts: list[str] = []

    async def answer(self, req: LlmRequest) -> LlmResult:
        self.prompts.append(req.user)
        item = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(item, ProviderError):
            raise item
        return LlmResult(text=json.dumps({"answer": item}, ensure_ascii=False), model="scripted")


class Harness:
    def __init__(self, maker: async_sessionmaker[AsyncSession], http: httpx.AsyncClient) -> None:
        self.maker = maker
        self.http = http
        self.settings = get_settings()
        self.cipher = cipher_from_settings(self.settings)
        self.redis = Redis.from_url(self.settings.redis_url.get_secret_value())

    def ctx(self, provider: Any) -> jobs.Context:
        return jobs.Context(
            self.maker,
            self.settings,
            WorkerSettings(app_env="test", astro_url="http://astro.test"),
            self.http,
            self.redis,
            extra={"llm": provider},
        )

    async def user(self, real: int = 5000) -> uuid.UUID:
        async with self.maker() as db:
            user = User(phone=f"+9196{uuid.uuid4().int % 10**8:08d}", device_ids=[], roles=[])
            db.add(user)
            await db.flush()
            await wallet.credit_recharge(
                db, user_id=user.id, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=real
            )
            await db.commit()
            return user.id

    async def conversation(self, uid: uuid.UUID, unknown_time: bool = False) -> uuid.UUID:
        import datetime as dt

        async with self.maker() as db:
            k = SavedKundli(
                user_id=uid,
                name="Sample",
                birth_date=dt.date(1990, 8, 15),
                birth_time=None if unknown_time else dt.time(6, 30),
                unknown_time=unknown_time,
                birth_datetime_utc=dt.datetime(1990, 8, 15, 1, 0, tzinfo=dt.UTC),
                tz="Asia/Kolkata",
                utc_offset="+05:30",
                lat=28.62137,
                lon=77.2148,
            )
            db.add(k)
            await db.flush()
            c = AiConversation(user_id=uid, kundli_id=k.id)
            db.add(c)
            await db.commit()
            return c.id

    async def ask(self, uid: uuid.UUID, cid: uuid.UUID, text: str) -> uuid.UUID:
        async with self.maker() as db:
            q = await ai_api.ask(
                db,
                self.cipher,
                user_id=uid,
                conversation_id=cid,
                text=text,
                key=uuid.uuid4().hex,
            )
            return q.id

    async def run_all(self, provider: Any, rounds: int = 1) -> None:
        ctx = self.ctx(provider)
        for _ in range(rounds):
            while await jobs.run_once(ctx, ("ai_answer",)):
                pass
            async with self.maker() as db:  # make retries due now
                await db.execute(
                    update(Job).where(Job.status == "queued").values(run_after=Job.created_at)
                )
                await db.commit()

    async def question(self, qid: uuid.UUID) -> AiQuestion:
        async with self.maker() as db:
            return (await db.execute(select(AiQuestion).where(AiQuestion.id == qid))).scalar_one()

    async def balance(self, uid: uuid.UUID) -> int:
        async with self.maker() as db:
            return (await wallet.balances(db, uid)).total_paise

    async def ledger(self, qid: uuid.UUID) -> list[str]:
        async with self.maker() as db:
            keys = (
                await db.execute(
                    select(LedgerTransaction.idempotency_key).where(
                        LedgerTransaction.idempotency_key.in_(
                            [f"ai:{qid}:charge", f"refund:ai:{qid}"]
                        )
                    )
                )
            ).scalars()
            return sorted(keys)

    async def job(self, qid: uuid.UUID) -> Job:
        async with self.maker() as db:
            return (await db.execute(select(Job).where(Job.key == f"ai:{qid}:answer"))).scalar_one()


@pytest.fixture
def harness(db_url: str, monkeypatch: pytest.MonkeyPatch) -> Callable[..., Any]:
    monkeypatch.setenv("FLAG_AI_ASSISTANT", "true")
    monkeypatch.setattr(jobs, "HANDLERS", {})
    jobs.register("ai_answer", ai_handler.handle, ai_handler.on_failed)

    def run(fn: Any, engine: str = "known_time", status: int = 200) -> Any:
        async def go() -> Any:
            db_engine = create_async_engine(db_url)
            async with httpx.AsyncClient(transport=engine_transport(engine, status)) as http:
                h = Harness(make_sessionmaker(db_engine), http)
                try:
                    return await fn(h)
                finally:
                    await h.redis.aclose()
                    await db_engine.dispose()

        return asyncio.run(go())

    return run


def test_fake_provider_answer_is_stored_encrypted_and_labelled(harness: Any) -> None:
    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "What does my chart say about my career?")
        await h.run_all(FakeProvider(WorkerSettings(app_env="test")))
        q = await h.question(qid)
        assert q.status == "answered" and q.answered_at is not None
        assert q.ai_label == "AI assistant" and q.handoff and "human astrologer" in q.handoff
        assert q.answer_ciphertext is not None and b"Moon" not in q.answer_ciphertext
        answer = ai_api.open_answer(h.cipher, q)
        assert answer and "Moon" in answer and "AI assistant" not in answer  # stored plain
        assert q.refunded is False and q.price_paise == PRICE
        assert await h.balance(uid) == 5000 - PRICE
        assert await h.ledger(qid) == [f"ai:{qid}:charge"]
        assert (await h.job(qid)).status == "done"

    harness(go)


def test_hindi_question_gets_a_hindi_answer(harness: Any) -> None:
    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "मेरे करियर के बारे में मेरी कुंडली क्या कहती है?")
        await h.run_all(FakeProvider(WorkerSettings(app_env="test")))
        q = await h.question(qid)
        assert q.status == "answered" and q.language == "hi"
        answer = ai_api.open_answer(h.cipher, q)
        assert answer and any("ऀ" <= c <= "ॿ" for c in answer)
        assert q.ai_label == "एआई सहायक"

    harness(go)


def test_unknown_birth_time_still_answers(harness: Any) -> None:
    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid, unknown_time=True)
        qid = await h.ask(uid, cid, "What is my Moon sign?")
        await h.run_all(FakeProvider(WorkerSettings(app_env="test")))
        assert (await h.question(qid)).status == "answered"

    harness(go, engine="unknown_time")


def test_invalid_answer_is_retried_once_with_the_errors(harness: Any) -> None:
    good = (
        "Your Moon is in Taurus in your chart. Read this as one input among many and take "
        "practical, steady steps at work while you talk openly with the people involved."
    )
    provider = Scripted("You will definitely get a promotion, guaranteed.", good)

    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "Will I get promoted?")
        await h.run_all(provider)
        q = await h.question(qid)
        assert q.status == "answered", q.error_code
        assert len(provider.prompts) == 2 and "rejected" in provider.prompts[1]
        assert await h.ledger(qid) == [f"ai:{qid}:charge"]

    harness(go)


def test_invalid_twice_is_blocked_and_refunded_exactly_once(harness: Any) -> None:
    provider = Scripted("As your astrologer I promise you will definitely marry in 2027.")

    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "When will I marry?")
        await h.run_all(provider)
        q = await h.question(qid)
        assert q.status == "blocked" and q.blocked_reason == "other"
        assert q.refunded is True and q.refunded_at is not None and q.answer_ciphertext is None
        assert q.notice and q.handoff
        assert len(provider.prompts) == 2
        assert await h.balance(uid) == 5000
        assert await h.ledger(qid) == [f"ai:{qid}:charge", f"refund:ai:{qid}"]
        # Running the handler and the failure hook again changes nothing.
        payload = {"question_id": str(qid), "user_id": str(uid)}
        await ai_handler.handle(h.ctx(provider), uuid.uuid4(), payload)
        await ai_handler.on_failed(h.ctx(provider), uuid.uuid4(), payload)
        assert await h.balance(uid) == 5000
        assert await h.ledger(qid) == [f"ai:{qid}:charge", f"refund:ai:{qid}"]
        async with h.maker() as db:
            assert await wallet.account_balance(db, wallet.AI_REVENUE) == 0

    harness(go)


def test_llm_errors_retry_then_fail_and_refund_once(harness: Any) -> None:
    provider = Scripted(ProviderError("Gemini API error 503"))

    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "What does my chart say about travel?")
        await h.run_all(provider, rounds=1)
        q = await h.question(qid)
        assert q.status == "queued" and await h.ledger(qid) == [f"ai:{qid}:charge"]
        await h.run_all(provider, rounds=queue.MAX_ATTEMPTS)
        q = await h.question(qid)
        job = await h.job(qid)
        assert job.status == "failed" and job.attempts == queue.MAX_ATTEMPTS
        assert job.last_error_code == "llm_unavailable"
        assert q.status == "failed" and q.refunded is True and q.error_code == "llm_unavailable"
        assert q.notice and q.handoff
        assert await h.balance(uid) == 5000
        assert await h.ledger(qid) == [f"ai:{qid}:charge", f"refund:ai:{qid}"]
        await ai_handler.on_failed(
            h.ctx(provider), job.id, {"question_id": str(qid), "user_id": str(uid)}
        )
        assert await h.ledger(qid) == [f"ai:{qid}:charge", f"refund:ai:{qid}"]

    harness(go)


def test_engine_down_fails_and_refunds(harness: Any) -> None:
    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "What does my chart say about travel?")
        provider = Scripted("unused")
        await h.run_all(provider, rounds=queue.MAX_ATTEMPTS)
        q = await h.question(qid)
        assert q.status == "failed" and q.refunded is True
        assert (await h.job(qid)).last_error_code == "engine_unavailable"
        assert provider.prompts == []
        assert await h.balance(uid) == 5000

    harness(go, status=503)


def test_worker_rechecks_safety_before_the_llm(harness: Any) -> None:
    """A question queued before a classifier update must still never reach the LLM."""
    provider = Scripted("unused")

    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "What does my chart say about my health this year?")
        async with h.maker() as db:  # simulate a row queued under an older classifier
            q = (await db.execute(select(AiQuestion).where(AiQuestion.id == qid))).scalar_one()
            assert q.status == "blocked"  # today's classifier blocks it at the API...
        qid = await h.ask(uid, cid, "Tell me about my career")
        async with h.maker() as db:  # ...so swap in self-harm text on a queued, charged row
            q = (await db.execute(select(AiQuestion).where(AiQuestion.id == qid))).scalar_one()
            sealed = ai_api.seal_text(h.cipher, q.id, "I want to kill myself")
            q.text_ciphertext, q.text_nonce, q.text_key_id = sealed
            await db.commit()
        await h.run_all(provider)
        q = await h.question(qid)
        assert q.status == "blocked" and q.blocked_reason == "self_harm" and q.refunded
        assert provider.prompts == []
        assert await h.balance(uid) == 5000

    harness(go)


def test_deleted_kundli_refunds_the_queued_question(harness: Any) -> None:
    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        qid = await h.ask(uid, cid, "What does my chart say about travel?")
        async with h.maker() as db:
            c = await db.get(AiConversation, cid)
            assert c is not None
            k = await db.get(SavedKundli, c.kundli_id)
            await db.delete(k)
            await db.commit()
        provider = Scripted("unused")
        await h.run_all(provider)
        assert provider.prompts == []
        assert await h.balance(uid) == 5000
        assert await h.ledger(qid) == [f"ai:{qid}:charge", f"refund:ai:{qid}"]
        assert (await h.job(qid)).status == "done"

    harness(go)


def test_question_and_answer_text_never_reach_the_logs(
    harness: Any, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "my secret worry about Priya and the Noida flat"
    caplog.set_level(logging.DEBUG)

    async def go(h: Harness) -> None:
        uid = await h.user()
        cid = await h.conversation(uid)
        await h.ask(uid, cid, secret)
        await h.run_all(Scripted(ProviderError("boom")), rounds=queue.MAX_ATTEMPTS)
        qid = await h.ask(uid, cid, secret + " again")
        await h.run_all(FakeProvider(WorkerSettings(app_env="test")))
        assert (await h.question(qid)).status == "answered"

    harness(go)
    logged = "\n".join(r.getMessage() + repr(r.__dict__) for r in caplog.records)
    assert "Priya" not in logged and "Noida" not in logged
