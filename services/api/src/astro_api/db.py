from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Declarative base for all API tables."""


def make_engine(url: str) -> AsyncEngine:
    return create_async_engine(url, pool_pre_ping=True, pool_size=5)


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    """Request-scoped session. Handlers commit explicitly; anything uncommitted rolls back."""
    maker: async_sessionmaker[AsyncSession] = request.app.state.sessionmaker
    async with maker() as session:
        yield session
