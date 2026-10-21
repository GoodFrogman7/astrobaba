from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from astro_api.config import Settings


class Base(DeclarativeBase):
    """Declarative base for all API tables."""


def make_engine(url: str, settings: Settings | None = None) -> AsyncEngine:
    s = settings or Settings.model_construct()
    return create_async_engine(
        url, pool_pre_ping=True, pool_size=s.db_pool_size, max_overflow=s.db_max_overflow
    )


def make_redis(settings: Settings) -> Redis:
    """Every chat socket holds one pool connection for its pub/sub subscription, so the pool
    needs room for all open sockets plus ordinary commands (redis-py's default is 100)."""
    return Redis.from_url(
        settings.redis_url.get_secret_value(), max_connections=settings.redis_max_connections
    )


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    """Request-scoped session. Handlers commit explicitly; anything uncommitted rolls back."""
    maker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with maker() as session:
        yield session


Db = Annotated[AsyncSession, Depends(get_db)]


def settings_of(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def redis_of(request: Request) -> Redis:
    redis: Redis = request.app.state.redis
    return redis
