import pytest

from astro_api.errors import ApiError
from astro_api.phone import mask_phone, normalize_phone


@pytest.mark.parametrize(
    ("raw", "e164"),
    [
        ("+919876543210", "+919876543210"),
        ("919876543210", "+919876543210"),
        ("09876543210", "+919876543210"),
        ("9876543210", "+919876543210"),
        ("+91 98765-43210", "+919876543210"),
        ("(+91) 6123456789", "+916123456789"),
    ],
)
def test_normalises_indian_mobiles(raw: str, e164: str) -> None:
    assert normalize_phone(raw) == e164


@pytest.mark.parametrize(
    "raw",
    ["5876543210", "+14155550100", "98765", "+91987654321", "abcdefghij", "", "+9198765432101"],
)
def test_rejects_others(raw: str) -> None:
    with pytest.raises(ApiError) as e:
        normalize_phone(raw)
    assert e.value.code == "unsupported_phone"


def test_mask() -> None:
    assert mask_phone("+919876543210") == "+91•••••43210"
