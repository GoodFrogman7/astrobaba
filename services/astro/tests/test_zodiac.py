import pytest

from astro_engine.zodiac import dms, placement


@pytest.mark.parametrize(
    ("lon", "sign", "nakshatra", "pada"),
    [
        (0.0, "aries", "ashwini", 1),
        (13 + 1 / 3 - 1e-7, "aries", "ashwini", 4),
        (13 + 1 / 3, "aries", "bharani", 1),
        (29.9999999, "aries", "krittika", 1),
        (30.0, "taurus", "krittika", 2),
        (359.9999, "pisces", "revati", 4),
        (360.0, "aries", "ashwini", 1),
    ],
)
def test_boundaries(lon: float, sign: str, nakshatra: str, pada: int) -> None:
    p = placement(lon)
    assert (p["sign"], p["nakshatra"], p["pada"]) == (sign, nakshatra, pada)


def test_dms_truncates() -> None:
    assert dms(29.99999) == "29°59'59\""
    assert dms(12.5083333334) == "12°30'30\""
