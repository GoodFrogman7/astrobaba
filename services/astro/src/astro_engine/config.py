from functools import cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


def _repo_path(*parts: str) -> Path:
    """Path inside the repo checkout (local dev and tests). Containers set explicit env vars."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "data" / "astro").is_dir():
            return parent.joinpath(*parts)
    return Path("/app").joinpath(*parts)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "staging", "production"] = "development"
    data_dir: Path = _repo_path("data", "astro")
    ephe_path: Path = _repo_path("data", "raw", "ephe")
    cities_file: Path = _repo_path("data", "build", "cities.tsv.gz")
    # Swiss Ephemeris falls back to its lower-precision Moshier model when files are missing.
    # Never allowed outside development/test (ADR-0001).
    allow_moshier: bool = False
    # Ashtakoota and dosha tables need an astrologer's sign-off before going public (data/astro).
    # Unset means: required in staging and production.
    require_reviewed_tables: bool | None = None

    @property
    def is_production(self) -> bool:
        return self.app_env in ("staging", "production")

    @property
    def reviewed_tables_required(self) -> bool:
        if self.require_reviewed_tables is not None:
            return self.require_reviewed_tables
        return self.is_production


@cache
def get_settings() -> Settings:
    return Settings()
