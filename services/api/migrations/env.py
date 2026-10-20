import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import models  # noqa: F401 - registers tables on Base.metadata
from astro_api.config import get_settings
from astro_api.db import Base

target_metadata = Base.metadata


def _run(connection: object) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)  # type: ignore[arg-type]
    with context.begin_transaction():
        context.run_migrations()


async def run_online() -> None:
    engine = create_async_engine(get_settings().database_url.get_secret_value())
    async with engine.connect() as conn:
        await conn.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    context.configure(
        url=get_settings().database_url.get_secret_value(),
        target_metadata=target_metadata,
        literal_binds=True,
    )
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(run_online())
