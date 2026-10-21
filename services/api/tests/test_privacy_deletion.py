"""Account deletion (docs/api/trust.md §2, ADR-0011). Written before the executor: it touches
money tables (PLAN.md §0.3).

- request / cancel by the user; the account keeps working while a request is open;
- an admin executes, refused while a consultation is open or real money / astrologer payable is
  outstanding, or while paid work is still queued;
- execution anonymises in one transaction: tokens revoked, phone tombstoned (the number can
  sign up again), kundlis, chat messages, AI questions, leads deleted, report and export files
  queued for removal, reviews kept on the anonymised user, consents and every ledger row kept,
  promo credit forfeited through the ledger (`promo_lot:{id}:expire`), every step audited with
  ids only.
"""

import json
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import wallet
from astro_api.models import (
    Astrologer,
    AuditLog,
    AuthSession,
    ConsultSession,
    KycDocument,
    Review,
    SavedKundli,
    User,
)
from astro_api.models_ai import AiConversation, AiQuestion
from astro_api.models_jobs import Job
from astro_api.models_ledger import (
    AccountBalance,
    FreeSessionClaim,
    LedgerEntry,
    LedgerTransaction,
    PromoLot,
)
from astro_api.models_portal import AstrologerAvailability
from astro_api.models_privacy import Consent, DeletionRequest
from astro_api.models_remedies import RemedyLead
from astro_api.models_reports import Report, ReportOrder
from astro_api.models_safety import ModerationEvent
from astro_api.models_sessions import ChatMessage
from services.api.tests.privacy_support import (
    OTHER_PHONE,
    REPORT_PDF,
    USER_PHONE,
    make_world,
    run_db,
)

pytestmark = pytest.mark.integration


@pytest.fixture
def astrologer(make_live) -> tuple[dict[str, str], str, str]:  # type: ignore[no-untyped-def]
    return make_live("+919833300099")  # type: ignore[no-any-return]


def _request(client: TestClient, headers: dict[str, str]) -> str:
    r = client.post("/v1/me/deletion", json={"confirm": "DELETE"}, headers=headers)
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "requested"
    return str(r.json()["id"])


def _execute(client: TestClient, admin: dict[str, str], did: str) -> Any:
    return client.post(f"/v1/admin/deletions/{did}/execute", headers=admin)


async def _ledger_snapshot(db: AsyncSession) -> tuple[set[uuid.UUID], int]:
    txns = set((await db.execute(select(LedgerTransaction.id))).scalars())
    entries = (await db.execute(select(func.count()).select_from(LedgerEntry))).scalar_one()
    return txns, int(entries)


# ------------------------------------------------------------------ request / cancel


def test_request_get_cancel(client: TestClient, login, admin_headers) -> None:  # type: ignore[no-untyped-def]
    h = login(USER_PHONE)
    assert client.get("/v1/me/deletion", headers=h).status_code == 404
    r = client.post("/v1/me/deletion", json={"confirm": "delete"}, headers=h)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "confirm_required"
    did = _request(client, h)
    assert _request(client, h) == did  # one open request; asking again returns it
    assert client.get("/v1/me/deletion", headers=h).json()["id"] == did
    # The account keeps working while the request is open.
    assert client.get("/v1/me", headers=h).status_code == 200
    listed = client.get("/v1/admin/deletions", headers=admin_headers).json()["items"]
    assert [i["id"] for i in listed] == [did]
    assert client.get("/v1/admin/deletions", headers=h).status_code == 403

    r = client.delete("/v1/me/deletion", headers=h)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    assert client.get("/v1/me/deletion", headers=h).status_code == 404
    assert client.delete("/v1/me/deletion", headers=h).status_code == 404
    r = _execute(client, admin_headers, did)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "deletion_not_open"
    assert _execute(client, h, did).status_code == 403
    assert _execute(client, admin_headers, str(uuid.uuid4())).status_code == 404

    async def audits(db: AsyncSession) -> list[str]:
        return list(
            (
                await db.execute(
                    select(AuditLog.action).where(AuditLog.entity_id == did).order_by(AuditLog.id)
                )
            ).scalars()
        )

    assert run_db(client, audits) == ["privacy.deletion.request", "privacy.deletion.cancel"]


# ------------------------------------------------------------------ refusals


def test_refused_while_a_session_is_open(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
    consult: Any,
) -> None:
    h = login(USER_PHONE)
    sid = consult(USER_PHONE, astrologer[1], status="active")
    did = _request(client, h)
    r = _execute(client, admin_headers, did)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "session_open"
    assert r.json()["detail"]["session_ids"] == [sid]
    assert client.get("/v1/me", headers=h).status_code == 200  # nothing happened
    assert client.get("/v1/me/deletion", headers=h).json()["status"] == "requested"


