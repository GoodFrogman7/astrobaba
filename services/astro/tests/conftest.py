import pytest

from astro_engine.config import get_settings


@pytest.fixture(scope="session", autouse=True)
def _data_present() -> None:
    s = get_settings()
    missing = [str(p) for p in (s.ephe_path / "sepl_18.se1", s.cities_file) if not p.exists()]
    if missing:
        pytest.fail(f"Missing engine data {missing}: run `make data` first", pytrace=False)
