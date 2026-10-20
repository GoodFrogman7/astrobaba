from functools import cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Placeholder so local development works without a .env; refused outside development/test.
DEV_SECRET_KEY = "dev-only-insecure-secret-key-change-me"  # noqa: S105 - refused in production


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

    # Keys OTP codes (HMAC) and rate-limit buckets. Must be set outside development/test.
    secret_key: SecretStr = SecretStr(DEV_SECRET_KEY)
    # SMS delivery for OTP codes: "console" logs them (development/test only).
    sms_provider: Literal["console", "msg91"] = "console"
    # Bearer token for /v1/admin/*. Unset disables the admin endpoints (they return 404).
    admin_token: SecretStr | None = None
    # Header carrying the client IP when the API sits behind a trusted proxy (e.g. X-Forwarded-For).
    client_ip_header: str | None = None

    otp_ttl_s: int = 300
    otp_max_attempts: int = 5
    otp_resend_after_s: int = 30
    session_days: int = 30

    @property
    def is_production(self) -> bool:
        return self.app_env in ("staging", "production")


def check_production_settings(settings: Settings) -> None:
    """Refuse to start a staging/production API with development-only settings."""
    if not settings.is_production:
        return
    problems = []
    if settings.secret_key.get_secret_value() == DEV_SECRET_KEY:
        problems.append("SECRET_KEY is the development placeholder")
    if len(settings.secret_key.get_secret_value()) < 32:
        problems.append("SECRET_KEY must be at least 32 characters")
    if settings.sms_provider == "console":
        problems.append("SMS_PROVIDER=console only logs codes; configure a real provider")
    if problems:
        raise RuntimeError("unsafe production settings: " + "; ".join(problems))


@cache
def get_settings() -> Settings:
    return Settings()