def test_refused_while_the_astrologer_has_an_open_session(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
    consult: Any,
) -> None:
    login(USER_PHONE)
    consult(USER_PHONE, astrologer[1], status="requested")
    did = _request(client, astrologer[0])
    r = _execute(client, admin_headers, did)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "session_open"


def test_refused_with_real_money_left(client: TestClient, login, admin_headers) -> None:  # type: ignore[no-untyped-def]
    h = login(USER_PHONE)
    uid = uuid.UUID(client.get("/v1/me", headers=h).json()["id"])

    async def fund(db: AsyncSession) -> None:
        await wallet.credit_recharge(db, user_id=uid, payment_id="pay_priv1", amount_paise=25000)
        await db.commit()

    run_db(client, fund)
    did = _request(client, h)
    r = _execute(client, admin_headers, did)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "balance_outstanding"
    assert detail["real_paise"] == 25000
    assert detail["payable_paise"] == 0
    assert client.get("/v1/me", headers=h).status_code == 200


def test_refused_with_astrologer_payable_left(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
) -> None:
    login(USER_PHONE)
    login(OTHER_PHONE)
    make_world(client, astrologer[1])  # one minute charged → the astrologer has payable
    did = _request(client, astrologer[0])
    r = _execute(client, admin_headers, did)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "balance_outstanding"
    assert r.json()["detail"]["payable_paise"] == 700  # 1000 - 30 % commission


def test_refused_while_a_report_is_rendering(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
) -> None:
    h = login(USER_PHONE)
    login(OTHER_PHONE)
    w = make_world(client, astrologer[1])

    async def rendering(db: AsyncSession) -> None:
        await db.execute(
            text("UPDATE reports SET status = 'rendering' WHERE id = :r"), {"r": w.report_id}
        )
        await db.commit()

    run_db(client, rendering)
    r = _execute(client, admin_headers, _request(client, h))
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "work_pending"
    assert r.json()["detail"]["pending"] == ["report"]


# ------------------------------------------------------------------ execution


