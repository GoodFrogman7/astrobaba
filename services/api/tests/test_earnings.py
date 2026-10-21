"""Astrologer earnings (docs/api/portal.md §2.3), written before the implementation.

Figures come from ledger entries on `astrologer:{id}:payable` and the commission postings of the
same transactions, never from session rows; IST day and month boundaries; integer paise.
`by_day` lists every day in the range, zeros included.
"""

import datetime as dt
import uuid
from typing import Any

import pytest

from astro_api import earnings
from services.api.tests.test_payouts_support import (  # noqa: F401 - fixtures
    PortalWorld,
    portal_world_fixture,
    utc,
)

pytestmark = pytest.mark.integration

ZERO = {
    "gross_paise": 0,
    "commission_paise": 0,
    "refunds_paise": 0,
    "net_paise": 0,
    "sessions": 0,
    "minutes": 0,
}


def september(w: PortalWorld) -> dict[str, uuid.UUID]:
    """A's September 2026 (IST), plus noise that must not count:

    - s1 (chat, user 1): 3 minutes at 2000 paise, 4000 bps (commission 800, astrologer 1200 each)
      on 10 Sep; 15 Sep a refund taking 1200 from the astrologer and 800 commission.
    - s2 (call, user 2): 2 minutes at 999 paise, 3500 bps (commission 349, astrologer 650) at
      23:59 IST on 30 Sep, and minute 3 at 00:00 IST on 1 Oct (October, not September).
    - s0: 1 minute at 3000 / 4000 bps on 20 Aug; refunded on 5 Sep (astrologer 900,
      commission 600): an August session whose refund lands in September.
    - B earns in September too (not A's).
    """
    a = w.a_id
    s0 = w.work(a, count=1, at=utc("2026-08-20T06:00:00"), price=3000)
    w.refund(s0, a, astrologer_paise=900, commission_paise=600, at=utc("2026-09-05T06:00:00"))
    s1 = w.work(a, count=3, at=utc("2026-09-10T10:00:00"))
    w.refund(s1, a, astrologer_paise=1200, commission_paise=800, at=utc("2026-09-15T06:00:00"))

    async def s2_minutes(db: Any) -> uuid.UUID:
        from services.api.tests.test_payouts_support import minute, new_session

        sid = await new_session(db, w.u2, a, kind="call", started_at=utc("2026-09-30T18:28:00"))
        for n, at in (
            (1, utc("2026-09-30T18:28:00")),
            (2, utc("2026-09-30T18:29:59")),  # 23:59:59 IST, 30 Sep
            (3, utc("2026-09-30T18:30:00")),  # 00:00:00 IST, 1 Oct
        ):
            await minute(
                db, session_id=sid, user_id=w.u2, astrologer_id=a, n=n, price=999, bps=3500, at=at
            )
        return sid

    s2 = w.db(s2_minutes)
    w.work(w.b_id, count=4, at=utc("2026-09-12T10:00:00"))
    return {"s0": s0, "s1": s1, "s2": s2}


def test_ist_bounds() -> None:
    start, end = earnings.month_bounds("2026-09")
    assert start == utc("2026-08-31T18:30:00") and end == utc("2026-09-30T18:30:00")
    assert earnings.range_bounds(dt.date(2026, 9, 1), dt.date(2026, 9, 1)) == (
        utc("2026-08-31T18:30:00"),
        utc("2026-09-01T18:30:00"),
    )
    assert earnings.previous_period(dt.date(2026, 1, 15)) == "2025-12"
    assert earnings.previous_period(dt.date(2026, 10, 1)) == "2026-09"
    for bad in ("2026-13", "2026-9", "26-09", "2026-00", "abcd-ef"):
        with pytest.raises(ValueError):
            earnings.month_bounds(bad)


