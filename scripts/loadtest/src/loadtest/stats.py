"""Percentiles (nearest rank) for latency samples in milliseconds."""

import math


def percentile(sorted_values: list[float], p: float) -> float:
    rank = max(1, math.ceil(p / 100 * len(sorted_values)))
    return sorted_values[rank - 1]


def percentiles(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"n": 0, "p50": None, "p95": None, "p99": None, "max": None}
    s = sorted(values)
    return {
        "n": len(s),
        "p50": round(percentile(s, 50), 1),
        "p95": round(percentile(s, 95), 1),
        "p99": round(percentile(s, 99), 1),
        "max": round(s[-1], 1),
    }
