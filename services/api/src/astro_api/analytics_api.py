"""First-party analytics collector and the admin funnel (docs/api/growth.md §1, ADR-0013).

- `POST /v1/analytics/events` (from the web BFF): at most 20 envelopes, each checked with
  `validate_event`; invalid ones are dropped and counted. `user_id` comes only from the bearer
  token (an invalid or expired token means anonymous, never 401). `occurred_at` is the client
  `ts`, or the receive time when `ts` is more than 24 h off. 300 events per minute per client IP
  (HMAC key). Logs carry counts only, never event values or ids.
- `GET /v1/admin/growth/funnel`: the visitor funnel (anonymous ids by first ever page view) and
  the account funnel (users by creation), computed in SQL. Money and session steps come from
  `free_session_claims`, `consult_sessions` and `recharge_orders`, never from client events.
"""

import datetime as dt
import json
import logging
import re
import uuid
from functools import cache
from typing import Annotated, Any

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.analytics import LOCALES, schema, validate_event
from astro_api.auth import client_ip, current_session
from astro_api.db import Db, redis_of, settings_of
from astro_api.earnings import range_bounds
from astro_api.errors import ApiError
from astro_api.models_analytics import AnalyticsEvent
from astro_api.ratelimit import bucket_key
from astro_api.roles import AdminUser
from astro_api.shared_files import data_dir

router = APIRouter(tags=["analytics"])
log = logging.getLogger("astro_api.analytics")

MAX_EVENTS = 20
RATE_LIMIT = 300  # events per window per client IP
RATE_WINDOW_S = 60
MAX_SKEW = dt.timedelta(hours=24)

# ---------------------------------------------------------------- collection


class EventsIn(BaseModel):
    events: list[Any]


async def _token_user(db: AsyncSession, authorization: str | None) -> uuid.UUID | None:
    """The bearer token's user, or None for no, invalid, revoked or expired tokens."""
    if not authorization:
        return None
    try:
        _, user = await current_session(db, authorization)
    except ApiError:
        return None
    return user.id


async def _rate_limit(redis: Redis, key: str, n: int) -> None:
    """Count `n` events in the fixed window (same pattern as ratelimit.incr_window, by n)."""
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incrby(key, n)
        pipe.expire(key, RATE_WINDOW_S, nx=True)
        count, _ = await pipe.execute()
    if int(count) > RATE_LIMIT:
        retry_after = max(int(await redis.ttl(key)), 1)
        raise ApiError(
            429,
            "rate_limited",
            "Too many events. Try again later.",
            headers={"Retry-After": str(retry_after)},
            retry_after=retry_after,
        )


def occurred_at(ts: str, now: dt.datetime) -> dt.datetime:
    """The client time, or `now` when it is more than 24 h off (a wrong clock or a replay)."""
    at = dt.datetime.fromisoformat(ts)
    if at.tzinfo is None:  # pragma: no cover - validate_event requires a trailing Z
        at = at.replace(tzinfo=dt.UTC)
    return now if abs(at - now) > MAX_SKEW else at


@router.post("/v1/analytics/events", status_code=202)
async def collect(
    body: EventsIn,
    request: Request,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, int]:
    if len(body.events) > MAX_EVENTS:
        raise ApiError(
            422, "too_many_events", f"At most {MAX_EVENTS} events.", max_events=MAX_EVENTS
        )
    if not body.events:
        return {"accepted": 0, "rejected": 0}
    settings = settings_of(request)
    ip = client_ip(request, settings)
    await _rate_limit(
        redis_of(request),
        bucket_key(settings.secret_key.get_secret_value(), "analytics-ip", ip),
        len(body.events),
    )
    user_id = await _token_user(db, authorization)
    now = dt.datetime.now(dt.UTC)
    rows: list[dict[str, Any]] = []
    for event in body.events:
        if validate_event(event):
            continue
        rows.append(
            {
                "event": event["event"],
                "occurred_at": occurred_at(event["ts"], now),
                "anonymous_id": event["anonymous_id"],
                "user_id": user_id,  # the envelope's user_id is ignored
                "locale": event["locale"],
                "properties": event["properties"],
            }
        )
    if rows:
        await db.execute(insert(AnalyticsEvent), rows)
        await db.commit()
    rejected = len(body.events) - len(rows)
    # Counts only: never event names with values, paths, anonymous ids or user ids.
    log.info("analytics_events", extra={"accepted": len(rows), "rejected": rejected})
    return {"accepted": len(rows), "rejected": rejected}


# ---------------------------------------------------------------- funnel

