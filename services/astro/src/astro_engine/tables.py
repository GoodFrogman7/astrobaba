"""Static Jyotish tables from data/astro. Loaded once; never computed, never LLM output."""

import json
from dataclasses import dataclass
from functools import cache
from typing import Any

from astro_engine.config import get_settings

NAKSHATRA_SPAN = 360.0 / 27  # 13°20'
PADA_SPAN = NAKSHATRA_SPAN / 4
TITHI_SPAN = 12.0
KARANA_SPAN = 6.0


@cache
def get_table(name: str) -> dict[str, Any]:
    """Any data/astro table by file stem (e.g. "choghadiya"), loaded once."""
    path = get_settings().data_dir / f"{name}.json"
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


@dataclass(frozen=True)
class Tables:
    signs: list[dict[str, Any]]
    nakshatras: list[dict[str, Any]]
    tithis: list[dict[str, Any]]
    yogas: list[dict[str, Any]]
    karanas_movable: list[dict[str, Any]]
    karanas_fixed: dict[str, dict[str, Any]]
    weekdays: list[dict[str, Any]]
    vimshottari: dict[str, Any]
    friendships: dict[str, Any]
    doshas: dict[str, Any]
    matching: dict[str, Any]
    nakshatra_review: str

    def sign(self, index: int) -> dict[str, Any]:
        return self.signs[index % 12]

    def review_status(self) -> dict[str, str]:
        """Review state of the tables whose conventions vary between sources."""
        return {
            "matching": self.matching["review"]["status"],
            "doshas": self.doshas["review"]["status"],
            "nakshatra_attributes": self.nakshatra_review,
        }


@cache
def get_tables() -> Tables:
    nak = get_table("nakshatras")
    karanas = get_table("karanas")
    return Tables(
        signs=get_table("signs")["signs"],
        nakshatras=nak["nakshatras"],
        tithis=get_table("tithis")["tithis"],
        yogas=get_table("yogas")["yogas"],
        karanas_movable=karanas["movable"],
        karanas_fixed=karanas["fixed"],
        weekdays=get_table("weekdays")["weekdays"],
        vimshottari=get_table("vimshottari"),
        friendships=get_table("friendships")["relations"],
        doshas=get_table("doshas"),
        matching=get_table("matching"),
        nakshatra_review=nak["review"]["status"],
    )
