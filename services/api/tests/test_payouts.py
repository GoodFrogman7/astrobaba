"""Monthly payouts (docs/api/portal.md §3), written before the implementation.

Generation per IST month from the ledger; one row per astrologer per period; re-running
regenerates drafts only; net below `min_payout_paise` (billing.json, 50000) is voided and carried
into the next generation; approve → mark-paid posts `payout:{id}` once (idempotent and safe under
concurrency), never above the payable balance; void only draft/approved; every admin action is
audited without personal data; statements are CSV-injection safe and say TDS/GST are not modelled.

Carry-forward rule under test: a payout's `carried_in_paise` = everything the astrologer earned
(net of refunds) before the period, minus the net of their earlier payouts that are not void.
So a void payout's net (below minimum, or voided by an admin) flows into the next generation.
"""

import asyncio
import csv
import io
import uuid
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import cli, earnings, payouts, wallet
from astro_api.config import get_settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.models import AuditLog
from astro_api.models_ledger import LedgerEntry, LedgerTransaction
from astro_api.models_portal import Payout
from services.api.tests.test_payouts_support import (  # noqa: F401 - fixtures
    ASTRO_A,
    USER_1,
    PortalWorld,
    portal_world_fixture,
    sql,
    utc,
)

pytestmark = pytest.mark.integration

AUG, SEP, JUL = utc("2026-08-10T06:00:00"), utc("2026-09-10T06:00:00"), utc("2026-07-10T06:00:00")


def generate(w: PortalWorld, period: str) -> dict[str, Any]:
    r = w.client.post("/v1/admin/payouts/generate", json={"period": period}, headers=w.admin)
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def payout_of(w: PortalWorld, astrologer_id: uuid.UUID, period: str) -> dict[str, Any]:
    items = w.client.get("/v1/admin/payouts", params={"period": period}, headers=w.admin).json()[
        "items"
    ]
    found: list[dict[str, Any]] = [p for p in items if p["astrologer"]["id"] == str(astrologer_id)]
    assert len(found) == 1, items
    return found[0]


def admin_post(w: PortalWorld, pid: str, action: str, body: dict[str, Any] | None = None) -> Any:
    return w.client.post(f"/v1/admin/payouts/{pid}/{action}", json=body or {}, headers=w.admin)


def pay(w: PortalWorld, pid: str, reference: str = "UTR0000123456789") -> Any:
    return admin_post(
        w,
        pid,
        "mark-paid",
        {"reference": reference, "paid_on": (earnings.ist_today()).isoformat()},
    )


def payout_postings(w: PortalWorld, pid: str) -> list[tuple[str, str, int]]:
    async def go(db: AsyncSession) -> list[tuple[str, str, int]]:
        rows = await db.execute(
            select(LedgerEntry.account_id, LedgerEntry.direction, LedgerEntry.amount_paise)
            .join(LedgerTransaction, LedgerTransaction.id == LedgerEntry.transaction_id)
            .where(LedgerTransaction.idempotency_key == f"payout:{pid}")
        )
        return sorted((a, d, int(n)) for a, d, n in rows.all())

    return w.db(go)


# ---------------------------------------------------------------- generation