def test_execute_anonymises_and_keeps_the_ledger(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
) -> None:
    h = login(USER_PHONE)
    login(OTHER_PHONE)
    w = make_world(client, astrologer[1])
    before_txns, before_entries = run_db(client, _ledger_snapshot)

    async def consent_count(db: AsyncSession) -> int:
        q = select(func.count()).select_from(Consent).where(Consent.user_id == w.user_id)
        return int((await db.execute(q)).scalar_one())

    consents_before = run_db(client, consent_count)
    assert consents_before == 4
    did = _request(client, h)
    r = _execute(client, admin_headers, did)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "executed"
    assert body["promo_forfeited_paise"] == 4000

    # Signed out everywhere.
    assert client.get("/v1/me", headers=h).status_code == 401

    async def facts(db: AsyncSession) -> dict[str, Any]:
        async def count(model: Any, *where: Any) -> int:
            q = select(func.count()).select_from(model).where(*where)
            return int((await db.execute(q)).scalar_one())

        user = await db.get(User, w.user_id)
        order = await db.get(ReportOrder, w.order_id)
        report = await db.get(Report, w.report_id)
        review = await db.get(Review, w.review_id)
        report_item = await db.get(ModerationEvent, w.moderation_id)
        lot = await db.get(PromoLot, w.lot_id)
        d = await db.get(DeletionRequest, uuid.UUID(did))
        promo = await db.get(AccountBalance, wallet.promo_account(w.user_id))
        jobs = list(
            (await db.execute(select(Job.kind, Job.key, Job.payload).order_by(Job.key))).all()
        )
        audits = list(
            (
                await db.execute(
                    select(AuditLog.action, AuditLog.detail).where(
                        AuditLog.action.like("privacy.deletion.%")
                    )
                )
            ).all()
        )
        expiry = list(
            (
                await db.execute(
                    select(LedgerTransaction.idempotency_key).where(
                        LedgerTransaction.kind == "promo_expiry",
                        LedgerTransaction.user_id == w.user_id,
                    )
                )
            ).scalars()
        )
        return {
            "user": user,
            "order": order,
            "report": report,
            "review": review,
            "report_item": report_item,
            "lot": lot,
            "deletion": d,
            "promo_balance": promo.balance_paise if promo else None,
            "jobs": jobs,
            "audits": audits,
            "expiry_keys": expiry,
            "kundlis": await count(SavedKundli, SavedKundli.user_id == w.user_id),
            "conversations": await count(AiConversation, AiConversation.user_id == w.user_id),
            "questions": await count(AiQuestion, AiQuestion.user_id == w.user_id),
            "leads": await count(RemedyLead, RemedyLead.user_id == w.user_id),
            "my_messages": await count(ChatMessage, ChatMessage.session_id == w.session_id),
            "other_messages": await count(
                ChatMessage, ChatMessage.session_id == w.other_session_id
            ),
            "sessions": await count(ConsultSession, ConsultSession.user_id == w.user_id),
            "live_tokens": await count(
                AuthSession, AuthSession.user_id == w.user_id, AuthSession.revoked_at.is_(None)
            ),
            "devices": await count(
                AuthSession, AuthSession.user_id == w.user_id, AuthSession.device_id.is_not(None)
            ),
            "claims": await count(FreeSessionClaim, FreeSessionClaim.user_id == w.user_id),
            "consents": await count(Consent, Consent.user_id == w.user_id),
            "ledger": await _ledger_snapshot(db),
        }

    f = run_db(client, facts)
    user = f["user"]
    assert user.phone.startswith("deleted:") and USER_PHONE not in user.phone
    assert user.device_ids == [] and user.roles == [] and user.locale == "en"
    assert user.last_login_at is None
    # Deleted with the account.
    assert f["kundlis"] == f["conversations"] == f["questions"] == f["leads"] == 0
    assert f["my_messages"] == 0
    assert f["other_messages"] == 1  # another client's transcript is untouched
    # Kept: consultations (money facts), the review on the anonymised user, consents, claims.
    assert f["sessions"] == 1
    assert f["review"] is not None and f["review"].user_id == w.user_id
    assert f["consents"] == consents_before
    # The report the user filed stays for moderation, without the user's note.
    item = f["report_item"]
    assert item is not None and item.reporter_user_id == w.user_id
    assert item.reason == "off_platform"
    assert item.note_ciphertext is None and item.note_nonce is None and item.note_key_id is None
    assert f["claims"] == 1
    assert f["live_tokens"] == 0 and f["devices"] == 0
    # Report: order and report rows kept for the money record, personal parts erased.
    assert f["order"].snapshot is None and f["order"].email_ciphertext is None
    assert f["order"].email_nonce is None and f["order"].email_key_id is None
    assert f["report"].snapshot == {} and f["report"].storage_key is None
    # Ledger: every earlier row still there; only the promo forfeiture was added.
    after_txns, after_entries = f["ledger"]
    assert before_txns <= after_txns
    assert f["expiry_keys"] == [f"promo_lot:{w.lot_id}:expire"]
    assert len(after_txns - before_txns) == 1 and after_entries == before_entries + 2
    assert f["lot"].remaining_paise == 0 and f["promo_balance"] == 0
    # Files: listed for the cleanup job, which is queued; the file itself is still there now.
    d = f["deletion"]
    assert d.status == "executed" and d.executed_by.startswith("user:")
    assert {"kind": "report", "id": str(w.report_id), "key": w.report_key} in d.pending_files
    assert ("account_cleanup", f"deletion:{did}:cleanup", {"deletion_id": did}) in f["jobs"]
    storage = client.app.state.storage  # type: ignore[attr-defined]
    assert storage.get(w.report_key) == REPORT_PDF
    assert d.kyc_review_required is False
    # Audited, ids only: no phone, name, note or message text anywhere in the details.
    actions = {a for a, _ in f["audits"]}
    assert {"privacy.deletion.request", "privacy.deletion.execute"} <= actions
    dumped = json.dumps([detail for _, detail in f["audits"]])
    for secret in (USER_PHONE, USER_PHONE[3:], "Ravi", "Pune", "6 pm", "career"):
        assert secret not in dumped

    # The number can sign up again as a new user.
    h2 = login(USER_PHONE, consents=False)
    me2 = client.get("/v1/me", headers=h2).json()
    assert me2["id"] != str(w.user_id)
    assert client.get("/v1/me/consents", headers=h2).json()["current"] is False
    # Executing again is refused and changes nothing.
    r = _execute(client, admin_headers, did)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "deletion_not_open"


