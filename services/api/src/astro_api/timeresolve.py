"""Civil birth time → UTC with the tz database, matching the astro engine's rules and error codes
(nonexistent / ambiguous local times are rejected, never shifted). No ephemeris needed here."""

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from astro_api.errors import ApiError

MIN_DATE = dt.date(1800, 1, 2)
MAX_DATE = dt.date(2399, 12, 30)


@dataclass(frozen=True)
class Resolved:
    utc: dt.datetime
    utc_offset: str


def format_offset(delta: dt.timedelta | None) -> str:
    total = int((delta or dt.timedelta()).total_seconds())
    sign = "+" if total >= 0 else "-"
    hours, rem = divmod(abs(total), 3600)
    minutes, seconds = divmod(rem, 60)
    return f"{sign}{hours:02d}:{minutes:02d}" + (f":{seconds:02d}" if seconds else "")


def _fixed(value: str) -> dt.timezone:
    try:
        sign = {"+": 1, "-": -1}[value[0]]
        hours, minutes = (int(x) for x in value[1:].split(":"))
        delta = dt.timedelta(hours=hours, minutes=minutes)
    except (KeyError, ValueError, IndexError):
        delta = dt.timedelta(hours=99)
    if delta > dt.timedelta(hours=14):
        raise ApiError(422, "invalid_utc_offset", f"UTC offset must look like +05:30: {value}")
    return dt.timezone(sign * delta)


def resolve(
    day: dt.date,
    clock: dt.time | None,
    tz: str,
    utc_offset: str | None = None,
    fold: int | None = None,
) -> Resolved:
    if not MIN_DATE <= day <= MAX_DATE:
        raise ApiError(422, "date_out_of_range", "Supported dates: 1800-2399 CE")
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ApiError(422, "unknown_time_zone", f"Unknown IANA time zone: {tz}") from exc
    naive = dt.datetime.combine(day, clock or dt.time(12, 0))
    if utc_offset is not None:
        aware = naive.replace(tzinfo=_fixed(utc_offset))
        return Resolved(aware.astimezone(dt.UTC), format_offset(aware.utcoffset()))
    first = naive.replace(tzinfo=zone, fold=0)
    second = naive.replace(tzinfo=zone, fold=1)
    if first.astimezone(dt.UTC).astimezone(zone).replace(tzinfo=None) != naive:
        raise ApiError(
            422, "nonexistent_local_time", "This local time does not exist (clocks moved forward)."
        )
    if first.utcoffset() != second.utcoffset():
        if fold is None:
            raise ApiError(
                422, "ambiguous_local_time", "This local time happens twice; send fold=0 or fold=1."
            )
        first = second if fold == 1 else first
    return Resolved(first.astimezone(dt.UTC), format_offset(first.utcoffset()))