def test_generate_carry_forward_and_regenerate(portal_world: PortalWorld) -> None:
    w = portal_world
    a, b = w.a_id, w.b_id
    w.work(a, count=20, at=AUG)  # 20 x 1200 = 24000 net: below the 50000 minimum
    sep_a = w.work(a, count=25, at=SEP)  # 30000
    w.work(b, count=50, at=SEP)  # 60000

    aug = generate(w, "2026-08")
    assert aug == {
        "period": "2026-08",
        "generated": 1,
        "updated": 0,
        "skipped": 0,
        "carried_forward": 1,
    }
    pa = payout_of(w, a, "2026-08")
    assert pa["status"] == "void" and pa["void_reason"] == "below_minimum"
    assert (pa["gross_paise"], pa["commission_paise"], pa["net_paise"]) == (40000, 16000, 24000)
    assert (pa["carried_in_paise"], pa["carried_forward_paise"]) == (0, 24000)
    assert (pa["sessions"], pa["minutes"]) == (1, 20)

    sep = generate(w, "2026-09")
    assert (sep["generated"], sep["updated"], sep["carried_forward"]) == (2, 0, 0)
    ps = payout_of(w, a, "2026-09")
    assert ps["status"] == "draft"
    # September's own 30000 plus August's carried 24000.
    assert (ps["gross_paise"], ps["commission_paise"], ps["refunds_paise"]) == (50000, 20000, 0)
    assert (ps["carried_in_paise"], ps["net_paise"], ps["carried_forward_paise"]) == (
        24000,
        54000,
        0,
    )
    pb = payout_of(w, b, "2026-09")
    assert (pb["status"], pb["net_paise"], pb["carried_in_paise"]) == ("draft", 60000, 0)

    # Re-running changes nothing; a September refund found later regenerates the draft.
    again = generate(w, "2026-09")
    assert (again["generated"], again["updated"], again["skipped"]) == (0, 2, 0)
    assert payout_of(w, a, "2026-09")["net_paise"] == 54000
    w.refund(sep_a, a, astrologer_paise=1200, commission_paise=800, at=utc("2026-09-20T06:00:00"))
    generate(w, "2026-09")
    ps = payout_of(w, a, "2026-09")
    assert (ps["refunds_paise"], ps["net_paise"], ps["status"]) == (1200, 52800, "draft")

    # Approved rows are never regenerated.
    assert admin_post(w, ps["id"], "approve").status_code == 200
    w.work(a, count=5, at=utc("2026-09-25T06:00:00"))
    third = generate(w, "2026-09")
    assert (third["updated"], third["skipped"]) == (1, 1)
    assert payout_of(w, a, "2026-09")["net_paise"] == 52800
    # August's void row is not regenerated either.
    assert payout_of(w, a, "2026-08")["carried_forward_paise"] == 24000

    count = sql(w.settings, "SELECT count(*) FROM payouts WHERE period = '2026-09'")
    assert count == 2


def test_generate_refuses_open_and_bad_periods(portal_world: PortalWorld) -> None:
    w = portal_world
    current = earnings.ist_today().strftime("%Y-%m")
    for period, code in ((current, "period_open"), ("2099-01", "period_open"), ("2026-13", None)):
        r = w.client.post("/v1/admin/payouts/generate", json={"period": period}, headers=w.admin)
        assert r.status_code == 422, r.text
        if code:
            assert r.json()["detail"]["code"] == code


def test_admin_void_carries_into_the_next_generation(portal_world: PortalWorld) -> None:
    w = portal_world
    w.work(w.b_id, count=50, at=JUL)  # 60000
    generate(w, "2026-07")
    pj = payout_of(w, w.b_id, "2026-07")
    assert admin_post(w, pj["id"], "approve").status_code == 200
    r = admin_post(w, pj["id"], "void", {"note": "Bank account closed; pay with August."})
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["carried_forward_paise"]) == ("void", 60000)
    assert r.json()["void_reason"] == "admin"
    # Void again, approve or pay a void row: refused.
    for refused in (
        admin_post(w, pj["id"], "void", {"note": "x"}),
        admin_post(w, pj["id"], "approve"),
        pay(w, pj["id"]),
    ):
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "invalid_transition"

    # No August activity, but the carry is there: a payout for it is generated.
    generate(w, "2026-08")
    pa = payout_of(w, w.b_id, "2026-08")
    assert (pa["status"], pa["gross_paise"], pa["carried_in_paise"], pa["net_paise"]) == (
        "draft",
        0,
        60000,
        60000,
    )
    # A's has no activity and nothing to carry: no row.
    items = w.client.get("/v1/admin/payouts", params={"period": "2026-08"}, headers=w.admin)
    assert [p["astrologer"]["id"] for p in items.json()["items"]] == [str(w.b_id)]


def test_out_of_order_generation_never_counts_twice(portal_world: PortalWorld) -> None:
    w = portal_world
    w.work(w.b_id, count=50, at=AUG)  # 60000 in August
    w.work(w.b_id, count=50, at=SEP)  # 60000 in September
    generate(w, "2026-09")  # August is not generated yet: its money is carried into September
    ps = payout_of(w, w.b_id, "2026-09")
    assert (ps["carried_in_paise"], ps["net_paise"]) == (60000, 120000)
    late = generate(w, "2026-08")
    assert late["skipped"] == 1 and late["generated"] == 0
    items = w.client.get("/v1/admin/payouts", params={"period": "2026-08"}, headers=w.admin)
    assert items.json()["items"] == []


# ---------------------------------------------------------------- paying


