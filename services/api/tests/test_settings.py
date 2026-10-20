from pydantic import SecretStr

from astro_api.config import Settings


def test_secrets_never_appear_in_repr() -> None:
    s = Settings(database_url=SecretStr("postgresql+asyncpg://astro:hunter2@db:5432/astro"))
    assert "hunter2" not in repr(s)
    assert "hunter2" not in str(s.model_dump())
