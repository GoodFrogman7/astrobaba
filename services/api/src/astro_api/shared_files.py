"""Locate packages/shared and data/ from Python.

Containers set SHARED_DIR, DATA_DIR and MARKETPLACE_DIR; locally we walk up from this file to the
repo root.
"""

import os
from functools import cache
from pathlib import Path


def _locate(env_var: str, *parts: str) -> Path:
    env = os.environ.get(env_var)
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        candidate = parent.joinpath(*parts)
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(f"{'/'.join(parts)} not found; set {env_var}")


@cache
def shared_dir() -> Path:
    return _locate("SHARED_DIR", "packages", "shared")


@cache
def data_dir() -> Path:
    """data/astro (Jyotish tables)."""
    return _locate("DATA_DIR", "data", "astro")


@cache
def marketplace_dir() -> Path:
    """data/marketplace (taxonomy, billing)."""
    return _locate("MARKETPLACE_DIR", "data", "marketplace")


@cache
def legal_dir() -> Path:
    """data/legal (policy versions, operator, processors)."""
    return _locate("LEGAL_DIR", "data", "legal")


@cache
def safety_dir() -> Path:
    """data/safety (crisis helplines, conduct rules)."""
    return _locate("SAFETY_DIR", "data", "safety")


@cache
def growth_dir() -> Path:
    """data/growth (launch targets and supply goals)."""
    return _locate("GROWTH_DIR", "data", "growth")


def repo_data_dir() -> Path | None:
    """<repo>/data when running from a checkout (for dev-only defaults such as uploads)."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "data" / "astro").is_dir():
            return parent / "data"
    return None