VISITOR_STEPS = ("visit", "tool_use", "otp", "free_session", "first_recharge", "repeat")
ACCOUNT_STEPS = ("otp", "free_session", "first_recharge", "repeat")
# Step key → targets.json funnel rate whose `low`/`high` apply to that step's rate.
VISITOR_TARGETS = {
    "otp": "tool_use_to_otp",
    "free_session": "otp_to_free_session",
    "first_recharge": "free_session_to_first_recharge",
}
ACCOUNT_TARGETS = {
    "free_session": "otp_to_free_session",
    "first_recharge": "free_session_to_first_recharge",
}
MAX_RANGE_DAYS = 92
DEFAULT_WINDOW_DAYS = 30
MIN_BREAKDOWN_VISITS = 5
BREAKDOWN_ROWS = 10
OTHER = "other"
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOTES = [
    "Visitors who opted out (GPC, DNT or the privacy switch) or block cookies are not in the "
    "visitor funnel; the account funnel counts every client account and is unaffected by "
    "opt-outs (staff, astrologers and seed or load-test accounts are left out).",
    "count is strict (the previous step was reached too); reached counts the step whatever "
    "happened before; rate is count / previous count.",
    "A step counts only within window_days of the first page view (visitor) or of account "
    "creation (account).",
    "Free session: a free-session claim whose consultation started. First recharge and repeat: "
    "the user's first and second paid recharge orders.",
    "Locale and source filter the visitor funnel on the first page view; the account funnel is "
    "not filtered.",
    "Weeks are ISO weeks starting Monday (IST) of the cohort start, with strict counts.",
    "Breakdowns show reached counts. by_tool groups visitors by the first tool they completed. "
    "Rows with fewer than 5 visits, and rows past the top 10, are merged into other.",
    "Targets are plan assumptions to validate (data/growth/targets.json), not facts.",
]


@cache
def targets() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (data_dir().parent / "growth" / "targets.json").read_text(encoding="utf-8")
    )
    return data


def _target(mapping: dict[str, str], key: str) -> dict[str, Any] | None:
    name = mapping.get(key)
    if name is None:
        return None
    rate = targets()["funnel"][name]
    return {"low": rate["low"], "high": rate["high"]}


def _sources() -> tuple[str, ...]:
    return tuple(schema()["events"]["page_view"]["properties"]["source"]["values"])


def _date(value: str | None) -> dt.date:
    if value is None or not _DATE.fullmatch(value):
        raise ApiError(422, "invalid_range", "from and to must be dates (YYYY-MM-DD).")
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ApiError(422, "invalid_range", "from and to must be dates (YYYY-MM-DD).") from exc


def _window(value: str | None) -> int:
    if value is None:
        return DEFAULT_WINDOW_DAYS
    try:
        days = int(value)
    except ValueError:
        days = 0
    if not 1 <= days <= 90:
        raise ApiError(422, "invalid_window", "window_days must be 1-90.")
    return days


def _filter(name: str, value: str | None, allowed: tuple[str, ...]) -> str | None:
    if not value:
        return None
    if value not in allowed:
        raise ApiError(422, "invalid_filter", f"Unknown {name}.", allowed=list(allowed))
    return value


def _within(col: str, t0: str = "b.t0") -> str:
    """`col` falls in the member's window [t0, t0 + window_days)."""
    return f"({col} >= {t0} AND {col} < {t0} + make_interval(days => CAST(:win AS integer)))"


# Per member (`base`: member, t0, user_id): free session started and first / second paid
# recharge within the window. A member without a linked user reaches none of them.
_USER_STEPS = f"""
user_steps AS (
  SELECT b.*,
    EXISTS (
      SELECT 1 FROM free_session_claims f
      JOIN consult_sessions s ON s.id = f.session_id
      WHERE f.user_id = b.user_id AND s.started_at IS NOT NULL AND {_within("s.started_at")}
    ) AS s_free,
    COALESCE({_within("pay.paid[1]")}, false) AS s_r1,
    COALESCE({_within("pay.paid[2]")}, false) AS s_r2
  FROM base b
  LEFT JOIN LATERAL (
    SELECT array_agg(x.paid_at ORDER BY x.paid_at) AS paid
    FROM (
      SELECT r.paid_at FROM recharge_orders r
      WHERE r.user_id = b.user_id AND r.paid_at IS NOT NULL
      ORDER BY r.paid_at
      LIMIT 2
    ) x
  ) pay ON true
)"""  # noqa: S608 - fixed fragments, values are bound

_WEEK = "(date_trunc('week', t0 AT TIME ZONE 'Asia/Kolkata'))::date"

