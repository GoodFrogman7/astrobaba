from functools import cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class WorkerSettings(BaseSettings):
    """Worker settings. Database settings come from astro_api.config (same DATABASE_URL)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "staging", "production"] = "development"
    astro_url: str = "http://localhost:8001"

    # PLAN.md §2: Gemini by default, Claude swappable. "fake" is for development and tests only.
    llm_provider: Literal["gemini", "anthropic", "fake"] = "gemini"
    llm_timeout_s: float = 90.0
    gemini_api_key: SecretStr | None = None
    gemini_model: str = "gemini-2.5-flash"
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str = "claude-opus-5-5"
    anthropic_effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"

    @property
    def is_production(self) -> bool:
        return self.app_env in ("staging", "production")


@cache
def get_worker_settings() -> WorkerSettings:
    return WorkerSettings()
