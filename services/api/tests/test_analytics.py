import json
from typing import Any

import pytest

from astro_api.analytics import validate_event
from astro_api.shared_files import shared_dir

CASES: dict[str, Any] = json.loads((shared_dir() / "analytics" / "cases.json").read_text())


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["name"])
def test_shared_cases(case: dict[str, Any]) -> None:
    errors = validate_event({**CASES["base"], **case["event"]})
    assert (errors == []) is case["valid"], errors
