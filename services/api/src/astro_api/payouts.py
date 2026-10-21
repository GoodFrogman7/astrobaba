"""Monthly astrologer payouts (docs/api/portal.md §3). Transfers are manual in v1.

Generation, per IST month `P` and astrologer, from the ledger (astro_api.earnings):

- `gross`, `commission`, `refunds`, `sessions`, `minutes`: the month's ledger activity;
- `carried_in` = everything earned net of refunds before `P`, minus the net of the astrologer's
  payouts for earlier periods that are not void (draft, approved or paid). So the net of a void
  payout (below the minimum, or voided by an admin) and any earnings from before the first
  statement roll into the next generation by construction, and are never lost or paid twice;
- `net = gross - commission - refunds + carried_in`. Net below `payouts.min_payout_paise`
  (billing.json) → the row is `void` (`void_reason: below_minimum`) with
  `carried_forward_paise = net`; otherwise `draft`.

A row is created when the astrologer had activity in `P` or has a non-zero carry. One row per
astrologer per period (UNIQUE). Re-running regenerates `draft` rows only. An astrologer that
already has a payout for a later period is skipped (its carry already includes this period).
Only periods that have ended (IST) can be generated. Runs are serialised by an advisory lock.

Approve (draft → approved), mark-paid (approved → paid; posts `payout:{id}` through
`wallet.post_payout`, never above the payable balance) and void (draft/approved → void, net
carried forward) lock the row, so concurrent admins and retries are safe. Every action is
audited with ids and amounts only; the admin's void note and the bank reference stay on the row.
Functions do not commit: the caller does.
"""

import csv
import datetime as dt
import io
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api import billing_config, earnings, wallet
from astro_api.audit import audit
from astro_api.config import Settings
from astro_api.models import Astrologer
from astro_api.models_portal import Payout
from astro_api.session_service import client_label

SYSTEM_ACTOR = "system:payouts"
OPEN_STATUSES = ("draft", "approved", "paid")  # statuses whose net is no longer carried
TAX_NOTE = (
    "Tax deduction at source (TDS) and GST are not modelled in this statement until a "
    "chartered accountant confirms their treatment. Amounts are gross of any tax."
)
REFERENCE = re.compile(r"^[A-Za-z0-9-]{6,40}$")
_GENERATE_LOCK = 0x70617930  # pg_advisory_xact_lock key for generation runs ("pay0")


class PayoutError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


def min_payout_paise() -> int:
    return int(billing_config.billing()["payouts"]["min_payout_paise"])


def _now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


# ---------------------------------------------------------------- generation


@dataclass
class GenerateResult:
    period: str
    generated: int = 0  # new rows
    updated: int = 0  # drafts regenerated
    skipped: int = 0  # rows left alone (not draft) and astrologers with a later payout
    carried_forward: int = 0  # rows generated or updated that are void below the minimum
    payouts: list[Payout] = field(default_factory=list)


async def _earlier_open_net(db: AsyncSession, period: str) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        select(Payout.astrologer_id, func.sum(Payout.net_paise))
        .where(Payout.period < period, Payout.status.in_(OPEN_STATUSES))
        .group_by(Payout.astrologer_id)
    )
    return {aid: int(total) for aid, total in rows.all()}


async def _with_later_payouts(db: AsyncSession, period: str) -> set[uuid.UUID]:
    rows = await db.execute(select(Payout.astrologer_id).where(Payout.period > period).distinct())
    return set(rows.scalars())


def _fill(p: Payout, t: earnings.Totals, carried_in: int, minimum: int, actor: str) -> None:
    now = _now()
    p.gross_paise = t.gross_paise
    p.commission_paise = t.commission_paise
    p.refunds_paise = t.refunds_paise
    p.sessions = t.sessions
    p.minutes = t.minutes
    p.carried_in_paise = carried_in
    p.net_paise = t.net_paise + carried_in
    p.generated_at = now
    if p.net_paise >= minimum:
        p.status = "draft"
        p.carried_forward_paise = 0
        p.voided_at = p.voided_by = p.void_reason = None
    else:
        p.status = "void"
        p.carried_forward_paise = p.net_paise
        p.voided_at = now
        p.voided_by = actor
        p.void_reason = "below_minimum"


