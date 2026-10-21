"""Server-side per-minute metering loop (Phase 4, sessions work). Started and stopped from the
API lifespan; must be safe to run in several processes at once (idempotent ledger keys and row
locks)."""

from fastapi import FastAPI


async def start(app: FastAPI) -> None:
    """Start the background meter task (no-op until implemented)."""


async def stop(app: FastAPI) -> None:
    """Stop the background meter task."""