def test_totals_by_day_and_sessions_come_from_the_ledger(portal_world: PortalWorld) -> None:
    w = portal_world
    s = september(w)
    r = w.client.get(
        "/v1/astrologer/me/earnings",
        params={"from": "2026-09-01", "to": "2026-09-30"},
        headers=w.a_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["from"], body["to"]) == ("2026-09-01", "2026-09-30")
    # gross = 3 x 2000 + 2 x 999; commission = 3 x 800 + 2 x 349; refunds = 1200 + 900.
    assert body["totals"] == {
        "gross_paise": 7998,
        "commission_paise": 3098,
        "refunds_paise": 2100,
        "net_paise": 2800,
        "sessions": 2,
        "minutes": 5,
    }

    days = body["by_day"]
    assert [d["date"] for d in days] == [f"2026-09-{n:02d}" for n in range(1, 31)]
    by_date = {d.pop("date"): d for d in days}
    assert by_date["2026-09-05"] == {**ZERO, "refunds_paise": 900, "net_paise": -900}
    assert by_date["2026-09-10"] == {
        "gross_paise": 6000,
        "commission_paise": 2400,
        "refunds_paise": 0,
        "net_paise": 3600,
        "sessions": 1,
        "minutes": 3,
    }
    assert by_date["2026-09-15"] == {**ZERO, "refunds_paise": 1200, "net_paise": -1200}
    assert by_date["2026-09-30"] == {
        "gross_paise": 1998,
        "commission_paise": 698,
        "refunds_paise": 0,
        "net_paise": 1300,
        "sessions": 1,
        "minutes": 2,
    }
    assert by_date["2026-09-11"] == ZERO
    for total in ("gross_paise", "commission_paise", "refunds_paise", "net_paise", "minutes"):
        assert sum(d[total] for d in by_date.values()) == body["totals"][total]

    # Sessions: newest activity first; the amounts are the session's activity in the range.
    items = body["sessions"]["items"]
    assert [i["session_id"] for i in items] == [str(s["s2"]), str(s["s1"]), str(s["s0"])]
    s2, s1, s0 = items
    assert (s2["kind"], s2["billed_minutes"], s2["gross_paise"], s2["net_paise"]) == (
        "call",
        2,
        1998,
        1300,
    )
    assert (s1["gross_paise"], s1["commission_paise"], s1["refunds_paise"], s1["net_paise"]) == (
        6000,
        2400,
        1200,
        2400,
    )
    assert (s0["billed_minutes"], s0["gross_paise"], s0["refunds_paise"], s0["net_paise"]) == (
        0,
        0,
        900,
        -900,
    )
    for i in items:
        assert i["client_label"].startswith("Client ")
        assert "user_id" not in i and "phone" not in i
    assert body["sessions"]["next_cursor"] is None

    # October 1 (IST) holds s2's third minute only.
    oct1 = w.client.get(
        "/v1/astrologer/me/earnings",
        params={"from": "2026-10-01", "to": "2026-10-01"},
        headers=w.a_headers,
    ).json()
    assert oct1["totals"] == {
        "gross_paise": 999,
        "commission_paise": 349,
        "refunds_paise": 0,
        "net_paise": 650,
        "sessions": 1,
        "minutes": 1,
    }

    # B sees only B's work.
    b = w.client.get(
        "/v1/astrologer/me/earnings",
        params={"from": "2026-09-01", "to": "2026-09-30"},
        headers=w.b_headers,
    ).json()
    assert b["totals"]["gross_paise"] == 8000 and b["totals"]["sessions"] == 1


def test_sessions_paginate(portal_world: PortalWorld) -> None:
    w = portal_world
    september(w)
    q: dict[str, str | int] = {"from": "2026-09-01", "to": "2026-09-30", "limit": 2}
    first = w.client.get("/v1/astrologer/me/earnings", params=q, headers=w.a_headers).json()
    assert len(first["sessions"]["items"]) == 2 and first["sessions"]["next_cursor"]
    second = w.client.get(
        "/v1/astrologer/me/earnings",
        params={**q, "cursor": first["sessions"]["next_cursor"]},
        headers=w.a_headers,
    ).json()
    assert len(second["sessions"]["items"]) == 1 and second["sessions"]["next_cursor"] is None
    seen = [i["session_id"] for i in first["sessions"]["items"] + second["sessions"]["items"]]
    assert len(set(seen)) == 3
    # Totals and by_day do not depend on the page.
    assert second["totals"] == first["totals"]