def test_mark_paid_posts_the_ledger_once(portal_world: PortalWorld) -> None:
    w = portal_world
    w.work(w.b_id, count=50, at=AUG)  # 60000
    generate(w, "2026-08")
    p = payout_of(w, w.b_id, "2026-08")
    assert pay(w, p["id"]).json()["detail"]["code"] == "invalid_transition"
    assert payout_postings(w, p["id"]) == []
    approved = admin_post(w, p["id"], "approve")
    assert approved.status_code == 200 and approved.json()["approved_at"]
    assert admin_post(w, p["id"], "approve").status_code == 409

    before = w.payable(w.b_id)
    r = pay(w, p["id"])
    assert r.status_code == 200, r.text
    paid = r.json()
    assert paid["status"] == "paid" and paid["reference"] == "UTR0000123456789"
    assert paid["paid_at"] and paid["paid_on"] == earnings.ist_today().isoformat()
    assert payout_postings(w, p["id"]) == sorted(
        [
            (wallet.payable_account(w.b_id), "debit", 60000),
            (wallet.BANK_PAYOUTS, "credit", 60000),
        ]
    )
    assert w.payable(w.b_id) == before - 60000

    # Same request again: same answer, no second posting. A different reference: refused.
    again = pay(w, p["id"])
    assert again.status_code == 200 and again.json() == paid
    other = pay(w, p["id"], reference="UTR999999999999")
    assert other.status_code == 409 and other.json()["detail"]["code"] == "invalid_transition"
    assert len(payout_postings(w, p["id"])) == 2
    assert admin_post(w, p["id"], "void", {"note": "too late"}).status_code == 409

    # The astrologer's balance shows the last payout; the next period carries nothing.
    bal = w.client.get("/v1/astrologer/me/balance", headers=w.b_headers).json()
    assert bal["payable_paise"] == 0
    assert bal["last_payout"]["period"] == "2026-08" and bal["last_payout"]["net_paise"] == 60000
    w.work(w.b_id, count=50, at=SEP)
    generate(w, "2026-09")
    assert payout_of(w, w.b_id, "2026-09")["carried_in_paise"] == 0


@pytest.mark.parametrize(
    "body",
    [
        {"reference": "", "paid_on": "2026-09-01"},
        {"reference": "UTR 123 = bad", "paid_on": "2026-09-01"},
        {"reference": "UTR0000123456789", "paid_on": "2099-01-01"},
        {"reference": "UTR0000123456789"},
    ],
)
def test_mark_paid_validates(portal_world: PortalWorld, body: dict[str, Any]) -> None:
    w = portal_world
    w.work(w.b_id, count=50, at=AUG)
    generate(w, "2026-08")
    p = payout_of(w, w.b_id, "2026-08")
    admin_post(w, p["id"], "approve")
    assert admin_post(w, p["id"], "mark-paid", body).status_code == 422
    assert payout_postings(w, p["id"]) == []


def test_mark_paid_is_concurrency_safe(portal_world: PortalWorld) -> None:
    w = portal_world
    w.work(w.b_id, count=50, at=AUG)
    generate(w, "2026-08")
    p = payout_of(w, w.b_id, "2026-08")
    admin_post(w, p["id"], "approve")
    pid = uuid.UUID(p["id"])

    async def race() -> list[str]:
        engine = make_engine(w.settings.database_url.get_secret_value())
        maker = make_sessionmaker(engine)

        async def one() -> str:
            async with maker() as db:
                try:
                    row = await payouts.mark_paid(
                        db,
                        pid,
                        reference="UTR0000123456789",
                        paid_on=earnings.ist_today(),
                        actor="test",
                    )
                    await db.commit()
                    return row.status
                except payouts.PayoutError as exc:
                    return exc.code

        try:
            return list(await asyncio.gather(*(one() for _ in range(8))))
        finally:
            await engine.dispose()

    assert asyncio.run(race()) == ["paid"] * 8
    assert len(payout_postings(w, p["id"])) == 2
    keys = sql(
        w.settings,
        "SELECT count(*) FROM ledger_transactions WHERE kind = 'payout'",
    )
    assert keys == 1


def test_paying_more_than_payable_is_refused(portal_world: PortalWorld) -> None:
    w = portal_world
    sid = w.work(w.b_id, count=50, at=AUG)  # 60000 payable
    generate(w, "2026-08")
    p = payout_of(w, w.b_id, "2026-08")
    admin_post(w, p["id"], "approve")
    # A refund posted today takes 1200 back from the astrologer: payable is now 58800.
    w.refund(sid, w.b_id, astrologer_paise=1200, commission_paise=800, at=None)
    r = pay(w, p["id"])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "exceeds_payable"
    assert r.json()["detail"]["payable_paise"] == 58800
    assert payout_postings(w, p["id"]) == []
    assert payout_of(w, w.b_id, "2026-08")["status"] == "approved"