async def generate(
    db: AsyncSession, period: str, *, actor: str, today: dt.date | None = None
) -> GenerateResult:
    """Generate (or regenerate drafts of) every astrologer's payout for an ended IST month."""
    try:
        start, end = earnings.month_bounds(period)
    except ValueError as exc:
        raise PayoutError(422, "invalid_period", "Period must be YYYY-MM.") from exc
    if earnings.period_dates(period)[1] >= (today or earnings.ist_today()):
        raise PayoutError(422, "period_open", "Only months that have ended can be paid out.")
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _GENERATE_LOCK})

    activity = await earnings.totals_by_astrologer(db, start, end)
    before = await earnings.net_before(db, start)
    open_net = await _earlier_open_net(db, period)
    later = await _with_later_payouts(db, period)
    known = set(
        (
            await db.execute(
                select(Astrologer.id).where(Astrologer.id.in_(set(activity) | set(before)))
            )
        ).scalars()
    )
    minimum = min_payout_paise()
    existing = {
        p.astrologer_id: p
        for p in (
            await db.execute(select(Payout).where(Payout.period == period).with_for_update())
        ).scalars()
    }
    result = GenerateResult(period)
    for aid in sorted(known):
        t = activity.get(aid, earnings.Totals())
        carried_in = before.get(aid, 0) - open_net.get(aid, 0)
        row = existing.get(aid)
        if row is None and not t.active and carried_in == 0:
            continue
        if aid in later:
            result.skipped += 1
            continue
        if row is None:
            row = Payout(id=uuid.uuid4(), astrologer_id=aid, period=period)
            _fill(row, t, carried_in, minimum, actor)
            db.add(row)
            result.generated += 1
        elif row.status == "draft":
            _fill(row, t, carried_in, minimum, actor)
            result.updated += 1
        else:
            result.skipped += 1
            result.payouts.append(row)
            continue
        if row.status == "void":
            result.carried_forward += 1
        result.payouts.append(row)
    await db.flush()
    audit(
        db,
        actor,
        "payouts.generate",
        "payout_period",
        period,
        period=period,
        generated=result.generated,
        updated=result.updated,
        skipped=result.skipped,
        carried_forward=result.carried_forward,
    )
    return result


# ---------------------------------------------------------------- admin actions


async def _locked(db: AsyncSession, payout_id: uuid.UUID) -> Payout:
    p = (
        await db.execute(select(Payout).where(Payout.id == payout_id).with_for_update())
    ).scalar_one_or_none()
    if p is None:
        raise PayoutError(404, "not_found", "Payout not found.")
    return p


def _transition(p: Payout, action: str) -> PayoutError:
    return PayoutError(
        409,
        "invalid_transition",
        f"A {p.status} payout cannot be {action}.",
        payout_status=p.status,
    )


async def get_payout(db: AsyncSession, *, astrologer_id: uuid.UUID, period: str) -> Payout:
    p = (
        await db.execute(
            select(Payout).where(Payout.astrologer_id == astrologer_id, Payout.period == period)
        )
    ).scalar_one_or_none()
    if p is None:
        raise PayoutError(404, "not_found", "Payout not found.")
    return p


async def approve(db: AsyncSession, payout_id: uuid.UUID, *, actor: str) -> Payout:
    p = await _locked(db, payout_id)
    if p.status != "draft":
        raise _transition(p, "approved")
    p.status = "approved"
    p.approved_at = _now()
    p.approved_by = actor
    await db.flush()
    audit(
        db,
        actor,
        "payout.approve",
        "payout",
        str(p.id),
        astrologer_id=str(p.astrologer_id),
        period=p.period,
        net_paise=p.net_paise,
    )
    return p