# The cohort is every anonymous id whose first ever page_view is in [start, end): the earliest
# page_view in the range, with none before it. Filters apply to that first page view.
_VISITOR_BASE = f"""
first_pv AS (
  SELECT DISTINCT ON (e.anonymous_id)
    e.anonymous_id AS member, e.occurred_at AS t0, e.locale,
    e.properties ->> 'source' AS source, e.properties ->> 'path' AS landing
  FROM analytics_events e
  WHERE e.event = 'page_view' AND e.occurred_at >= :start AND e.occurred_at < :end
    AND NOT EXISTS (
      SELECT 1 FROM analytics_events p
      WHERE p.anonymous_id = e.anonymous_id AND p.event = 'page_view'
        AND p.occurred_at < :start
    )
  ORDER BY e.anonymous_id, e.occurred_at, e.id
),
cohort AS (
  SELECT * FROM first_pv
  WHERE (CAST(:locale AS text) IS NULL OR locale = CAST(:locale AS text))
    AND (CAST(:source AS text) IS NULL OR source = CAST(:source AS text))
),
base AS (
  SELECT c.member, c.t0, c.source, c.landing, tool.tool, link.user_id
  FROM cohort c
  LEFT JOIN LATERAL (
    SELECT e.properties ->> 'tool' AS tool FROM analytics_events e
    WHERE e.anonymous_id = c.member AND e.event = 'tool_completed'
      AND {_within("e.occurred_at", "c.t0")}
    ORDER BY e.occurred_at, e.id
    LIMIT 1
  ) tool ON true
  LEFT JOIN LATERAL (
    SELECT e.user_id FROM analytics_events e
    WHERE e.anonymous_id = c.member AND e.event = 'otp_verified' AND e.user_id IS NOT NULL
      AND {_within("e.occurred_at", "c.t0")}
    ORDER BY e.occurred_at, e.id
    LIMIT 1
  ) link ON true
)"""  # noqa: S608 - fixed fragments, values are bound

_ACCOUNT_BASE = """
base AS (
  SELECT u.id::text AS member, u.created_at AS t0, u.id AS user_id
  FROM users u
  WHERE u.created_at >= :start AND u.created_at < :end
    -- Clients only: no staff roles, no astrologer profile, no seed or load-test account
    -- (their phones start +910, which is never a real Indian mobile).
    AND cardinality(u.roles) = 0
    AND u.phone NOT LIKE '+910%'
    AND NOT EXISTS (SELECT 1 FROM astrologers a WHERE a.user_id = u.id)
)"""

VISITOR_FLAGS = {
    "visit": "true",
    "tool_use": "(tool IS NOT NULL)",
    "otp": "(user_id IS NOT NULL)",
    "free_session": "s_free",
    "first_recharge": "s_r1",
    "repeat": "s_r2",
}
ACCOUNT_FLAGS = {
    "otp": "true",
    "free_session": "s_free",
    "first_recharge": "s_r1",
    "repeat": "s_r2",
}


def _aggregates(keys: tuple[str, ...], flags: dict[str, str]) -> str:
    """`r_<step>` (reached) and `c_<step>` (strict: every step up to it) counts."""
    parts: list[str] = []
    for i, key in enumerate(keys):
        strict = " AND ".join(flags[k] for k in keys[: i + 1])
        parts.append(f"count(*) FILTER (WHERE {flags[key]}) AS r_{key}")
        parts.append(f"count(*) FILTER (WHERE {strict}) AS c_{key}")
    return ",\n  ".join(parts)


VISITOR_SQL = f"""
WITH {_VISITOR_BASE},
{_USER_STEPS}
SELECT
  GROUPING({_WEEK}) AS g_week, GROUPING(COALESCE(source, 'unknown')) AS g_source,
  GROUPING(tool) AS g_tool, GROUPING(landing) AS g_landing,
  {_WEEK} AS week, COALESCE(source, 'unknown') AS source_key, tool AS tool_key,
  landing AS landing_key,
  {_aggregates(VISITOR_STEPS, VISITOR_FLAGS)}
FROM user_steps
GROUP BY GROUPING SETS ((), ({_WEEK}), (COALESCE(source, 'unknown')), (tool), (landing))
"""  # noqa: S608 - fixed fragments, values are bound

ACCOUNT_SQL = f"""
WITH {_ACCOUNT_BASE},
{_USER_STEPS}
SELECT
  GROUPING({_WEEK}) AS g_week, {_WEEK} AS week,
  {_aggregates(ACCOUNT_STEPS, ACCOUNT_FLAGS)}
FROM user_steps
GROUP BY GROUPING SETS ((), ({_WEEK}))
"""  # noqa: S608 - fixed fragments, values are bound