def test_astrologer_deletion_hides_profile_and_keeps_kyc_for_review(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
    consult: Any,
) -> None:
    headers, aid, slug = astrologer
    assert client.get(f"/v1/astrologers/{slug}").status_code == 200
    r = client.put(
        "/v1/astrologer/me/availability",
        json={"slots": [{"weekday": 0, "start": "09:00", "end": "12:00"}]},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    login(USER_PHONE)
    sid = consult(USER_PHONE, aid)  # a client's completed session stays the client's
    did = _request(client, headers)
    r = _execute(client, admin_headers, did)
    assert r.status_code == 200, r.text
    assert client.get(f"/v1/astrologers/{slug}").status_code == 404

    async def facts(db: AsyncSession) -> dict[str, Any]:
        a = await db.get(Astrologer, uuid.UUID(aid))
        docs = list(
            (
                await db.execute(
                    select(KycDocument).where(KycDocument.astrologer_id == uuid.UUID(aid))
                )
            ).scalars()
        )
        slots = (
            await db.execute(
                select(func.count())
                .select_from(AstrologerAvailability)
                .where(AstrologerAvailability.astrologer_id == uuid.UUID(aid))
            )
        ).scalar_one()
        s = await db.get(ConsultSession, uuid.UUID(sid))
        d = await db.get(DeletionRequest, uuid.UUID(did))
        return {"a": a, "docs": docs, "slots": slots, "session": s, "d": d}

    f = run_db(client, facts)
    a = f["a"]
    assert a.display_name == "Former astrologer" and a.bio == "" and a.bio_hi is None
    assert a.status == "suspended" and a.suspended_reason == "account_deleted"
    assert a.flags["show_in_directory"] is False
    assert f["slots"] == 0
    assert f["session"] is not None
    # KYC documents: kept (retention to be set with the lawyer), flagged for an admin review.
    assert len(f["docs"]) == 2
    storage = client.app.state.storage  # type: ignore[attr-defined]
    for doc in f["docs"]:
        assert storage.get(doc.storage_key)
    assert f["d"].kyc_review_required is True
    assert all(item["kind"] != "kyc" for item in f["d"].pending_files)


# ------------------------------------------------------------------ admin list


def test_admin_list_shows_blockers_and_pages(
    client: TestClient,
    login: Any,
    admin_headers: Any,
    astrologer: Any,
    consult: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from astro_api import privacy_api

    h = login(USER_PHONE)
    login(OTHER_PHONE)
    w = make_world(client, astrologer[1])  # USER_PHONE: 4000 promo left, no real money
    sid = consult(OTHER_PHONE, astrologer[1], status="active")
    mine = _request(client, h)
    others = _request(client, login(OTHER_PHONE))
    astro = _request(client, astrologer[0])

    r = client.get("/v1/admin/deletions", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["next_cursor"] is None
    by_id = {i["id"]: i for i in body["items"]}
    assert [i["id"] for i in body["items"]] == [mine, others, astro]
    assert by_id[mine]["user_id"] == str(w.user_id)
    assert by_id[mine]["status"] == "requested"
    assert by_id[mine]["open_sessions"] == 0
    assert by_id[mine]["wallet_balance_paise"] == {"real": 0, "promo": 4000}
    assert by_id[others]["open_sessions"] == 1  # as the client
    assert by_id[astro]["open_sessions"] == 1  # as the astrologer
    assert set(by_id[mine]) >= {"id", "user_id", "status", "requested_at", "open_sessions"}
    assert sid

    # Executed requests leave the default list but stay in `all`.
    assert _execute(client, admin_headers, mine).status_code == 200
    assert [
        i["id"] for i in client.get("/v1/admin/deletions", headers=admin_headers).json()["items"]
    ] == [
        others,
        astro,
    ]
    everything = client.get("/v1/admin/deletions?status=all", headers=admin_headers).json()
    assert {i["id"]: i["status"] for i in everything["items"]}[mine] == "executed"

    # Cursor paging.
    monkeypatch.setattr(privacy_api, "ADMIN_PAGE", 2)
    page1 = client.get("/v1/admin/deletions?status=all", headers=admin_headers).json()
    assert [i["id"] for i in page1["items"]] == [mine, others]
    page2 = client.get(
        f"/v1/admin/deletions?status=all&cursor={page1['next_cursor']}", headers=admin_headers
    ).json()
    assert [i["id"] for i in page2["items"]] == [astro]
    assert page2["next_cursor"] is None
    assert client.get("/v1/admin/deletions?cursor=bad", headers=admin_headers).status_code == 422
    assert (
        client.get("/v1/admin/deletions?status=executed", headers=admin_headers).status_code == 422
    )
    assert client.get("/v1/admin/deletions", headers=h).status_code == 401  # signed out by now


def test_public_review_label_for_a_deleted_reviewer() -> None:
    """Reviews stay after deletion (they describe the astrologer), but no longer say the
    reviewer is a current client."""
    import datetime as dt
    import uuid

    from astro_api.marketplace import public_review
    from astro_api.models import Review

    r = Review(id=uuid.uuid4(), rating=5, text="Kind", created_at=dt.datetime.now(dt.UTC))
    assert public_review(r)["author_label"] == "Verified client"
    assert public_review(r, former=True)["author_label"] == "Former client"
