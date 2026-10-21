"""Invariants checked straight from Postgres after a run (read-only).

1. Every ledger transaction balances (debits = credits), across the whole ledger.
2. Each run session's charge matches its billed minutes: billed_paise = billed_minutes x price,
   the user-side debits of its `consultation` transactions add up to the same amount, and there
   is exactly one charge per minute with keys `session:{id}:minute:1..n` (billing_meter).
3. The balance projections of the run's clients equal the sum of their ledger entries.
Also reported (not a failure): billed minutes against the active time (the partial last minute
is billed as a whole; the meter charges minute n+1 on its first tick after the boundary).
"""

import math
import uuid
from collections import Counter
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

UNBALANCED = text(
    """
    SELECT count(*) FROM (
      SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING sum(CASE WHEN direction = 'debit' THEN amount_paise ELSE -amount_paise END) <> 0
    ) x
    """
)
EMPTY = text(
    "SELECT count(*) FROM ledger_transactions t "
    "WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id = t.id)"
)
TOTAL = text("SELECT count(*) FROM ledger_transactions")
SESSIONS = text(
    """
    SELECT s.id, s.user_id, s.status, s.end_reason, s.started_at, s.ended_at,
           s.billed_minutes, s.billed_paise, s.price_per_min_paise,
           (SELECT array_agg(t.idempotency_key) FROM ledger_transactions t
             WHERE t.session_id = s.id AND t.kind = 'consultation') AS keys,
           (SELECT coalesce(sum(e.amount_paise), 0) FROM ledger_transactions t
             JOIN ledger_entries e ON e.transaction_id = t.id
             WHERE t.session_id = s.id AND t.kind = 'consultation'
               AND e.account_id LIKE 'user:%' AND e.direction = 'debit') AS user_debits,
           (SELECT count(*) FROM ledger_transactions t
             WHERE t.session_id = s.id AND t.kind = 'refund') AS refunds
    FROM consult_sessions s WHERE s.id = ANY(:ids)
    """
)
PROJECTIONS = text(
    """
    SELECT b.account_id, b.balance_paise,
           coalesce((SELECT sum(CASE WHEN e.direction = 'credit' THEN e.amount_paise
                                     ELSE -e.amount_paise END)
                     FROM ledger_entries e WHERE e.account_id = b.account_id), 0) AS entries
    FROM account_balances b WHERE b.account_id = ANY(:accounts)
    """
)


async def verify(
    sessionmaker: async_sessionmaker[AsyncSession],
    session_ids: list[str],
    minute_seconds: float,
) -> dict[str, Any]:
    ids = [uuid.UUID(s) for s in session_ids]
    problems: Counter[str] = Counter()
    timing: Counter[str] = Counter()
    async with sessionmaker() as db:
        unbalanced = int((await db.execute(UNBALANCED)).scalar_one())
        empty = int((await db.execute(EMPTY)).scalar_one())
        total = int((await db.execute(TOTAL)).scalar_one())
        rows = (await db.execute(SESSIONS, {"ids": ids})).mappings().all()
        users = {r["user_id"] for r in rows}
        accounts = [f"user:{u}:{side}" for u in users for side in ("real", "promo")]
        projections = (await db.execute(PROJECTIONS, {"accounts": accounts})).all()
    billed_seconds = 0.0
    refunds = 0
    for r in rows:
        n, price = int(r["billed_minutes"]), int(r["price_per_min_paise"])
        expected = n * price
        billed_seconds += n * minute_seconds
        refunds += int(r["refunds"])
        if int(r["billed_paise"]) != expected:
            problems["billed_paise != billed_minutes x price"] += 1
        if int(r["user_debits"]) != expected:
            problems["ledger charge != billed_minutes x price"] += 1
        keys = set(r["keys"] or [])
        if keys != {f"session:{r['id']}:minute:{k}" for k in range(1, n + 1)}:
            problems["charge keys != one per billed minute"] += 1
        if r["started_at"] is not None and r["ended_at"] is not None:
            active = (r["ended_at"] - r["started_at"]).total_seconds()
            started_minutes = max(1, math.ceil(active / minute_seconds))
            if n == started_minutes:
                timing["billed = minutes started"] += 1
            elif n == started_minutes - 1:
                timing["ended before the meter charged the minute in progress"] += 1
            else:
                problems["billed minutes outside the active time"] += 1
    for account, balance, entries in projections:
        if int(balance) != int(entries):
            problems[f"projection != entries ({account.rsplit(':', 1)[-1]})"] += 1
    missing = len(ids) - len(rows)
    if missing:
        problems["session rows missing"] += missing
    if unbalanced:
        problems["unbalanced ledger transactions"] += unbalanced
    return {
        "ok": not problems,
        "ledger_transactions_checked": total,
        "unbalanced_transactions": unbalanced,
        "transactions_without_entries": empty,
        "sessions_checked": len(rows),
        "billed_seconds": billed_seconds,
        "refund_transactions": refunds,
        "projections_checked": len(projections),
        "problems": dict(problems),
        "billing_vs_active_time": dict(timing),
    }