def _steps(keys: tuple[str, ...], row: Any | None, mapping: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    prev: int | None = None
    for key in keys:
        count = int(getattr(row, f"c_{key}")) if row is not None else 0
        reached = int(getattr(row, f"r_{key}")) if row is not None else 0
        out.append(
            {
                "key": key,
                "count": count,
                "reached": reached,
                "rate": count / prev if prev else None,
                "target": _target(mapping, key),
            }
        )
        prev = count
    return out


def _mondays(first: dt.date, last: dt.date) -> list[dt.date]:
    monday = first - dt.timedelta(days=first.weekday())
    weeks: list[dt.date] = []
    while monday <= last:
        weeks.append(monday)
        monday += dt.timedelta(days=7)
    return weeks


def _weeks(
    keys: tuple[str, ...], rows: list[Any], first: dt.date, last: dt.date
) -> list[dict[str, Any]]:
    by_week = {r.week: r for r in rows}
    out: list[dict[str, Any]] = []
    for monday in _mondays(first, last):
        r = by_week.get(monday)
        out.append(
            {
                "week_start": monday.isoformat(),
                "counts": {k: int(getattr(r, f"c_{k}")) if r else 0 for k in keys},
            }
        )
    return out


def _breakdown(rows: list[tuple[str, int, int, int]]) -> list[dict[str, Any]]:
    """Top 10 keys with at least 5 visits, then `other` for the rest (when any)."""
    big = sorted((r for r in rows if r[1] >= MIN_BREAKDOWN_VISITS), key=lambda r: (-r[1], r[0]))
    rest = big[BREAKDOWN_ROWS:] + [r for r in rows if r[1] < MIN_BREAKDOWN_VISITS]
    out = [
        {"key": k, "visit": v, "otp": o, "first_recharge": f} for k, v, o, f in big[:BREAKDOWN_ROWS]
    ]
    if rest:
        out.append(
            {
                "key": OTHER,
                "visit": sum(r[1] for r in rest),
                "otp": sum(r[2] for r in rest),
                "first_recharge": sum(r[3] for r in rest),
            }
        )
    return out


async def compute_funnel(
    db: AsyncSession,
    first: dt.date,
    last: dt.date,
    window_days: int,
    locale: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    """GrowthFunnel (packages/shared/src/growth.ts) for IST dates `first`..`last`."""
    start, end = range_bounds(first, last)
    params = {"start": start, "end": end, "win": window_days}
    v_rows = list(
        (await db.execute(text(VISITOR_SQL), {**params, "locale": locale, "source": source})).all()
    )
    a_rows = list((await db.execute(text(ACCOUNT_SQL), params)).all())

    def only(rows: list[Any], **grouped: int) -> list[Any]:
        """Rows of one grouping set: 0 for the column grouped on, 1 for the others."""
        return [r for r in rows if all(getattr(r, f"g_{k}") == g for k, g in grouped.items())]

    v_total = next(iter(only(v_rows, week=1, source=1, tool=1, landing=1)), None)
    a_total = next(iter(only(a_rows, week=1)), None)

    def breakdown(name: str) -> list[dict[str, Any]]:
        grouped = {"week": 1, "source": 1, "tool": 1, "landing": 1, name: 0}
        return _breakdown(
            [
                (
                    getattr(r, f"{name}_key"),
                    int(r.r_visit),
                    int(r.r_otp),
                    int(r.r_first_recharge),
                )
                for r in only(v_rows, **grouped)
                if getattr(r, f"{name}_key") is not None  # by_tool: tool users only
            ]
        )

    return {
        "from": first.isoformat(),
        "to": last.isoformat(),
        "window_days": window_days,
        "generated_at": dt.datetime.now(dt.UTC).isoformat(),
        "visitor": {
            "steps": _steps(VISITOR_STEPS, v_total, VISITOR_TARGETS),
            "weeks": _weeks(
                VISITOR_STEPS, only(v_rows, week=0, source=1, tool=1, landing=1), first, last
            ),
            "by_source": breakdown("source"),
            "by_tool": breakdown("tool"),
            "by_landing": breakdown("landing"),
        },
        "account": {
            "steps": _steps(ACCOUNT_STEPS, a_total, ACCOUNT_TARGETS),
            "weeks": _weeks(ACCOUNT_STEPS, only(a_rows, week=0), first, last),
        },
        "notes": list(NOTES),
    }


@router.get("/v1/admin/growth/funnel")
async def growth_funnel(
    admin: AdminUser,
    db: Db,
    from_: Annotated[str | None, Query(alias="from")] = None,
    to: str | None = None,
    window_days: str | None = None,
    locale: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    first, last = _date(from_), _date(to)
    if first > last:
        raise ApiError(422, "invalid_range", "from must not be after to.")
    if (last - first).days > MAX_RANGE_DAYS:
        raise ApiError(
            422,
            "invalid_range",
            f"to - from must be at most {MAX_RANGE_DAYS} days.",
            max_days=MAX_RANGE_DAYS,
        )
    window = _window(window_days)
    return await compute_funnel(
        db,
        first,
        last,
        window,
        locale=_filter("locale", locale, LOCALES),
        source=_filter("source", source, _sources()),
    )
