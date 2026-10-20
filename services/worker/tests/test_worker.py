import pytest

from astro_worker.__main__ import main


def test_list_with_no_jobs(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["astro_worker", "--list"]) == 0
    assert capsys.readouterr().out.strip() == "no jobs registered"


def test_usage_on_bad_args() -> None:
    assert main(["astro_worker"]) == 2
