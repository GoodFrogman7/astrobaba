"""Feature flags, same rules as packages/shared/src/flags.ts.

FLAG_<NAME> in the environment overrides the default in flags.json.
"""

import json
import os
from collections.abc import Mapping
from functools import cache

from astro_api.shared_files import shared_dir


@cache
def flag_defaults() -> dict[str, bool]:
    raw = json.loads((shared_dir() / "flags" / "flags.json").read_text(encoding="utf-8"))
    return {name: bool(spec["default"]) for name, spec in raw.items()}


def flag_enabled(name: str, env: Mapping[str, str] | None = None) -> bool:
    defaults = flag_defaults()
    if name not in defaults:
        raise KeyError(f"Unknown flag: {name}")
    env = os.environ if env is None else env
    raw = env.get(f"FLAG_{name.upper()}", "").strip().lower()
    if raw in ("true", "1"):
        return True
    if raw in ("false", "0"):
        return False
    return defaults[name]


def all_flags(env: Mapping[str, str] | None = None) -> dict[str, bool]:
    return {name: flag_enabled(name, env) for name in flag_defaults()}
