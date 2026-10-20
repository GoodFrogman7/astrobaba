from functools import cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings from the environment (and a local .env in development).

    Anything secret is a SecretStr so it never appears in repr(), logs or tracebacks.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "staging", "production"] = "development"
    log_level: str = "INFO"
    database_url: SecretStr = SecretStr(
        "postgresql+asyncpg://astro:astro-dev-only@localhost:5432/astro"
    )
    redis_url: SecretStr = SecretStr("redis://localhost:6379/0")
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    readiness_timeout_s: float = 2.0


@cache
def get_settings() -> Settings:
    return Settings()
