import pytest
from pydantic import SecretStr

from astro_api.config import Settings
from astro_api.main import create_app
from astro_api.sms import ConsoleSms, NotConfiguredError


def test_secrets_never_appear_in_repr() -> None:
    s = Settings(database_url=SecretStr("postgresql+asyncpg://astro:hunter2@db:5432/astro"))
    assert "hunter2" not in repr(s)
    assert "hunter2" not in str(s.model_dump())


def test_production_refuses_console_sms_and_dev_secret() -> None:
    with pytest.raises(RuntimeError, match="SMS_PROVIDER=console"):
        create_app(Settings(app_env="production", secret_key=SecretStr("x" * 40)))
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        create_app(Settings(app_env="production", sms_provider="msg91"))
    with pytest.raises(NotConfiguredError):
        ConsoleSms(Settings(app_env="staging"))
