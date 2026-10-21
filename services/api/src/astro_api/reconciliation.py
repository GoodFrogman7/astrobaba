"""Daily reconciliation (docs/api/billing.md, ADR-0002 §3).

Checks, each reported with issues (ids and amounts only):
1. transactions_balanced: every ledger transaction has entries and debits = credits.
2. projections: every balance projection and promo lot equals the sum of its entries, every
   user's promo projection equals the sum of their lots, and no projected account is missing.
3. gateway_payments: each payment the gateway captured on the day (IST) has exactly one recharge
   credit of the same amount, and each recharge credit of the day has a gateway payment.
4. settlements: each gateway settlement of the day has one clearing → bank posting with the same
   net amount and fees, and vice versa.

Any issue → status `drift` and an error-level `reconciliation_drift` log line for alerting.
"""

import datetime as dt
import logging
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config, wallet
from astro_api.models_ledger import ReconciliationRun
from astro_api.payments import FakeGateway, RazorpayGateway

log = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
MAX_ISSUES = 50

Issue = dict[str, Any]


def ist_today() -> dt.date:
    return dt.datetime.now(IST).date()


def default_day() -> dt.date:
    """Yesterday (IST): the last full day."""
    return ist_today() - dt.timedelta(days=1)


def day_bounds(day: dt.date) -> tuple[dt.datetime, dt.datetime]:
    start = dt.datetime.combine(day, dt.time(0), IST)
    return start.astimezone(dt.UTC), (start + dt.timedelta(days=1)).astimezone(dt.UTC)


def _result(name: str, issues: list[Issue], drift: int, count: int | None = None) -> Issue:
    out: Issue = {
        "name": name,
        "status": "drift" if issues else "ok",
        "drift_paise": drift,
        "issues": issues[:MAX_ISSUES],
        "issue_count": len(issues),
    }
    if count is not None:
        out["count"] = count
    return out


async def _balanced(db: AsyncSession) -> Issue:
    rows = (
        await db.execute(
            text(
                "SELECT t.id,"
                " coalesce(sum(e.amount_paise) FILTER (WHERE e.direction = 'debit'), 0),"
                " coalesce(sum(e.amount_paise) FILTER (WHERE e.direction = 'credit'), 0),"
                " count(e.id) FROM ledger_transactions t"
                " LEFT JOIN ledger_entries e ON e.transaction_id = t.id GROUP BY t.id"
                " HAVING count(e.id) = 0 OR coalesce(sum(e.amount_paise) FILTER"
                " (WHERE e.direction = 'debit'), 0) <> coalesce(sum(e.amount_paise) FILTER"
                " (WHERE e.direction = 'credit'), 0)"
            )
        )
    ).all()
    issues = [
        {"transaction_id": str(tid), "debit_paise": int(d), "credit_paise": int(c), "entries": n}
        for tid, d, c, n in rows
    ]
    return _result(
        "transactions_balanced",
        issues,
        sum(abs(i["debit_paise"] - i["credit_paise"]) for i in issues),
    )


