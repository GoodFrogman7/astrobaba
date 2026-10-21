"""Marketplace taxonomy (data/marketplace/taxonomy.json): skills, languages, genders, tiers."""

import json
from functools import cache
from typing import Any

from astro_api.errors import ApiError
from astro_api.shared_files import marketplace_dir


@cache
def taxonomy() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (marketplace_dir() / "taxonomy.json").read_text(encoding="utf-8")
    )
    return data


def ids(kind: str) -> set[str]:
    return {item["id"] for item in taxonomy()[kind]}


def tier_bounds(tier: str) -> tuple[int, int]:
    t = next((x for x in taxonomy()["tiers"] if x["id"] == tier), None)
    if t is None:
        raise ApiError(422, "invalid_tier", f"Unknown tier: {tier}")
    return int(t["min_price_per_min_paise"]), int(t["max_price_per_min_paise"])


def price_range() -> tuple[int, int]:
    """Lowest and highest price any tier allows."""
    tiers = taxonomy()["tiers"]
    return (
        min(int(t["min_price_per_min_paise"]) for t in tiers),
        max(int(t["max_price_per_min_paise"]) for t in tiers),
    )


def check_values(kind: str, values: list[str], code: str = "invalid_value") -> list[str]:
    allowed = ids(kind)
    bad = [v for v in values if v not in allowed]
    if bad:
        raise ApiError(422, code, f"Unknown {kind}: {', '.join(bad)}", invalid=bad)
    return values
