"""Admin growth funnel (docs/api/growth.md §1.3), written before the implementation.

The world below has explicit timelines in IST over two ISO weeks (Mon 2026-09-07 to Sun
2026-09-20) with `window_days=7`. Every expected number is derived in the comments next to the
fixture, so a change in the funnel rules shows up as a readable diff here.
"""

import asyncio
import datetime as dt
import json
import uuid
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from astro_api.db import make_sessionmaker
from astro_api.models import Astrologer, ConsultSession, User
from astro_api.models_analytics import AnalyticsEvent
from astro_api.models_ledger import FreeSessionClaim, RechargeOrder
from astro_api.shared_files import data_dir

pytestmark = pytest.mark.integration

IST = ZoneInfo("Asia/Kolkata")
URL = "/v1/admin/growth/funnel"
WEEK1, WEEK2 = "2026-09-07", "2026-09-14"
TARGETS: dict[str, Any] = json.loads(
    (data_dir().parent / "growth" / "targets.json").read_text(encoding="utf-8")
)["funnel"]


def ist(month: int, day: int, hour: int = 10, minute: int = 0) -> dt.datetime:
    return dt.datetime(2026, month, day, hour, minute, tzinfo=IST)


def run(client: TestClient, fn: Any) -> Any:
    async def go() -> Any:
        url = client.app.state.settings.database_url.get_secret_value()  # type: ignore[attr-defined]
        engine = create_async_engine(url)
        try:
            async with make_sessionmaker(engine)() as db:
                result = await fn(db)
                await db.commit()
                return result
        finally:
            await engine.dispose()

    return asyncio.run(go())