def test_wallet_post_payout(portal_world: PortalWorld) -> None:
    w = portal_world
    w.work(w.a_id, count=10, at=None)  # 12000 payable

    async def go(db: AsyncSession) -> None:
        with pytest.raises(wallet.PayoutExceedsPayable) as exc:
            await wallet.post_payout(
                db, payout_id=uuid.uuid4(), astrologer_id=w.a_id, amount_paise=12001
            )
        assert exc.value.payable_paise == 12000
        pid = uuid.uuid4()
        first = await wallet.post_payout(db, payout_id=pid, astrologer_id=w.a_id, amount_paise=7000)
        again = await wallet.post_payout(db, payout_id=pid, astrologer_id=w.a_id, amount_paise=7000)
        assert first.created and not again.created
        assert again.transaction_id == first.transaction_id
        with pytest.raises(wallet.IdempotencyConflict):
            await wallet.post_payout(db, payout_id=pid, astrologer_id=w.a_id, amount_paise=1)
        with pytest.raises(ValueError):
            await wallet.post_payout(
                db, payout_id=uuid.uuid4(), astrologer_id=w.a_id, amount_paise=0
            )
        assert await wallet.account_balance(db, wallet.payable_account(w.a_id)) == 5000
        assert await wallet.account_balance(db, wallet.BANK_PAYOUTS) == -7000
        tx = (
            await db.execute(
                select(LedgerTransaction).where(
                    LedgerTransaction.idempotency_key == f"payout:{pid}"
                )
            )
        ).scalar_one()
        assert (tx.kind, tx.astrologer_id, tx.external_ref) == ("payout", w.a_id, str(pid))

    w.db(go)


# ---------------------------------------------------------------- views, audit, statements


def test_every_admin_action_is_audited_without_personal_data(portal_world: PortalWorld) -> None:
    w = portal_world
    w.work(w.b_id, count=50, at=AUG)
    w.work(w.a_id, count=50, at=AUG)
    generate(w, "2026-08")
    pb, pa = payout_of(w, w.b_id, "2026-08"), payout_of(w, w.a_id, "2026-08")
    admin_post(w, pb["id"], "approve")
    pay(w, pb["id"])
    admin_post(w, pa["id"], "void", {"note": "Call +919855550101 about the account"})

    async def go(db: AsyncSession) -> list[AuditLog]:
        return list(
            (
                await db.execute(
                    select(AuditLog).where(AuditLog.action.like("payout%")).order_by(AuditLog.id)
                )
            ).scalars()
        )

    rows = w.db(go)
    assert [r.action for r in rows] == [
        "payouts.generate",
        "payout.approve",
        "payout.mark_paid",
        "payout.void",
    ]
    assert all(r.actor.startswith("user:") for r in rows)
    assert rows[0].detail["period"] == "2026-08" and rows[0].detail["generated"] == 2
    assert rows[2].detail["net_paise"] == 60000 and rows[2].detail["transaction_id"]
    text_of_all = str([(r.detail, r.entity_id) for r in rows])
    for secret in (ASTRO_A, USER_1, "9855550101", "Call", "UTR0000123456789"):
        assert secret not in text_of_all


def test_admin_only(portal_world: PortalWorld) -> None:
    w = portal_world
    for method, path in (
        ("get", "/v1/admin/payouts"),
        ("post", "/v1/admin/payouts/generate"),
        ("get", f"/v1/admin/payouts/{uuid.uuid4()}"),
        ("post", f"/v1/admin/payouts/{uuid.uuid4()}/approve"),
    ):
        r = getattr(w.client, method)(path, headers=w.a_headers)
        assert r.status_code == 403, (path, r.text)
    assert w.client.get(f"/v1/admin/payouts/{uuid.uuid4()}", headers=w.admin).status_code == 404


