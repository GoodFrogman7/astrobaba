import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from redis.asyncio import Redis

from astro_api import (
    __version__,
    admin_marketplace,
    applicant,
    auth,
    horoscopes,
    kundlis,
    marketplace,
    reviews,
)
from astro_api.config import Settings, check_production_settings, get_settings
from astro_api.db import make_engine, make_sessionmaker
from astro_api.errors import ApiError, api_error_handler
from astro_api.flags import all_flags
from astro_api.health import check_dependencies
from astro_api.logs import configure_logging
from astro_api.otp import OtpService
from astro_api.sms import make_sms_sender
from astro_api.storage import make_storage

log = logging.getLogger("astro_api")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    check_production_settings(settings)
    sms = make_sms_sender(settings)
    storage = make_storage(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.engine = make_engine(settings.database_url.get_secret_value())
        app.state.sessionmaker = make_sessionmaker(app.state.engine)
        app.state.redis = Redis.from_url(settings.redis_url.get_secret_value())
        app.state.otp = OtpService(app.state.redis, settings, sms)
        app.state.storage = storage
        log.info("api started", extra={"env": settings.app_env, "version": __version__})
        try:
            yield
        finally:
            await app.state.redis.aclose()
            await app.state.engine.dispose()

    app = FastAPI(
        title="AstroPlatform API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None if settings.app_env == "production" else "/docs",
        redoc_url=None,
    )
    app.add_exception_handler(ApiError, api_error_handler)
    for router in (
        auth.router,
        kundlis.router,
        horoscopes.public,
        horoscopes.admin,
        marketplace.router,
        applicant.router,
        reviews.router,
        admin_marketplace.router,
    ):
        app.include_router(router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
        allow_credentials=True,
    )

    @app.middleware("http")
    async def request_id(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        # Log the route only: query strings can carry PII.
        log.info(
            "request",
            extra={
                "request_id": rid,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
            },
        )
        return response

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        """Liveness: the process is up. Does not touch dependencies."""
        return {"status": "ok", "version": __version__}

    @app.get("/readyz", tags=["ops"])
    async def readyz(request: Request) -> JSONResponse:
        """Readiness: Postgres and Redis reachable."""
        checks = await check_dependencies(
            request.app.state.engine, request.app.state.redis, settings.readiness_timeout_s
        )
        ok = all(c["status"] == "ok" for c in checks)
        body: dict[str, Any] = {"status": "ok" if ok else "degraded", "checks": checks}
        return JSONResponse(body, status_code=200 if ok else 503)

    @app.get("/v1/flags", tags=["config"])
    async def flags() -> dict[str, bool]:
        """Global feature flags (defaults + env overrides)."""
        return all_flags()

    return app


app = create_app()
