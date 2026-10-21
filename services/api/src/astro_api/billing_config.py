"""Money settings (data/marketplace/billing.json), loaded once like taxonomy.json.

Integer paise everywhere. Changing a value never reprices posted ledger entries.
"""

import json
from functools import cache
from typing import Any

from astro_api.shared_files import marketplace_dir


@cache
def billing() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (marketplace_dir() / "billing.json").read_text(encoding="utf-8")
    )
    return data


def currency() -> str:
    return str(billing()["currency"])


def spend_order() -> list[str]:
    """Order in which buckets are spent, e.g. ["promo", "real"] (ADR-0002 §6)."""
    order = [str(x) for x in billing()["spend_order"]["value"]]
    if sorted(order) != ["promo", "real"]:
        raise ValueError(f"spend_order must list promo and real once each: {order}")
    return order


def commission_bps(tier: str | None) -> int:
    table = billing()["commission_bps_by_tier"]
    value = table.get(tier or "", table["rising"])
    return int(value)


def recharge() -> dict[str, Any]:
    data: dict[str, Any] = billing()["recharge"]
    return data


def bonus_tiers() -> dict[str, Any]:
    data: dict[str, Any] = billing()["recharge_bonus_tiers"]
    return data


def bonus_for(amount_paise: int) -> int:
    """Bonus for a recharge of `amount_paise` from the highest tier it reaches (flag not checked
    here). floor(amount * bps / 10000)."""
    best = 0
    for tier in bonus_tiers()["tiers"]:
        if amount_paise >= int(tier["min_paise"]):
            best = max(best, int(tier["bonus_bps"]))
    return amount_paise * best // 10000


def promo_expiry_days() -> int:
    return int(bonus_tiers()["promo_expiry_days"])


def free_session() -> dict[str, Any]:
    data: dict[str, Any] = billing()["free_session"]
    return data


def sessions() -> dict[str, Any]:
    data: dict[str, Any] = billing()["sessions"]
    return data


def refund_rule(name: str) -> dict[str, Any]:
    data: dict[str, Any] = billing()["refund_rules"][name]
    return data


def reconciliation_tolerance_paise() -> int:
    return int(billing()["reconciliation"]["tolerance_paise"])