class World:
    """Builds rows directly; `n` keeps phones and idempotency keys unique."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.n = 0
        self.astrologer_id: uuid.UUID | None = None

    async def user(self, created: dt.datetime) -> uuid.UUID:
        self.n += 1
        u = User(phone=f"+9198{self.n:08d}", device_ids=[], roles=[], created_at=created)
        self.db.add(u)
        await self.db.flush()
        return u.id

    async def _astrologer(self) -> uuid.UUID:
        if self.astrologer_id is None:
            owner = await self.user(ist(1, 1))
            a = Astrologer(
                user_id=owner,
                display_name="Funnel Test",
                slug=f"funnel-test-{owner.hex[:8]}",
                bio="Test profile.",
                skills=["vedic"],
                languages=["en"],
                gender="female",
                requested_price_per_min_paise=1000,
                experience_years=5,
                status="approved",
                accepts_terms_at=ist(1, 1),
            )
            self.db.add(a)
            await self.db.flush()
            self.astrologer_id = a.id
        return self.astrologer_id

    async def free_session(self, user_id: uuid.UUID, started: dt.datetime | None) -> None:
        s = ConsultSession(
            user_id=user_id,
            astrologer_id=await self._astrologer(),
            kind="chat",
            status="completed" if started else "cancelled",
            started_at=started,
            is_free=True,
        )
        self.db.add(s)
        await self.db.flush()
        self.db.add(
            FreeSessionClaim(
                user_id=user_id,
                session_id=s.id,
                device_hash="d" * 64,
                ip_hash="i" * 64,
                ip_day=(started or ist(9, 1)).date(),
            )
        )

    def order(self, user_id: uuid.UUID, paid: dt.datetime | None) -> None:
        self.n += 1
        self.db.add(
            RechargeOrder(
                user_id=user_id,
                idempotency_key=f"order-{self.n}",
                amount_paise=10000,
                currency="INR",
                status="paid" if paid else "created",
                provider="fake",
                paid_at=paid,
            )
        )

    def event(
        self,
        anon: str,
        event: str,
        at: dt.datetime,
        user_id: uuid.UUID | None = None,
        locale: str = "en",
        **properties: Any,
    ) -> None:
        self.db.add(
            AnalyticsEvent(
                event=event,
                occurred_at=at,
                anonymous_id=anon,
                user_id=user_id,
                locale=locale,
                properties=properties,
            )
        )

    def page_view(self, anon: str, at: dt.datetime, path: str, **kw: Any) -> None:
        locale = kw.pop("locale", "en")
        self.event(anon, "page_view", at, locale=locale, path=path, **kw)


async def build_world(db: AsyncSession) -> dict[str, uuid.UUID]:
    w = World(db)
    ua = await w.user(ist(9, 7, 10, 10))
    ub = await w.user(ist(9, 8, 10, 10))
    uc = await w.user(ist(9, 9, 10, 10))
    ue = await w.user(ist(9, 15, 10, 10))
    ui = await w.user(ist(7, 15))  # created before the range: not in the account funnel
    uo = await w.user(ist(9, 10))  # opted out of analytics: account funnel only
    up = await w.user(ist(9, 16))
    uq = await w.user(ist(9, 17))

    # A (week 1): every step, all within 7 days of 09-07 10:00.
    w.page_view("anon_a_000001", ist(9, 7, 10), "/kundli", source="search")
    w.page_view("anon_a_000001", ist(9, 7, 10, 1), "/kundli/result")
    w.event("anon_a_000001", "tool_completed", ist(9, 7, 10, 5), tool="kundli")
    w.event("anon_a_000001", "otp_verified", ist(9, 7, 10, 10), ua, is_new_user=True)
    await w.free_session(ua, ist(9, 8))
    w.order(ua, ist(9, 9))
    w.order(ua, ist(9, 10))
    # B (week 1): no tool (only started), signs in, free session, one paid order.
    w.page_view("anon_b_000001", ist(9, 8), "/", source="search")
    w.event("anon_b_000001", "tool_started", ist(9, 8, 10, 2), tool="kundli")
    w.event("anon_b_000001", "otp_verified", ist(9, 8, 10, 10), ub, is_new_user=True)
    await w.free_session(ub, ist(9, 9))
    w.order(ub, ist(9, 10))
    w.order(ub, None)  # created, never paid: not a recharge
    # C (week 1, hi): tool and OTP, free session claimed but never started, one paid order.
    w.page_view("anon_c_000001", ist(9, 9), "/horoscope/aries", source="social", locale="hi")
    w.page_view("anon_c_000001", ist(9, 9, 10, 3), "/numerology", locale="en")
    w.event("anon_c_000001", "tool_completed", ist(9, 9, 10, 4), tool="numerology")
    w.event("anon_c_000001", "otp_verified", ist(9, 9, 10, 10), uc, is_new_user=True)
    await w.free_session(uc, None)
    w.order(uc, ist(9, 10))
    # D (week 2): tool only.
    w.page_view("anon_d_000001", ist(9, 14), "/kundli", source="direct")
    w.event("anon_d_000001", "tool_completed", ist(9, 14, 10, 5), tool="kundli")
    # E (week 2): tool outside the window (09-25 > 09-21 10:00); OTP and a first order inside;
    # the second order (09-30) outside.
    w.page_view("anon_e_000001", ist(9, 14, 11), "/", source="direct")
    w.event("anon_e_000001", "tool_completed", ist(9, 25), tool="kundli")
    w.event("anon_e_000001", "otp_verified", ist(9, 15, 10, 10), ue, is_new_user=True)
    w.order(ue, ist(9, 16))
    w.order(ue, ist(9, 30))
    # F: first page view before the range, so not in the cohort.
    w.page_view("anon_f_000001", ist(9, 1), "/", source="search")
    w.page_view("anon_f_000001", ist(9, 8), "/kundli")
    w.event("anon_f_000001", "tool_completed", ist(9, 8, 10, 5), tool="kundli")
    # G: first page view at 09-21 00:00 IST, just after the range.
    w.page_view("anon_g_000001", ist(9, 21, 0, 0), "/", source="search")
    # H (week 2): 09-20 23:30 IST is 18:00 UTC on 09-20, inside the range; a visit only.
    w.page_view("anon_h_000001", ist(9, 20, 23, 30), "/", source="campaign", utm_source="ig")
    # I (week 2): an existing customer on a new browser. Its first paid order (08-01) is before
    # the window, so first_recharge is not reached; its second (09-16) is, so repeat is.
    w.page_view("anon_i_000001", ist(9, 15), "/kundli", source="search")
    w.event("anon_i_000001", "tool_completed", ist(9, 15, 10, 5), tool="kundli")
    w.event("anon_i_000001", "otp_verified", ist(9, 15, 10, 10), ui, is_new_user=False)
    w.order(ui, ist(8, 1))
    w.order(ui, ist(9, 16))
    # Opt-out user O: no analytics at all; everything within 7 days of creation.
    await w.free_session(uo, ist(9, 11))
    w.order(uo, ist(9, 12))
    w.order(uo, ist(9, 13))
    # P: account only. Q: free session 8 days after creation (outside), paid order inside.
    await w.free_session(uq, ist(9, 25))
    w.order(uq, ist(9, 18))
    return {"ua": ua, "ub": ub, "uc": uc, "ue": ue, "ui": ui, "uo": uo, "up": up, "uq": uq}


def steps(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["key"]: s for s in body["steps"]}


def table(body: dict[str, Any]) -> list[tuple[str, int, int, float | None]]:
    return [(s["key"], s["count"], s["reached"], s["rate"]) for s in body["steps"]]


def target(name: str) -> dict[str, Any]:
    return {"low": TARGETS[name]["low"], "high": TARGETS[name]["high"]}


@pytest.fixture
def world(client: TestClient) -> dict[str, uuid.UUID]:
    return run(client, build_world)  # type: ignore[no-any-return]


def funnel(client: TestClient, headers: dict[str, str], **params: Any) -> dict[str, Any]:
    q = {"from": "2026-09-07", "to": "2026-09-20", "window_days": 7, **params}
    r = client.get(URL, params=q, headers=headers)
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def test_visitor_funnel_counts_reached_rates_and_targets(
    client: TestClient, admin_headers: dict[str, str], world: Any
) -> None:
    body = funnel(client, admin_headers)
    assert (body["from"], body["to"], body["window_days"]) == ("2026-09-07", "2026-09-20", 7)
    assert body["generated_at"].endswith(("Z", "+00:00"))
    v = body["visitor"]
    # Cohort A B C D E H I. Reached: tool A C D I; otp A B C E I; free A B; first recharge
    # A B C E; repeat A I. Strict: tool A C D I; otp A C I; free A; first A; repeat A.
    assert table(v) == [
        ("visit", 7, 7, None),
        ("tool_use", 4, 4, pytest.approx(4 / 7)),
        ("otp", 3, 5, pytest.approx(3 / 4)),
        ("free_session", 1, 2, pytest.approx(1 / 3)),
        ("first_recharge", 1, 4, 1.0),
        ("repeat", 1, 2, 1.0),
    ]
    s = steps(v)
    assert s["visit"]["target"] is None and s["tool_use"]["target"] is None
    assert s["otp"]["target"] == target("tool_use_to_otp")
    assert s["free_session"]["target"] == target("otp_to_free_session")
    assert s["first_recharge"]["target"] == target("free_session_to_first_recharge")
    assert s["repeat"]["target"] is None
    assert v["weeks"] == [
        {
            "week_start": WEEK1,
            "counts": {
                "visit": 3,
                "tool_use": 2,
                "otp": 2,
                "free_session": 1,
                "first_recharge": 1,
                "repeat": 1,
            },
        },
        {
            "week_start": WEEK2,
            "counts": {
                "visit": 4,
                "tool_use": 2,
                "otp": 1,
                "free_session": 0,
                "first_recharge": 0,
                "repeat": 0,
            },
        },
    ]
    assert body["notes"] and all(isinstance(n, str) and n for n in body["notes"])


def test_account_funnel_includes_opted_out_users(
    client: TestClient, admin_headers: dict[str, str], world: Any
) -> None:
    a = funnel(client, admin_headers)["account"]
    # Cohort UA UB UC UE UO UP UQ (UI was created in July; the admin today). Reached: free UA UB
    # UO; first UA UB UC UE UO UQ; repeat UA UO. Strict: free UA UB UO; first UA UB UO; repeat
    # UA UO.
    assert table(a) == [
        ("otp", 7, 7, None),
        ("free_session", 3, 3, pytest.approx(3 / 7)),
        ("first_recharge", 3, 6, 1.0),
        ("repeat", 2, 2, pytest.approx(2 / 3)),
    ]
    s = steps(a)
    assert s["otp"]["target"] is None
    assert s["free_session"]["target"] == target("otp_to_free_session")
    assert s["first_recharge"]["target"] == target("free_session_to_first_recharge")
    assert s["repeat"]["target"] is None
    assert a["weeks"] == [
        {
            "week_start": WEEK1,
            "counts": {"otp": 4, "free_session": 3, "first_recharge": 3, "repeat": 2},
        },
        {
            "week_start": WEEK2,
            "counts": {"otp": 3, "free_session": 0, "first_recharge": 0, "repeat": 0},
        },
    ]


def test_window_days_changes_what_counts(
    client: TestClient, admin_headers: dict[str, str], world: Any
) -> None:
    # With 30 days: E's tool (09-25) and second order (09-30, 16 days after 09-14 11:00) count,
    # and Q's free session (09-25, 8 days after creation) counts.
    body = funnel(client, admin_headers, window_days=30)
    v = steps(body["visitor"])
    assert (v["tool_use"]["count"], v["otp"]["count"], v["repeat"]["reached"]) == (5, 4, 3)
    a = steps(body["account"])
    assert (a["free_session"]["count"], a["first_recharge"]["count"]) == (4, 4)
    # With 1 day: A's orders (2 and 3 days later) and B's free session (1 day + 0 s, at the
    # boundary, excluded: the window is [t0, t0 + window_days) ) drop out.
    body = funnel(client, admin_headers, window_days=1)
    v = steps(body["visitor"])
    assert (v["free_session"]["reached"], v["first_recharge"]["reached"]) == (0, 0)


def test_filters_apply_to_the_first_page_view(
    client: TestClient, admin_headers: dict[str, str], world: Any
) -> None:
    body = funnel(client, admin_headers, source="search")
    assert table(body["visitor"])[:3] == [
        ("visit", 3, 3, None),  # A B I
        ("tool_use", 2, 2, pytest.approx(2 / 3)),  # A I
        ("otp", 2, 3, 1.0),
    ]
    # C's first page view is hi; its later en page view does not matter.
    body = funnel(client, admin_headers, locale="hi")
    assert table(body["visitor"])[:3] == [
        ("visit", 1, 1, None),
        ("tool_use", 1, 1, 1.0),
        ("otp", 1, 1, 1.0),
    ]
    assert body["visitor"]["weeks"][1]["counts"]["visit"] == 0
    # The account funnel ignores visitor filters.
    assert steps(body["account"])["otp"]["count"] == 7
    body = funnel(client, admin_headers, locale="", source="")  # empty means no filter
    assert steps(body["visitor"])["visit"]["count"] == 7


def test_empty_range_has_zero_counts_and_null_rates(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    body = funnel(client, admin_headers, **{"from": "2026-09-09", "to": "2026-09-09"})
    assert table(body["visitor"]) == [
        ("visit", 0, 0, None),
        ("tool_use", 0, 0, None),
        ("otp", 0, 0, None),
        ("free_session", 0, 0, None),
        ("first_recharge", 0, 0, None),
        ("repeat", 0, 0, None),
    ]
    assert [w["week_start"] for w in body["visitor"]["weeks"]] == [WEEK1]
    assert body["visitor"]["by_source"] == []
    assert body["visitor"]["by_tool"] == []
    assert body["visitor"]["by_landing"] == []
    assert table(body["account"])[0] == ("otp", 0, 0, None)


def test_small_breakdown_rows_merge_into_other(
    client: TestClient, admin_headers: dict[str, str], world: Any
) -> None:
    v = funnel(client, admin_headers)["visitor"]
    # Seven visitors, no key with 5 or more: everything is `other`. Breakdown otp and
    # first_recharge are `reached` counts.
    assert v["by_source"] == [{"key": "other", "visit": 7, "otp": 5, "first_recharge": 4}]
    # by_tool: visitors who completed a tool in the window, by their first tool (A C D I).
    assert v["by_tool"] == [{"key": "other", "visit": 4, "otp": 3, "first_recharge": 2}]
    assert v["by_landing"] == [{"key": "other", "visit": 7, "otp": 5, "first_recharge": 4}]


async def _breakdown_world(db: AsyncSession) -> None:
    """Landing /p01../p11 with 15..5 visitors, /tiny with 2. Sources: search, except /tiny
    (social) and the first /p11 visitor (campaign). Tools: kundli for /p01 visitors, numerology
    then kundli for the first /p02 visitor. Three /p01 visitors sign in; one of them pays."""
    w = World(db)
    k = 0
    for page in range(1, 12):
        for i in range(16 - page):
            k += 1
            anon = f"anon_bd_{k:06d}"
            at = ist(9, 7 + (k % 7), 9)
            source = "campaign" if (page == 11 and i == 0) else "search"
            w.page_view(anon, at, f"/p{page:02d}", source=source)
            if page == 1:
                w.event(anon, "tool_completed", at + dt.timedelta(minutes=1), tool="kundli")
                if i < 3:
                    uid = await w.user(at)
                    w.event(anon, "otp_verified", at + dt.timedelta(minutes=2), uid)
                    if i == 0:
                        w.order(uid, at + dt.timedelta(hours=1))
            if page == 2 and i == 0:
                w.event(anon, "tool_completed", at + dt.timedelta(minutes=1), tool="numerology")
                w.event(anon, "tool_completed", at + dt.timedelta(minutes=2), tool="kundli")
    for i in range(2):
        w.page_view(f"anon_tiny_{i:05d}", ist(9, 8), "/tiny", source="social")


def test_breakdowns_top_ten_and_other(client: TestClient, admin_headers: dict[str, str]) -> None:
    run(client, _breakdown_world)
    v = funnel(client, admin_headers)["visitor"]
    assert steps(v)["visit"]["count"] == 112
    assert v["by_landing"] == [
        {
            "key": f"/p{p:02d}",
            "visit": 16 - p,
            "otp": 3 if p == 1 else 0,
            "first_recharge": 1 if p == 1 else 0,
        }
        for p in range(1, 11)
    ] + [{"key": "other", "visit": 7, "otp": 0, "first_recharge": 0}]
    assert v["by_source"] == [
        {"key": "search", "visit": 109, "otp": 3, "first_recharge": 1},
        {"key": "other", "visit": 3, "otp": 0, "first_recharge": 0},
    ]
    assert v["by_tool"] == [
        {"key": "kundli", "visit": 15, "otp": 3, "first_recharge": 1},
        {"key": "other", "visit": 1, "otp": 0, "first_recharge": 0},
    ]


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"from": "2026-09-31"}, "invalid_range"),
        ({"from": "07-09-2026"}, "invalid_range"),
        ({"from": "2026-09-21"}, "invalid_range"),  # after `to`
        ({"from": "2026-06-19"}, "invalid_range"),  # 93 days before 09-20
        ({"window_days": 0}, "invalid_window"),
        ({"window_days": 91}, "invalid_window"),
        ({"window_days": "x"}, "invalid_window"),
        ({"locale": "fr"}, "invalid_filter"),
        ({"source": "email"}, "invalid_filter"),
    ],
)
def test_bad_parameters_are_422(
    client: TestClient, admin_headers: dict[str, str], params: dict[str, Any], code: str
) -> None:
    q = {"from": "2026-09-07", "to": "2026-09-20", **params}
    r = client.get(URL, params=q, headers=admin_headers)
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == code


def test_limits_and_defaults(client: TestClient, admin_headers: dict[str, str]) -> None:
    r = client.get(URL, params={"from": "2026-06-20", "to": "2026-09-20"}, headers=admin_headers)
    assert r.status_code == 200, r.text  # exactly 92 days
    assert r.json()["window_days"] == 30
    r = client.get(URL, params={"to": "2026-09-20"}, headers=admin_headers)
    assert r.status_code == 422


def test_admin_only(client: TestClient, login: Any) -> None:
    q = {"from": "2026-09-07", "to": "2026-09-20"}
    assert client.get(URL, params=q).status_code == 401
    assert client.get(URL, params=q, headers=login("+919811100001")).status_code == 403


def test_account_funnel_leaves_out_staff_astrologers_and_synthetic_accounts(
    client: TestClient, admin_headers: dict[str, str], world: Any
) -> None:
    async def add(db: AsyncSession) -> None:
        created = ist(9, 8)
        # Seed and load-test phones start +910 (never a real Indian mobile).
        db.add(User(phone="+910000019000001", device_ids=[], roles=[], created_at=created))
        db.add(User(phone="+919811100001", device_ids=[], roles=["admin"], created_at=created))
        owner = User(phone="+919811100002", device_ids=[], roles=[], created_at=created)
        db.add(owner)
        await db.flush()
        db.add(
            Astrologer(
                user_id=owner.id,
                display_name="Applicant",
                slug=f"applicant-{owner.id.hex[:8]}",
                bio="Test profile.",
                skills=["vedic"],
                languages=["en"],
                gender="male",
                requested_price_per_min_paise=1000,
                experience_years=3,
                status="applied",
                accepts_terms_at=created,
            )
        )

    run(client, add)
    a = funnel(client, admin_headers)["account"]
    assert table(a)[0] == ("otp", 7, 7, None)  # the same seven clients as before