async def mark_paid(
    db: AsyncSession, payout_id: uuid.UUID, *, reference: str, paid_on: dt.date, actor: str
) -> Payout:
    """approved → paid, posting `payout:{id}` once. Repeating the same request returns the paid
    payout; a different reference for a paid payout is refused."""
    reference = reference.strip()
    if not REFERENCE.match(reference):
        raise PayoutError(422, "invalid_reference", "Reference must be the bank UTR.")
    if paid_on > earnings.ist_today():
        raise PayoutError(422, "invalid_paid_on", "paid_on cannot be in the future.")
    p = await _locked(db, payout_id)
    if p.status == "paid":
        if p.reference == reference and p.paid_on == paid_on:
            return p
        raise _transition(p, "marked paid again with a different reference or date")
    if p.status != "approved":
        raise _transition(p, "marked paid (approve it first)")
    try:
        posted = await wallet.post_payout(
            db, payout_id=p.id, astrologer_id=p.astrologer_id, amount_paise=p.net_paise
        )
    except wallet.PayoutExceedsPayable as exc:
        raise PayoutError(
            409,
            "exceeds_payable",
            "The payout is more than the astrologer's payable balance.",
            payable_paise=exc.payable_paise,
            net_paise=p.net_paise,
        ) from exc
    p.status = "paid"
    p.paid_at = _now()
    p.paid_on = paid_on
    p.paid_by = actor
    p.reference = reference
    p.transaction_id = posted.transaction_id
    await db.flush()
    audit(
        db,
        actor,
        "payout.mark_paid",
        "payout",
        str(p.id),
        astrologer_id=str(p.astrologer_id),
        period=p.period,
        net_paise=p.net_paise,
        transaction_id=str(posted.transaction_id),
        paid_on=paid_on.isoformat(),
    )
    return p


async def void(db: AsyncSession, payout_id: uuid.UUID, *, note: str, actor: str) -> Payout:
    """draft/approved → void. Its net is carried into the next generation."""
    p = await _locked(db, payout_id)
    if p.status not in ("draft", "approved"):
        raise _transition(p, "voided")
    previous = p.status
    p.status = "void"
    p.carried_forward_paise = p.net_paise
    p.voided_at = _now()
    p.voided_by = actor
    p.void_reason = "admin"
    p.void_note = note.strip() or None
    await db.flush()
    audit(
        db,
        actor,
        "payout.void",
        "payout",
        str(p.id),
        astrologer_id=str(p.astrologer_id),
        period=p.period,
        previous_status=previous,
        carried_forward_paise=p.carried_forward_paise,
    )
    return p


# ---------------------------------------------------------------- views


def _iso(v: dt.datetime | None) -> str | None:
    return v.astimezone(dt.UTC).isoformat() if v is not None else None


def payout_view(p: Payout) -> dict[str, Any]:
    return {
        "id": str(p.id),
        "period": p.period,
        "status": p.status,
        "gross_paise": p.gross_paise,
        "commission_paise": p.commission_paise,
        "refunds_paise": p.refunds_paise,
        "carried_in_paise": p.carried_in_paise,
        "net_paise": p.net_paise,
        "carried_forward_paise": p.carried_forward_paise,
        "sessions": p.sessions,
        "minutes": p.minutes,
        "generated_at": _iso(p.generated_at),
        "approved_at": _iso(p.approved_at),
        "paid_at": _iso(p.paid_at),
        "paid_on": p.paid_on.isoformat() if p.paid_on else None,
        "reference": p.reference if p.status == "paid" else None,
        "void_reason": p.void_reason,
        "tax_note": TAX_NOTE,
    }


def earning_row(line: earnings.SessionLine, settings: Settings) -> dict[str, Any]:
    t = line.totals
    return {
        "session_id": str(line.session_id),
        "kind": line.kind,
        "started_at": _iso(line.started_at),
        "ended_at": _iso(line.ended_at),
        "billed_minutes": t.minutes,
        "gross_paise": t.gross_paise,
        "commission_paise": t.commission_paise,
        "refunds_paise": t.refunds_paise,
        "net_paise": t.net_paise,
        "client_label": client_label(settings, line.user_id) if line.user_id else "Client",
    }


