"""Civil time ↔ UTC ↔ Julian day. Instants are UTC; local times only exist at the edges."""

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import swisseph as swe


class TimeInputError(ValueError):
    """Invalid civil time input. `code` is stable and returned to API clients."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise TimeInputError("unknown_time_zone", f"Unknown IANA time zone: {tz}") from exc


def parse_offset(value: str) -> timezone:
    """'+05:30' / '-04:00' → fixed offset. Used when the user confirms a historical offset."""
    sign = 1 if value[:1] == "+" else -1 if value[:1] == "-" else 0
    try:
        hours, minutes = value[1:].split(":")
        delta = timedelta(hours=int(hours), minutes=int(minutes))
    except ValueError:
        sign = 0
    if sign == 0 or delta > timedelta(hours=14):
        raise TimeInputError("invalid_utc_offset", f"UTC offset must look like +05:30: {value}")
    return timezone(sign * delta)


def format_offset(delta: timedelta | None) -> str:
    total = int((delta or timedelta()).total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    hours, rem = divmod(total, 3600)
    minutes, seconds = divmod(rem, 60)
    out = f"{sign}{hours:02d}:{minutes:02d}"
    return out + (f":{seconds:02d}" if seconds else "")


@dataclass(frozen=True)
class ResolvedTime:
    utc: datetime
    local: datetime
    tz: str
    utc_offset: str
    assumed_time: bool  # True when the birth time was unknown and we used local noon

    @property
    def jd(self) -> float:
        return jd_from_utc(self.utc)


def resolve_local(
    day: date,
    clock: time | None,
    tz: str,
    *,
    utc_offset: str | None = None,
    fold: int | None = None,
) -> ResolvedTime:
    """Turn a civil date/time at a place into a UTC instant.

    Nonexistent local times (DST gaps) are rejected. Ambiguous ones (DST overlaps) need `fold`.
    `utc_offset` overrides the tz database, for births where local practice differed from it.
    """
    zi = zone(tz)
    assumed = clock is None
    naive = datetime.combine(day, clock or time(12, 0))
    if utc_offset is not None:
        aware = naive.replace(tzinfo=parse_offset(utc_offset))
        return ResolvedTime(
            aware.astimezone(UTC), aware, tz, format_offset(aware.utcoffset()), assumed
        )

    first = naive.replace(tzinfo=zi, fold=0)
    second = naive.replace(tzinfo=zi, fold=1)
    roundtrip = first.astimezone(UTC).astimezone(zi).replace(tzinfo=None)
    if roundtrip != naive:
        raise TimeInputError(
            "nonexistent_local_time",
            f"{naive.isoformat(timespec='minutes')} does not exist in {tz} (clocks moved forward).",
        )
    if first.utcoffset() != second.utcoffset():
        if fold is None:
            raise TimeInputError(
                "ambiguous_local_time",
                f"{naive.isoformat(timespec='minutes')} happens twice in {tz}; send fold=0 for the "
                "first occurrence or fold=1 for the second.",
            )
        first = second if fold == 1 else first
    return ResolvedTime(first.astimezone(UTC), first, tz, format_offset(first.utcoffset()), assumed)


def local_midnight_utc(day: date, tz: str) -> datetime:
    zi = zone(tz)
    return datetime.combine(day, time(0, 0)).replace(tzinfo=zi).astimezone(UTC)


def jd_from_utc(instant: datetime) -> float:
    u = instant.astimezone(UTC)
    hour = u.hour + u.minute / 60 + (u.second + u.microsecond / 1e6) / 3600
    return float(swe.julday(u.year, u.month, u.day, hour, swe.GREG_CAL))


def utc_from_jd(jd: float) -> datetime:
    year, month, day, hour = swe.revjul(jd, swe.GREG_CAL)
    return datetime(year, month, day, tzinfo=UTC) + timedelta(seconds=round(hour * 3600))


def iso_z(instant: datetime) -> str:
    return instant.astimezone(UTC).isoformat().replace("+00:00", "Z")