def test_default_range_is_current_ist_month_and_promo_minutes_pay_the_same(
    portal_world: PortalWorld,
) -> None:
    w = portal_world
    from astro_api import wallet

    async def promo_session(db: Any) -> None:
        from services.api.tests.test_payouts_support import minute, new_session

        await wallet.grant_promo(
            db,
            user_id=w.u2,
            amount_paise=2000,
            campaign="test",
            key=f"promo:test:{uuid.uuid4()}",
            expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(days=5),
        )
        sid = await new_session(db, w.u2, w.a_id)
        # Minute 1 is paid with promo credit, minute 2 with real money.
        for n in (1, 2):
            await minute(
                db, session_id=sid, user_id=w.u2, astrologer_id=w.a_id, n=n, price=2000, bps=4000
            )

    w.db(promo_session)
    body = w.client.get("/v1/astrologer/me/earnings", headers=w.a_headers).json()
    today = earnings.ist_today()
    first = today.replace(day=1)
    assert body["from"] == first.isoformat()
    assert dt.date.fromisoformat(body["to"]).month == today.month
    assert (dt.date.fromisoformat(body["to"]) + dt.timedelta(days=1)).day == 1
    assert len(body["by_day"]) == dt.date.fromisoformat(body["to"]).day
    # "This month so far": an explicit `to` before the month's end is honoured.
    so_far = w.client.get(
        "/v1/astrologer/me/earnings",
        params={"from": first.isoformat(), "to": today.isoformat()},
        headers=w.a_headers,
    ).json()
    assert so_far["to"] == today.isoformat() and len(so_far["by_day"]) == today.day
    assert so_far["totals"] == body["totals"]
    assert body["totals"] == {
        "gross_paise": 4000,
        "commission_paise": 1600,
        "refunds_paise": 0,
        "net_paise": 2400,
        "sessions": 1,
        "minutes": 2,
    }


def test_refund_through_the_wallet_counts_the_astrologer_share(portal_world: PortalWorld) -> None:
    w = portal_world
    sid = w.work(w.a_id, count=5, at=None, price=3000, bps=3500)  # 1050 commission, 1950 each
    w.refund(sid, w.a_id, astrologer_paise=2925, commission_paise=1575, at=None)  # 4500 refund
    t = w.client.get("/v1/astrologer/me/earnings", headers=w.a_headers).json()["totals"]
    # The wallet splits a 4500 refund as floor(4500 * 5250 / 15000) = 1575 commission.
    assert t == {
        "gross_paise": 15000,
        "commission_paise": 5250,
        "refunds_paise": 2925,
        "net_paise": 15000 - 5250 - 2925,
        "sessions": 1,
        "minutes": 5,
    }
    assert w.payable(w.a_id) == t["net_paise"]


@pytest.mark.parametrize(
    "params",
    [
        {"from": "2026-09-30", "to": "2026-09-01"},
        {"from": "2025-01-01", "to": "2026-01-02"},  # 367 days
        {"from": "2026-02-30", "to": "2026-03-01"},
        {"from": "2026-09-01"},
    ],
)
def test_bad_ranges(portal_world: PortalWorld, params: dict[str, str]) -> None:
    r = portal_world.client.get(
        "/v1/astrologer/me/earnings", params=params, headers=portal_world.a_headers
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "invalid_range"


def test_earnings_need_an_astrologer(portal_world: PortalWorld) -> None:
    w = portal_world
    for path in ("earnings", "balance", "payouts"):
        r = w.client.get(f"/v1/astrologer/me/{path}", headers=w.u1_headers)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "not_applied", path
    assert w.client.get("/v1/astrologer/me/earnings").status_code == 401


def test_balance(portal_world: PortalWorld) -> None:
    w = portal_world
    september(w)
    r = w.client.get("/v1/astrologer/me/balance", headers=w.a_headers)
    assert r.status_code == 200, r.text
    # Payable = every earning so far: Aug 1800 + Sep 2800 + Oct 1 650.
    assert r.json() == {"payable_paise": 1800 + 2800 + 650, "last_payout": None}
