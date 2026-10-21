"""Astrologer earnings from the ledger (docs/api/portal.md §2.3, ADR-0002).

Every figure comes from ledger entries, never from session rows:

- `gross`: consultation charges (real + promo), i.e. the astrologer's payable credit plus the
  `platform:commission` credit of each `consultation` transaction that credits the astrologer;
- `commission`: those commission credits;
- `refunds`: the astrologer's share of refunds, i.e. the payable debit of `refund` transactions;
- `net = gross - commission - refunds`; `minutes` = consultation transactions (one per billed
  minute); `sessions` = distinct sessions with a consultation charge in the range.

Activity is placed in time by `ledger_transactions.occurred_at`, on IST (`Asia/Kolkata`) day and
month boundaries. A refund counts when it is posted, so a refund of last month's session lands
in this month. Payout postings (`kind = payout`) are not earnings and are ignored here.
"""

import datetime as dt
import re
import uuid
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import wallet

IST = ZoneInfo("Asia/Kolkata")
MAX_RANGE_DAYS = 366
_PERIOD = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")
_EPOCH = dt.datetime(2000, 1, 1, tzinfo=dt.UTC)

# ---------------------------------------------------------------- IST calendar


def ist_today() -> dt.date:
    return dt.datetime.now(IST).date()


def _ist_midnight(day: dt.date) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(0), IST).astimezone(dt.UTC)


def range_bounds(first: dt.date, last: dt.date) -> tuple[dt.datetime, dt.datetime]:
    """UTC [start, end) covering IST dates `first`..`last` inclusive."""
    return _ist_midnight(first), _ist_midnight(last + dt.timedelta(days=1))


def parse_period(period: str) -> tuple[int, int]:
    m = _PERIOD.match(period)
    if m is None:
        raise ValueError(f"period must be YYYY-MM: {period!r}")
    return int(m.group(1)), int(m.group(2))


