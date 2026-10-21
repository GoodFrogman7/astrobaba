"""AI assistant API (docs/api/revenue.md §3). Written before the implementation (money paths).

- 404 for every endpoint while the `ai_assistant` flag is off.
- A question is charged exactly once (`ai:{id}:charge`) in the same transaction as its row and
  its `ai_answer` job; Idempotency-Key replays never charge twice; 402 writes nothing.
- Questions the pre-LLM classifier blocks are never charged, never queued, and work with an
  empty wallet (a person in crisis must not see "recharge").
- Question text is encrypted at rest and never placed in job payloads.
"""

import asyncio
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import wallet
from astro_api.db import make_sessionmaker
from astro_api.models import User
from astro_api.models_ai import AiQuestion
from astro_api.models_jobs import Job
from astro_api.models_ledger import LedgerTransaction

pytestmark = pytest.mark.integration

PRICE = 1000  # data/marketplace/products.json ai_question.price_paise
KUNDLI = {
    "name": "Sample",
    "birth": {
        "date": "1990-08-15",
        "time": "06:30:00",
        "place": {"lat": 28.62137, "lon": 77.2148, "tz": "Asia/Kolkata"},
    },
}


@pytest.fixture(autouse=True)
def ai_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLAG_AI_ASSISTANT", "true")


def _db(clean: Any, fn: Any) -> Any:
    async def go() -> Any:
        engine = create_async_engine(clean.database_url.get_secret_value())
        try:
            async with make_sessionmaker(engine)() as db:
                return await fn(db)
        finally:
            await engine.dispose()

    return asyncio.run(go())


def fund(clean: Any, phone: str, real: int) -> None:
    async def go(db: Any) -> None:
        user = (await db.execute(select(User).where(User.phone == phone))).scalar_one()
        await wallet.credit_recharge(
            db, user_id=user.id, payment_id=f"pay_{uuid.uuid4().hex[:14]}", amount_paise=real
        )
        await db.commit()

    _db(clean, go)


def balance(clean: Any, phone: str) -> int:
    async def go(db: Any) -> int:
        user = (await db.execute(select(User).where(User.phone == phone))).scalar_one()
        return (await wallet.balances(db, user.id)).total_paise

    return int(_db(clean, go))


def rows(clean: Any, model: Any) -> list[Any]:
    async def go(db: Any) -> list[Any]:
        return list((await db.execute(select(model))).scalars())

    return list(_db(clean, go))


def conversation(client: TestClient, headers: dict[str, str]) -> str:
    r = client.post("/v1/kundlis", json=KUNDLI, headers=headers)
    assert r.status_code == 201, r.text
    r = client.post("/v1/ai/conversations", json={"kundli_id": r.json()["id"]}, headers=headers)
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


def ask(
    client: TestClient, headers: dict[str, str], cid: str, text: str, key: str | None = None
) -> Any:
    return client.post(
        f"/v1/ai/conversations/{cid}/questions",
        json={"text": text},
        headers={**headers, "Idempotency-Key": key or uuid.uuid4().hex},
    )


def test_everything_is_404_while_the_flag_is_off(
    client: TestClient, login: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = login("+919800000001")
    cid = conversation(client, headers)
    monkeypatch.setenv("FLAG_AI_ASSISTANT", "false")
    assert client.post("/v1/ai/conversations", json={}, headers=headers).status_code == 404
    assert client.get("/v1/ai/conversations", headers=headers).status_code == 404
    assert client.get("/v1/ai/pricing").status_code == 404
    assert client.get(f"/v1/ai/conversations/{cid}", headers=headers).status_code == 404
    assert ask(client, headers, cid, "When will I marry?").status_code == 404


def test_question_is_charged_once_with_its_job_in_one_transaction(
    client: TestClient, login: Any, clean: Any
) -> None:
    phone = "+919800000002"
    headers = login(phone)
    fund(clean, phone, 2500)
    cid = conversation(client, headers)
    r = ask(client, headers, cid, "What does my chart say about my career?", key="key-career-1")
    assert r.status_code == 202, r.text
    q = r.json()
    assert q["status"] == "queued" and q["price_paise"] == PRICE and q["refunded"] is False
    assert q["answer"] is None and q["blocked_reason"] is None
    assert q["text"] == "What does my chart say about my career?"
    assert balance(clean, phone) == 2500 - PRICE

    # Replays (same key, same body) return the same question and never charge again.
    again = ask(client, headers, cid, "What does my chart say about my career?", key="key-career-1")
    assert again.status_code == 202 and again.json()["id"] == q["id"]
    assert balance(clean, phone) == 2500 - PRICE
    # Same key, other body: conflict, nothing written.
    other = ask(client, headers, cid, "Something else entirely?", key="key-career-1")
    assert other.status_code == 409

    jobs = rows(clean, Job)
    assert [(j.kind, j.key) for j in jobs] == [("ai_answer", f"ai:{q['id']}:answer")]
    # Ids only: no question text, no birth details.
    assert set(jobs[0].payload) == {"question_id", "user_id"}
    assert jobs[0].payload["question_id"] == q["id"]
    charges = [t for t in rows(clean, LedgerTransaction) if t.kind == "purchase"]
    assert [t.idempotency_key for t in charges] == [f"ai:{q['id']}:charge"]

    # Encrypted at rest.
    stored = rows(clean, AiQuestion)
    assert len(stored) == 1 and b"career" not in stored[0].text_ciphertext


def test_unfunded_question_is_402_and_writes_nothing(
    client: TestClient, login: Any, clean: Any
) -> None:
    phone = "+919800000003"
    headers = login(phone)
    fund(clean, phone, PRICE - 1)
    cid = conversation(client, headers)
    r = ask(client, headers, cid, "Will my business grow this year?")
    assert r.status_code == 402
    detail = r.json()["detail"]
    assert detail["code"] == "insufficient_funds"
    assert (detail["required_paise"], detail["available_paise"]) == (PRICE, PRICE - 1)
    assert rows(clean, AiQuestion) == [] and rows(clean, Job) == []
    assert [t for t in rows(clean, LedgerTransaction) if t.kind == "purchase"] == []
    assert balance(clean, phone) == PRICE - 1


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("I want to end my life, what does my kundli say?", "self_harm"),
        ("मैं आत्महत्या करना चाहता हूँ", "self_harm"),
        ("mujhe jeena nahi hai, marna chahta hu", "self_harm"),
        ("Which medicine should I take for my diabetes?", "medical"),
        ("Will I win my court case against my brother?", "legal"),
        ("Should I invest in the share market now?", "financial"),
    ],
)
def test_blocked_questions_are_never_charged_or_sent_on(
    client: TestClient, login: Any, clean: Any, text: str, reason: str
) -> None:
    phone = "+919800000004"
    headers = login(phone)  # empty wallet on purpose
    cid = conversation(client, headers)
    r = ask(client, headers, cid, text)
    assert r.status_code == 202, r.text
    q = r.json()
    assert q["status"] == "blocked" and q["blocked_reason"] == reason
    assert q["price_paise"] == 0 and q["refunded"] is False and q["answer"] is None
    assert q["notice"] and q["handoff"] and q["label"]
    if reason == "self_harm":
        assert "mental-health professional" in q["notice"] or "मानसिक" in q["notice"]
        assert not any(ch.isdigit() for ch in q["notice"])  # no invented phone numbers
    assert rows(clean, Job) == []
    assert [t for t in rows(clean, LedgerTransaction) if t.kind == "purchase"] == []


