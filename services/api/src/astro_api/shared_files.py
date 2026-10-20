"""Locate files in packages/shared (flags, analytics schema) from Python.

Set SHARED_DIR in containers; locally we walk up from this file to the repo root.
"""

import os
from functools import cache
from pathlib import Path


@cache
def shared_dir() -> Path:
    env = os.environ.get("SHARED_DIR")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "shared"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("packages/shared not found; set SHARED_DIR")
