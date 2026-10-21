"""Analytics event validation. Mirrors packages/shared/src/analytics.ts; both run
packages/shared/analytics/cases.json in their tests so they cannot drift apart."""

import json
import re
from datetime import datetime
from functools import cache
from typing import Any

from astro_api.shared_files import shared_dir

_SLUG = re.compile(r"^[a-z0-9-]{1,80}$")
_PATH = re.compile(r"^/[a-z0-9/_-]{0,199}$")
_ANON = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_USER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_INT = 10**12
LOCALES = ("en", "hi")


@cache
def schema() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (shared_dir() / "analytics" / "events.json").read_text(encoding="utf-8")
    )
    return data


def _check(spec: dict[str, Any], value: Any) -> bool:
    match spec["type"]:
        case "enum":
            return isinstance(value, str) and value in spec["values"]
        case "integer":
            return type(value) is int and 0 <= value <= _MAX_INT
        case "boolean":
            return type(value) is bool
        case "slug":
            return isinstance(value, str) and bool(_SLUG.fullmatch(value))
        case "path":
            return isinstance(value, str) and bool(_PATH.fullmatch(value))
    return False


def _is_utc_instant(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate_event(event: Any) -> list[str]:
    """Return a list of errors; empty means valid. Unknown events or properties are errors."""
    if not isinstance(event, dict):
        return ["not an object"]
    s = schema()
    errors: list[str] = []
    spec = s["events"].get(event.get("event")) if isinstance(event.get("event"), str) else None
    if spec is None:
        errors.append(f"unknown event: {event.get('event')}")
    if not _is_utc_instant(event.get("ts")):
        errors.append("ts must be an ISO-8601 UTC instant ending in Z")
    anon = event.get("anonymous_id")
    if not isinstance(anon, str) or not _ANON.fullmatch(anon):
        errors.append("anonymous_id invalid")
    uid = event.get("user_id")
    if uid is not None and (not isinstance(uid, str) or not _USER.fullmatch(uid)):
        errors.append("user_id must be an opaque id or null")
    if event.get("locale") not in LOCALES:
        errors.append("locale invalid")
    if event.get("schema_version") != s["version"]:
        errors.append("schema_version mismatch")

    props = event.get("properties")
    if not isinstance(props, dict):
        errors.append("properties must be an object")
    elif spec is not None:
        for key, value in props.items():
            pspec = spec["properties"].get(key)
            if pspec is None:
                errors.append(f"unknown property: {key}")
            elif not _check(pspec, value):
                errors.append(f"invalid value for {key}")
        for key, pspec in spec["properties"].items():
            if pspec.get("required") and key not in props:
                errors.append(f"missing property: {key}")
    return errors