def test_conversation_view_and_ownership(client: TestClient, login: Any, clean: Any) -> None:
    phone = "+919800000005"
    headers = login(phone)
    fund(clean, phone, 5000)
    cid = conversation(client, headers)
    first = ask(client, headers, cid, "What is my Moon sign?").json()
    second = ask(client, headers, cid, "मेरी शादी कब होगी?").json()
    r = client.get(f"/v1/ai/conversations/{cid}", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == cid and body["kundli"]["name"] == "Sample"
    assert body["kundli"]["label"] == "Sample"
    assert body["label"] == "AI assistant"
    assert [q["id"] for q in body["questions"]] == [first["id"], second["id"]]
    assert body["questions"][1]["text"] == "मेरी शादी कब होगी?"

    stranger = login("+919800000006")
    assert client.get(f"/v1/ai/conversations/{cid}", headers=stranger).status_code == 404
    assert ask(client, stranger, cid, "Whose chart is this?").status_code == 404
    # A stranger cannot open a conversation on someone else's kundli.
    kid = body["kundli"]["id"]
    r = client.post("/v1/ai/conversations", json={"kundli_id": kid}, headers=stranger)
    assert r.status_code == 404


@pytest.mark.parametrize("text", ["", "   ", "x" * 501])
def test_question_length_is_validated(client: TestClient, login: Any, text: str) -> None:
    headers = login("+919800000007")
    cid = conversation(client, headers)
    assert ask(client, headers, cid, text).status_code == 422


def test_question_needs_idempotency_key_and_sign_in(client: TestClient, login: Any) -> None:
    headers = login("+919800000008")
    cid = conversation(client, headers)
    r = client.post(f"/v1/ai/conversations/{cid}/questions", json={"text": "hi"}, headers=headers)
    assert r.status_code == 400
    r = client.post(f"/v1/ai/conversations/{cid}/questions", json={"text": "hi"})
    assert r.status_code == 401


def test_pricing_is_public_and_matches_products_json(client: TestClient) -> None:
    r = client.get("/v1/ai/pricing")
    assert r.status_code == 200
    assert r.json() == {"price_paise": PRICE, "max_chars": 500, "enabled": True}


def test_list_conversations_newest_first_own_only(
    client: TestClient, login: Any, clean: Any
) -> None:
    phone = "+919800000009"
    headers = login(phone)
    fund(clean, phone, 5000)
    first = conversation(client, headers)
    second = conversation(client, headers)
    ask(client, headers, first, "What is my Moon sign?")
    ask(client, headers, first, "Will my health improve?")  # blocked, still listed and counted
    other = login("+919800000010")
    conversation(client, other)

    r = client.get("/v1/ai/conversations", headers=headers)
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["id"] for i in items] == [second, first]
    assert [i["questions"] for i in items] == [0, 2]
    assert items[1]["kundli_label"] == "Sample" and items[1]["kundli_id"]
    assert set(items[0]) == {"id", "kundli_id", "kundli_label", "created_at", "questions"}
    assert client.get("/v1/ai/conversations").status_code == 401
    assert [i["id"] for i in client.get("/v1/ai/conversations", headers=other).json()["items"]]