async def _projections(db: AsyncSession) -> Issue:
    issues: list[Issue] = []
    accounts = (
        await db.execute(
            text(
                "WITH ledger AS (SELECT account_id, sum(CASE WHEN direction = 'credit' THEN"
                " amount_paise ELSE -amount_paise END) AS credit_minus_debit FROM ledger_entries"
                " WHERE account_id LIKE 'user:%' OR account_id LIKE 'astrologer:%'"
                " GROUP BY account_id)"
                " SELECT coalesce(b.account_id, l.account_id), b.balance_paise,"
                " CASE WHEN coalesce(b.normal_side, 'credit') = 'credit'"
                " THEN coalesce(l.credit_minus_debit, 0) ELSE -coalesce(l.credit_minus_debit, 0)"
                " END FROM account_balances b FULL JOIN ledger l ON l.account_id = b.account_id"
            )
        )
    ).all()
    for account_id, projected, ledger in accounts:
        if projected is None or int(projected) != int(ledger):
            issues.append(
                {
                    "account_id": account_id,
                    "projection_paise": None if projected is None else int(projected),
                    "ledger_paise": int(ledger),
                }
            )
    lots = (
        await db.execute(
            text(
                "SELECT l.id, l.remaining_paise, coalesce(sum(CASE WHEN e.direction = 'credit'"
                " THEN e.amount_paise ELSE -e.amount_paise END), 0) FROM promo_lots l"
                " LEFT JOIN ledger_entries e ON e.promo_lot_id = l.id"
                " GROUP BY l.id, l.remaining_paise"
            )
        )
    ).all()
    for lot_id, remaining, ledger in lots:
        if int(remaining) != int(ledger):
            issues.append(
                {"lot_id": str(lot_id), "lot_paise": int(remaining), "ledger_paise": int(ledger)}
            )
    promo = (
        await db.execute(
            text(
                "SELECT b.account_id, b.balance_paise, coalesce(sum(l.remaining_paise), 0)"
                " FROM account_balances b LEFT JOIN promo_lots l"
                " ON b.account_id = 'user:' || l.user_id::text || ':' || 'promo'"
                " WHERE b.account_id LIKE 'user:%promo' GROUP BY b.account_id, b.balance_paise"
                " HAVING b.balance_paise <> coalesce(sum(l.remaining_paise), 0)"
            )
        )
    ).all()
    for account_id, projected, lots_total in promo:
        issues.append(
            {
                "account_id": account_id,
                "projection_paise": int(projected),
                "lots_paise": int(lots_total),
            }
        )

    def diff(i: Issue) -> int:
        other = i.get("ledger_paise", i.get("lots_paise")) or 0
        mine = i.get("projection_paise", i.get("lot_paise")) or 0
        return abs(int(mine) - int(other))

    return _result("projections", issues, sum(diff(i) for i in issues))


async def _gateway_payments(
    db: AsyncSession, gateway: RazorpayGateway | FakeGateway, start: dt.datetime, end: dt.datetime
) -> Issue:
    captured = await gateway.captured_payments(int(start.timestamp()), int(end.timestamp()))
    credits = {
        str(ref): int(amount)
        for ref, amount in (
            await db.execute(
                text(
                    "SELECT t.external_ref, sum(e.amount_paise) FROM ledger_transactions t"
                    " JOIN ledger_entries e ON e.transaction_id = t.id"
                    " AND e.direction = 'credit' AND e.account_id LIKE 'user:%real'"
                    " WHERE t.kind = 'recharge' AND (t.external_ref = ANY(:ids)"
                    " OR (t.occurred_at >= :start AND t.occurred_at < :end))"
                    " GROUP BY t.external_ref"
                ),
                {"ids": [p.payment_id for p in captured], "start": start, "end": end},
            )
        ).all()
    }
    issues: list[Issue] = []
    seen = set()
    for p in captured:
        seen.add(p.payment_id)
        ledger = credits.get(p.payment_id, 0)
        if ledger != p.amount_paise:
            issues.append(
                {
                    "problem": "missing_credit" if ledger == 0 else "amount_mismatch",
                    "payment_id": p.payment_id,
                    "gateway_paise": p.amount_paise,
                    "ledger_paise": ledger,
                }
            )
    for ref, amount in credits.items():
        if ref not in seen:
            issues.append(
                {
                    "problem": "credit_without_payment",
                    "payment_id": ref,
                    "gateway_paise": 0,
                    "ledger_paise": amount,
                }
            )
    drift = sum(abs(i["gateway_paise"] - i["ledger_paise"]) for i in issues)
    return _result("gateway_payments", issues, drift, count=len(captured))


