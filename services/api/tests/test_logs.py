import io
import json
import logging

import pytest

from astro_api.logs import JsonFormatter, redact


@pytest.mark.parametrize(
    ("raw", "leak"),
    [
        ("user +91 98765 43210 asked", "98765"),
        ("call 9876543210 now", "9876543210"),
        ("call 09876543210 now", "9876543210"),
        ("intl +447911123456", "7911123456"),
        ("mail asha.k@example.com", "asha.k@example.com"),
        ("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "eyJhbGciOiJIUzI1NiJ9"),
        ("postgresql://astro:hunter2@db:5432/astro", "hunter2"),
        ("password=hunter2&x=1", "hunter2"),
        ('{"otp": "482913"}', "482913"),
        ("key rzp_live_AbCdEf123456", "AbCdEf123456"),
    ],
)
def test_redacts_pii_and_secrets(raw: str, leak: str) -> None:
    assert leak not in redact(raw)


def test_leaves_ordinary_numbers_alone() -> None:
    # amounts, years and ids must survive
    s = "debited 19900 paise in 2026 for session 1234567"
    assert redact(s) == s


def _emit(**extra: object) -> dict[str, object]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("test.redaction")
    logger.handlers[:] = [handler]
    logger.propagate = False
    logger.warning("login for %s", "asha@example.com", extra=extra)
    result: dict[str, object] = json.loads(stream.getvalue())
    return result


def test_formatter_redacts_message_args_and_extra_fields() -> None:
    out = _emit(phone="+919876543210", meta={"token": "abc", "path": "/x"}, note="9876543210")
    text = json.dumps(out)
    assert "asha@example.com" not in text
    assert "9876543210" not in text
    assert out["phone"] == "[REDACTED]"
    assert out["meta"] == {"token": "[REDACTED]", "path": "/x"}
