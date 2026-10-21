"""Unit tests: no services needed."""

import pytest

from astro_api import safety
from loadtest.common import Refused, ensure_run_allowed, outside_repo
from loadtest.run import MESSAGE_TEXT
from loadtest.stats import percentiles


def test_percentiles_nearest_rank() -> None:
    values = [float(v) for v in range(1, 101)]
    assert percentiles(values) == {"n": 100, "p50": 50.0, "p95": 95.0, "p99": 99.0, "max": 100.0}
    assert percentiles([]) == {"n": 0, "p50": None, "p95": None, "p99": None, "max": None}
    assert percentiles([7.0])["p99"] == 7.0


def test_message_text_passes_safety_checks() -> None:
    # The synthetic text must not trip crisis or conduct rules, or the test measures refusals.
    for role in ("user", "astrologer"):
        check = safety.check_message(role, MESSAGE_TEXT)
        assert check.refusal is None and check.crisis is None


def test_run_refused_in_production() -> None:
    for env in ("development", "test", "staging"):
        ensure_run_allowed(env)
    with pytest.raises(Refused):
        ensure_run_allowed("production")


def test_state_dir_must_be_outside_repo(tmp_path: object) -> None:
    from loadtest.common import REPO_ROOT

    with pytest.raises(Refused):
        outside_repo(REPO_ROOT / "scripts" / "loadtest" / "state")
    outside_repo(REPO_ROOT.parent / "elsewhere")
