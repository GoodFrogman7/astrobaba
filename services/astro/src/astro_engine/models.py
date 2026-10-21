import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field

from astro_engine.ephemeris import Ayanamsha, NodeType

# The shipped Swiss Ephemeris files (sepl_18, semo_18) cover 1800-2399 CE.
MIN_DATE = dt.date(1800, 1, 2)
MAX_DATE = dt.date(2399, 12, 30)


class Place(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    tz: str = Field(min_length=1, max_length=64, description="IANA time zone, e.g. Asia/Kolkata")


class Birth(BaseModel):
    """Birth details. Sent in POST bodies, never in URLs, because they are personal data."""

    date: dt.date = Field(ge=MIN_DATE, le=MAX_DATE)
    time: dt.time | None = Field(default=None, description="Local clock time; null if unknown")
    place: Place
    utc_offset: str | None = Field(
        default=None,
        pattern=r"^[+-]\d{2}:\d{2}$",
        description="Override the tz database offset (e.g. +06:30), for births where local "
        "practice differed from it. Shown back in the response.",
    )
    fold: Literal[0, 1] | None = Field(
        default=None, description="For a local time that happens twice (DST end): 0 first, 1 second"
    )


class ChartOptions(BaseModel):
    ayanamsha: Ayanamsha = "lahiri"
    node: NodeType = "mean"


class KundliRequest(ChartOptions):
    birth: Birth


class DashaRequest(BaseModel):
    birth: Birth
    ayanamsha: Ayanamsha = "lahiri"
    as_of: dt.date | None = None


class DoshaRequest(BaseModel):
    birth: Birth
    ayanamsha: Ayanamsha = "lahiri"
    as_of: dt.date | None = None


class MatchRequest(BaseModel):
    groom: Birth
    bride: Birth
    ayanamsha: Ayanamsha = "lahiri"


class NumerologyRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    date_of_birth: dt.date | None = Field(default=None, ge=MIN_DATE, le=MAX_DATE)
    system: Literal["chaldean", "pythagorean"] = "chaldean"
