"""API errors with a stable machine-readable code, shaped like the astro engine's:
{"detail": {"code": "...", "message": "..."}}."""

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
        **extra: Any,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers
        self.extra = extra


async def api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    detail = {"code": exc.code, "message": exc.message, **exc.extra}
    return JSONResponse({"detail": detail}, status_code=exc.status, headers=exc.headers)