def next_period(period: str) -> str:
    return earnings.period_of(earnings.period_dates(period)[1] + dt.timedelta(days=1))


async def adjustments(db: AsyncSession, p: Payout) -> list[dict[str, Any]]:
    """`carried_forward_in`: the balance brought in (`period` = the latest earlier void payout,
    or the month before when the money was earned before any statement; negative = a debt from
    refunds after an earlier payout). `carried_forward_out`: a void payout's net, which rolls
    into the next period's generation (`period` = that next period)."""
    out: list[dict[str, Any]] = []
    if p.carried_in_paise:
        source = (
            await db.execute(
                select(func.max(Payout.period)).where(
                    Payout.astrologer_id == p.astrologer_id,
                    Payout.period < p.period,
                    Payout.status == "void",
                )
            )
        ).scalar_one_or_none()
        out.append(
            {
                "kind": "carried_forward_in",
                "amount_paise": p.carried_in_paise,
                "period": source or earnings.previous_period(earnings.period_dates(p.period)[0]),
            }
        )
    if p.status == "void" and p.carried_forward_paise:
        out.append(
            {
                "kind": "carried_forward_out",
                "amount_paise": p.carried_forward_paise,
                "period": next_period(p.period),
            }
        )
    return out


async def lines(db: AsyncSession, settings: Settings, p: Payout) -> list[dict[str, Any]]:
    start, end = earnings.month_bounds(p.period)
    return [
        earning_row(line, settings)
        for line in await earnings.session_lines(db, p.astrologer_id, start, end)
    ]


async def detail(db: AsyncSession, settings: Settings, p: Payout) -> dict[str, Any]:
    return {
        **payout_view(p),
        "lines": await lines(db, settings, p),
        "adjustments": await adjustments(db, p),
    }


# ---------------------------------------------------------------- CSV statement

_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
CSV_COLUMNS = (
    "session_id",
    "kind",
    "started_at",
    "ended_at",
    "billed_minutes",
    "gross_paise",
    "commission_paise",
    "refunds_paise",
    "net_paise",
    "client_label",
)


def csv_safe(value: str | int | None) -> str | int:
    """Spreadsheet-formula injection guard: a text cell starting with = + - @ (or tab / CR) gets
    a leading single quote. Integers are written as numbers; they cannot carry a formula."""
    if value is None:
        return ""
    if isinstance(value, int):
        return value
    return "'" + value if value.startswith(_FORMULA_START) else value


def render_csv(rows: Sequence[Sequence[str | int | None]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    for row in rows:
        writer.writerow([csv_safe(v) for v in row])
    return buf.getvalue()


async def statement_csv(db: AsyncSession, settings: Settings, p: Payout) -> str:
    rows: list[list[str | int | None]] = [list(CSV_COLUMNS)]
    for line in await lines(db, settings, p):
        rows.append([line[c] for c in CSV_COLUMNS])
    rows.append(
        [
            "TOTAL",
            "",
            "",
            "",
            p.minutes,
            p.gross_paise,
            p.commission_paise,
            p.refunds_paise,
            p.net_paise - p.carried_in_paise,
            "",
        ]
    )
    rows.append(["CARRIED_IN", "", "", "", "", "", "", "", p.carried_in_paise, ""])
    rows.append(["NET_PAYABLE", "", "", "", "", "", "", "", p.net_paise, ""])
    rows.append([])
    rows.append(["period", p.period])
    rows.append(["status", p.status])
    if p.status == "paid":
        rows.append(["paid_on", p.paid_on.isoformat() if p.paid_on else ""])
        rows.append(["reference", p.reference])
    if p.status == "void":
        rows.append(["carried_forward_paise", p.carried_forward_paise])
    rows.append(["note", TAX_NOTE])
    return render_csv(rows)