async def _settlements(
    db: AsyncSession, gateway: RazorpayGateway | FakeGateway, start: dt.datetime, end: dt.datetime
) -> Issue:
    reported = await gateway.settlements(int(start.timestamp()), int(end.timestamp()))
    rows = (
        await db.execute(
            text(
                "SELECT t.external_ref,"
                " coalesce(sum(e.amount_paise) FILTER (WHERE e.account_id = :bank"
                " AND e.direction = 'debit'), 0),"
                " coalesce(sum(e.amount_paise) FILTER (WHERE e.account_id = :fees"
                " AND e.direction = 'debit'), 0)"
                " FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id"
                " WHERE t.kind = 'settlement' AND (t.external_ref = ANY(:ids)"
                " OR (t.occurred_at >= :start AND t.occurred_at < :end))"
                " GROUP BY t.external_ref"
            ),
            {
                "bank": wallet.BANK,
                "fees": wallet.GATEWAY_FEES,
                "ids": [s.settlement_id for s in reported],
                "start": start,
                "end": end,
            },
        )
    ).all()
    posted = {str(ref): (int(net), int(fees)) for ref, net, fees in rows}
    issues: list[Issue] = []
    for s in reported:
        net, fees = posted.pop(s.settlement_id, (0, 0))
        if (net, fees) != (s.amount_paise, s.fees_paise):
            issues.append(
                {
                    "problem": "missing_settlement" if net == fees == 0 else "amount_mismatch",
                    "settlement_id": s.settlement_id,
                    "gateway_paise": s.amount_paise + s.fees_paise,
                    "ledger_paise": net + fees,
                    "gateway_fees_paise": s.fees_paise,
                    "ledger_fees_paise": fees,
                }
            )
    for ref, (net, fees) in posted.items():
        issues.append(
            {
                "problem": "settlement_without_report",
                "settlement_id": ref,
                "gateway_paise": 0,
                "ledger_paise": net + fees,
                "gateway_fees_paise": 0,
                "ledger_fees_paise": fees,
            }
        )
    drift = sum(
        abs(i["gateway_paise"] - i["ledger_paise"])
        + abs(i["gateway_fees_paise"] - i["ledger_fees_paise"])
        for i in issues
    )
    return _result("settlements", issues, drift, count=len(reported))


async def run(
    db: AsyncSession, gateway: RazorpayGateway | FakeGateway, day: dt.date, *, trigger: str
) -> ReconciliationRun:
    """Run all checks for `day` (IST) and store the run. Caller commits."""
    start, end = day_bounds(day)
    record = ReconciliationRun(
        run_date=day,
        status="running",
        trigger=trigger,
        checks=[],
        drift_paise=0,
        started_at=dt.datetime.now(dt.UTC),
    )
    db.add(record)
    await db.flush()
    try:
        checks = [
            await _balanced(db),
            await _projections(db),
            await _gateway_payments(db, gateway, start, end),
            await _settlements(db, gateway, start, end),
        ]
    except Exception as exc:
        log.error(
            "reconciliation_error",
            extra={
                "run_id": str(record.id),
                "run_date": day.isoformat(),
                "error": type(exc).__name__,
            },
        )
        record.status = "error"
        record.checks = [{"name": "error", "status": "error", "error": type(exc).__name__}]
        record.finished_at = dt.datetime.now(dt.UTC)
        await db.flush()
        return record
    drift = sum(int(c["drift_paise"]) for c in checks)
    failed = [c["name"] for c in checks if c["status"] != "ok"]
    tolerance = billing_config.reconciliation_tolerance_paise()
    within_tolerance = 0 < drift <= tolerance
    record.status = "drift" if failed and not within_tolerance else "ok"
    record.drift_paise = drift
    record.checks = checks
    record.finished_at = dt.datetime.now(dt.UTC)
    await db.flush()
    if record.status == "drift":
        log.error(
            "reconciliation_drift",
            extra={
                "run_id": str(record.id),
                "run_date": day.isoformat(),
                "drift_paise": drift,
                "failed_checks": failed,
            },
        )
    return record


def run_view(r: ReconciliationRun) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "date": r.run_date.isoformat(),
        "status": r.status,
        "drift_paise": r.drift_paise,
        "checks": r.checks,
        "trigger": r.trigger,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
    }