def test_astrologer_statements(portal_world: PortalWorld) -> None:
    w = portal_world
    s_jul = w.work(w.a_id, count=50, at=JUL)
    w.work(w.a_id, count=10, at=AUG)  # 12000: void, carried into September
    w.work(w.a_id, count=45, at=SEP, kind="call")
    w.refund(s_jul, w.a_id, astrologer_paise=1200, commission_paise=800, at=SEP)
    w.work(w.b_id, count=50, at=SEP)
    for period in ("2026-07", "2026-08", "2026-09"):
        generate(w, period)

    listing = w.client.get("/v1/astrologer/me/payouts", headers=w.a_headers)
    assert listing.status_code == 200
    items = listing.json()["items"]
    assert [p["period"] for p in items] == ["2026-09", "2026-08", "2026-07"]
    sep = items[0]
    assert (sep["net_paise"], sep["carried_in_paise"]) == (45 * 1200 - 1200 + 12000, 12000)
    assert sep["reference"] is None and "tax_note" in sep

    detail = w.client.get(f"/v1/astrologer/me/payouts/{sep['id']}", headers=w.a_headers).json()
    lines = detail["lines"]
    assert len(lines) == 2  # September's call, and July's session refunded in September
    assert sum(line["net_paise"] for line in lines) == sep["net_paise"] - 12000
    assert {line["kind"] for line in lines} == {"call", "chat"}
    assert detail["adjustments"] == [
        {"kind": "carried_forward_in", "amount_paise": 12000, "period": "2026-08"}
    ]
    aug = w.client.get(f"/v1/astrologer/me/payouts/{items[1]['id']}", headers=w.a_headers)
    assert aug.json()["status"] == "void"
    assert aug.json()["adjustments"] == [
        {"kind": "carried_forward_out", "amount_paise": 12000, "period": "2026-09"}
    ]
    jul = w.client.get(f"/v1/astrologer/me/payouts/{items[2]['id']}", headers=w.a_headers)
    assert jul.json()["adjustments"] == []
    assert "TDS" in detail["tax_note"] and "GST" in detail["tax_note"]

    # Another astrologer's statement is not found.
    other = payout_of(w, w.b_id, "2026-09")["id"]
    assert (
        w.client.get(f"/v1/astrologer/me/payouts/{other}", headers=w.a_headers).status_code == 404
    )
    assert (
        w.client.get(
            f"/v1/astrologer/me/payouts/{other}/statement.csv", headers=w.a_headers
        ).status_code
        == 404
    )

    r = w.client.get(f"/v1/astrologer/me/payouts/{sep['id']}/statement.csv", headers=w.a_headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    assert r.headers["cache-control"] == "no-store"
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0][:3] == ["session_id", "kind", "started_at"]
    session_rows = [row for row in rows[1:] if len(row) > 1 and row[0] and row[0][0].isalnum()]
    assert {row[0] for row in session_rows} >= {line["session_id"] for line in lines}
    flat = r.text
    assert "TDS" in flat and "GST" in flat
    assert "+91" not in flat

    # Admin detail: the same plus bank-detail placeholders.
    admin_view = w.client.get(f"/v1/admin/payouts/{sep['id']}", headers=w.admin).json()
    assert admin_view["lines"] == lines
    assert set(admin_view["bank"]) >= {"account_holder", "account_number_last4", "ifsc"}
    assert admin_view["astrologer"]["id"] == str(w.a_id)


def test_csv_is_escaped_and_injection_safe() -> None:
    out = payouts.render_csv(
        [
            ['=HYPERLINK("http://x")', "+1", "-2+3", "@SUM(A1)", "\tcmd", "a,b", 'say "hi"'],
            [-120, 0, 55],
        ]
    )
    rows = list(csv.reader(io.StringIO(out)))
    assert rows[0] == [
        '\'=HYPERLINK("http://x")',
        "'+1",
        "'-2+3",
        "'@SUM(A1)",
        "'\tcmd",
        "a,b",
        'say "hi"',
    ]
    # Integers are written as numbers (an int cannot carry a formula).
    assert rows[1] == ["-120", "0", "55"]


# ---------------------------------------------------------------- CLI


def test_cli_generate(portal_world: PortalWorld, monkeypatch: pytest.MonkeyPatch, capsys) -> None:  # type: ignore[no-untyped-def]
    w = portal_world
    w.work(w.b_id, count=50, at=AUG)
    monkeypatch.setenv("DATABASE_URL", w.settings.database_url.get_secret_value())
    monkeypatch.setenv("REDIS_URL", w.settings.redis_url.get_secret_value())
    monkeypatch.setenv("SECRET_KEY", w.settings.secret_key.get_secret_value())
    get_settings.cache_clear()
    try:
        assert cli.main(["payouts", "generate", "--period", "2026-08"]) == 0
        out = capsys.readouterr().out
        assert "period=2026-08" in out and "generated=1" in out
        assert cli.main(["payouts", "generate"]) == 0  # previous IST month
        assert f"period={earnings.previous_period()}" in capsys.readouterr().out
        assert cli.main(["payouts", "generate", "--period", "2099-01"]) == 2
    finally:
        get_settings.cache_clear()

    async def count(db: AsyncSession) -> int:
        return int((await db.execute(select(func.count()).select_from(Payout))).scalar_one())

    assert w.db(count) >= 1
