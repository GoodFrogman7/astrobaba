"""JSON logging with PII and secret redaction (PLAN.md §0.5).

Redaction runs on every record: the formatted message, args and any `extra` fields.
It is a safety net, not a licence to log sensitive data. Chat content must never be logged.
"""

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

REDACTED = "[REDACTED]"

# Keys whose values are always dropped, wherever they appear in structured fields.
SENSITIVE_KEYS = re.compile(
    r"pass(word)?|secret|token|api[_-]?key|authorization|cookie|otp|phone|mobile|email|"
    r"body|message_text|content|dob|birth",
    re.IGNORECASE,
)

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # credentials inside URLs: scheme://user:pass@host
    (
        re.compile(r"(?P<scheme>[a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@", re.I),
        r"\g<scheme>[REDACTED]@",
    ),
    # Authorization headers / bearer tokens
    (re.compile(r"\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 [REDACTED]"),
    # key=value or key: value pairs for secret-like keys
    (
        re.compile(
            r"\b(password|passwd|secret|token|api[_-]?key|otp)(\"?\s*[:=]\s*\"?)[^\s\",;&]+", re.I
        ),
        r"\1\2[REDACTED]",
    ),
    # Razorpay / Stripe style keys
    (re.compile(r"\b(rzp|sk|pk|whsec)_(live|test)?_?[A-Za-z0-9]{8,}\b"), REDACTED),
    # emails
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    # Indian mobile numbers, with or without +91 / 0 prefix, spaces or dashes
    (re.compile(r"(?<!\d)(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), "[PHONE]"),
    # other E.164 numbers
    (re.compile(r"(?<![\w+])\+\d{10,15}(?!\d)"), "[PHONE]"),
]


def redact(text: str) -> str:
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


def redact_value(key: str, value: Any) -> Any:
    if SENSITIVE_KEYS.search(key):
        return REDACTED
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: redact_value(str(k), v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact_value(key, v) for v in value]
    return value


_STANDARD_ATTRS = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                payload[key] = redact_value(key, value)
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
