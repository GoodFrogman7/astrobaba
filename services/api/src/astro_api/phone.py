"""Indian mobile numbers only (PLAN.md §1: India-first). Normalised to E.164 (+91XXXXXXXXXX)."""

import re

from astro_api.errors import ApiError

_INDIAN_MOBILE = re.compile(r"^(?:\+?91|0)?([6-9]\d{9})$")


def normalize_phone(raw: str) -> str:
    compact = re.sub(r"[\s\-()]", "", raw or "")
    match = _INDIAN_MOBILE.fullmatch(compact)
    if not match:
        raise ApiError(422, "unsupported_phone", "Enter a 10-digit Indian mobile number.")
    return "+91" + match.group(1)


def mask_phone(e164: str) -> str:
    """+919876543210 → +91•••••43210 (safe for logs and UI)."""
    return e164[:3] + "•" * (len(e164) - 8) + e164[-5:]