def period_dates(period: str) -> tuple[dt.date, dt.date]:
    """First and last IST date of a period."""
    year, month = parse_period(period)
    first = dt.date(year, month, 1)
    nxt = dt.date(year + month // 12, month % 12 + 1, 1)
    return first, nxt - dt.timedelta(days=1)


def month_bounds(period: str) -> tuple[dt.datetime, dt.datetime]:
    """UTC [start, end) of an IST month "YYYY-MM"."""
    return range_bounds(*period_dates(period))


def period_of(day: dt.date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def previous_period(today: dt.date | None = None) -> str:
    """The IST month before `today`'s (default: now)."""
    first = (today or ist_today()).replace(day=1)
    return period_of(first - dt.timedelta(days=1))


# ---------------------------------------------------------------- totals


@dataclass(frozen=True)
class Totals:
    gross_paise: int = 0
    commission_paise: int = 0
    refunds_paise: int = 0
    sessions: int = 0
    minutes: int = 0

    @property
    def net_paise(self) -> int:
        return self.gross_paise - self.commission_paise - self.refunds_paise

    @property
    def active(self) -> bool:
        return bool(self.gross_paise or self.refunds_paise or self.minutes)

    def as_dict(self) -> dict[str, int]:
        return {
            "gross_paise": self.gross_paise,
            "commission_paise": self.commission_paise,
            "refunds_paise": self.refunds_paise,
            "net_paise": self.net_paise,
            "sessions": self.sessions,
            "minutes": self.minutes,
        }


# One row per (payable account, transaction) in [start, end): the payable credit and debit and
# the commission credit of the same transaction. `{pred}` picks the payable account(s).
_PER_TXN = """
x AS (
  SELECT p.account_id, t.kind, t.session_id, t.occurred_at,
    coalesce(sum(p.amount_paise) FILTER (WHERE p.direction = 'credit'), 0) AS payable_credit,
    coalesce(sum(p.amount_paise) FILTER (WHERE p.direction = 'debit'), 0) AS payable_debit,
    coalesce((SELECT sum(c.amount_paise) FROM ledger_entries c WHERE c.transaction_id = t.id
      AND c.account_id = :commission AND c.direction = 'credit'), 0) AS commission_credit
  FROM ledger_transactions t
  JOIN ledger_entries p ON p.transaction_id = t.id AND {pred}
  WHERE t.kind IN ('consultation', 'refund') AND t.occurred_at >= :start AND t.occurred_at < :end
  GROUP BY p.account_id, t.id
)
"""
_ONE = "p.account_id = :payable"
_ALL = r"p.account_id LIKE 'astrologer:%\:payable'"  # "\:" keeps text() from binding ":payable"
_AGG = """
  coalesce(sum(payable_credit + commission_credit) FILTER (WHERE kind = 'consultation'), 0)
    AS gross,
  coalesce(sum(commission_credit) FILTER (WHERE kind = 'consultation'), 0) AS commission,
  coalesce(sum(payable_debit) FILTER (WHERE kind = 'refund'), 0) AS refunds,
  count(DISTINCT session_id) FILTER (WHERE kind = 'consultation') AS sessions,
  count(*) FILTER (WHERE kind = 'consultation') AS minutes
"""


def _totals(row: Any) -> Totals:
    return Totals(
        gross_paise=int(row.gross),
        commission_paise=int(row.commission),
        refunds_paise=int(row.refunds),
        sessions=int(row.sessions),
        minutes=int(row.minutes),
    )


def _params(start: dt.datetime, end: dt.datetime, **extra: Any) -> dict[str, Any]:
    return {"start": start, "end": end, "commission": wallet.COMMISSION, **extra}


async def totals(
    db: AsyncSession, astrologer_id: uuid.UUID, start: dt.datetime, end: dt.datetime
) -> Totals:
    row = (
        await db.execute(
            text(f"WITH {_PER_TXN.format(pred=_ONE)} SELECT {_AGG} FROM x"),  # noqa: S608 - fixed fragments
            _params(start, end, payable=wallet.payable_account(astrologer_id)),
        )
    ).one()
    return _totals(row)


async def by_day(
    db: AsyncSession, astrologer_id: uuid.UUID, first: dt.date, last: dt.date
) -> list[dict[str, Any]]:
    """Every IST date from `first` to `last`, zeros included (a chart needs no gap filling)."""
    start, end = range_bounds(first, last)
    rows = (
        await db.execute(
            text(
                f"WITH {_PER_TXN.format(pred=_ONE)} SELECT"  # noqa: S608 - fixed fragments
                " (occurred_at AT TIME ZONE 'Asia/Kolkata')::date AS day,"
                f" {_AGG} FROM x GROUP BY 1"
            ),
            _params(start, end, payable=wallet.payable_account(astrologer_id)),
        )
    ).all()
    found = {r.day: _totals(r) for r in rows}
    out = []
    day = first
    while day <= last:
        out.append({"date": day.isoformat(), **found.get(day, Totals()).as_dict()})
        day += dt.timedelta(days=1)
    return out


@dataclass(frozen=True)
class SessionLine:
    session_id: uuid.UUID
    kind: str
    started_at: dt.datetime | None
    ended_at: dt.datetime | None
    user_id: uuid.UUID | None
    totals: Totals


async def session_lines(
    db: AsyncSession,
    astrologer_id: uuid.UUID,
    start: dt.datetime,
    end: dt.datetime,
    *,
    offset: int = 0,
    limit: int | None = None,
) -> list[SessionLine]:
    """Per-session activity in [start, end), newest activity first (then session id). The
    amounts are the session's ledger activity inside the range, so the lines sum to `totals`.
    Kind and times come from the session row (labels only, never money)."""
    page = "" if limit is None else "LIMIT :limit OFFSET :offset"
    rows = (
        await db.execute(
            text(
                f"WITH {_PER_TXN.format(pred=_ONE)}, s AS ("  # noqa: S608 - fixed fragments
                f" SELECT session_id, max(occurred_at) AS last_at, {_AGG}"
                " FROM x GROUP BY session_id)"
                " SELECT s.*, cs.kind AS session_kind, cs.started_at, cs.ended_at, cs.user_id"
                " FROM s LEFT JOIN consult_sessions cs ON cs.id = s.session_id"
                f" ORDER BY s.last_at DESC, s.session_id {page}"
            ),
            _params(
                start,
                end,
                payable=wallet.payable_account(astrologer_id),
                **({} if limit is None else {"limit": limit, "offset": offset}),
            ),
        )
    ).all()
    return [
        SessionLine(
            session_id=r.session_id,
            kind=str(r.session_kind or "chat"),
            started_at=r.started_at,
            ended_at=r.ended_at,
            user_id=r.user_id,
            totals=_totals(r),
        )
        for r in rows
        if r.session_id is not None
    ]


def _astrologer_of(account_id: str) -> uuid.UUID:
    return uuid.UUID(account_id.split(":")[1])


async def totals_by_astrologer(
    db: AsyncSession, start: dt.datetime, end: dt.datetime
) -> dict[uuid.UUID, Totals]:
    """Totals for every astrologer with ledger activity in [start, end)."""
    rows = (
        await db.execute(
            text(
                f"WITH {_PER_TXN.format(pred=_ALL)}"  # noqa: S608 - fixed fragments
                f" SELECT account_id, {_AGG} FROM x GROUP BY account_id"
            ),
            _params(start, end),
        )
    ).all()
    return {_astrologer_of(r.account_id): _totals(r) for r in rows}


async def net_before(db: AsyncSession, end: dt.datetime) -> dict[uuid.UUID, int]:
    """Per astrologer: everything earned net of refunds (payable credits - debits of
    consultation and refund transactions) before `end`."""
    rows = (
        await db.execute(
            text(
                f"WITH {_PER_TXN.format(pred=_ALL)}"  # noqa: S608 - fixed fragments
                " SELECT account_id, sum(payable_credit - payable_debit) AS net"
                " FROM x GROUP BY account_id"
            ),
            _params(_EPOCH, end),
        )
    ).all()
    return {_astrologer_of(r.account_id): int(r.net) for r in rows}
