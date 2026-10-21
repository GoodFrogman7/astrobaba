from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from astro_api.flags import flag_enabled

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
    # KYC document storage: "local" (development/test; DOCUMENTS_DIR, default <repo>/data/uploads)
    # or "s3" (production, SSE-KMS; not implemented until the bucket exists).
    documents_backend: Literal["local", "s3"] = "local"
    documents_dir: Path | None = None
    # Header carrying the client IP when the API sits behind a trusted proxy (e.g. X-Forwarded-For).
    client_ip_header: str | None = None

    # Payments. "fake" simulates Razorpay for development/test only.
    payments_provider: Literal["razorpay", "fake"] = "fake"
    razorpay_key_id: str = ""
    razorpay_key_secret: SecretStr = SecretStr("")
    razorpay_webhook_secret: SecretStr = SecretStr("")
    # Chat messages are encrypted at rest with AES-256-GCM (base64 32-byte key, id for rotation).
    messages_key: SecretStr = SecretStr("")
    messages_key_id: str = "k1"
    # Length of a billed minute. 60 in every real environment; tests shorten it.
    billing_minute_seconds: float = 60.0
    meter_tick_seconds: float = 5.0
    # Voice calls (flag voice_calls). LIVEKIT_URL is how the API reaches LiveKit's server
    # API; LIVEKIT_PUBLIC_URL is the wss:// URL browsers join.
    livekit_url: str = "http://localhost:7880"
    livekit_public_url: str = "ws://localhost:7880"
    livekit_api_key: str = ""
    livekit_api_secret: SecretStr = SecretStr("")
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
    if settings.payments_provider == "fake":
        problems.append("PAYMENTS_PROVIDER=fake")
    if settings.payments_provider == "razorpay" and not (
        settings.razorpay_key_id
        and settings.razorpay_key_secret.get_secret_value()
        and settings.razorpay_webhook_secret.get_secret_value()
    ):
        problems.append("Razorpay keys missing")
    if not settings.messages_key.get_secret_value():
        problems.append("MESSAGES_KEY missing")
    if settings.billing_minute_seconds != 60:
        problems.append("BILLING_MINUTE_SECONDS must be 60")
    if settings.documents_backend == "local":
        problems.append("DOCUMENTS_BACKEND=local keeps KYC documents on the container disk")
    if flag_enabled("voice_calls") and (
        not settings.livekit_api_key
        or len(settings.livekit_api_secret.get_secret_value()) < 32
        or not settings.livekit_public_url.startswith("wss://")
    ):
        problems.append("voice_calls on without LiveKit keys (secret >= 32 chars) and a wss:// URL")
    if problems:
        raise RuntimeError("unsafe production settings: " + "; ".join(problems))


@cache
def get_settings() -> Settings:
    return Settings()
