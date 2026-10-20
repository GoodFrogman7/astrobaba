# Build from the repo root: docker build -f services/api/Dockerfile .
FROM python:3.13-slim AS base
RUN pip install --no-cache-dir "uv>=0.11,<0.12"
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 SHARED_DIR=/app/packages/shared
WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY services/api/pyproject.toml services/api/
COPY services/astro/pyproject.toml services/astro/
COPY services/worker/pyproject.toml services/worker/
RUN uv sync --frozen --no-dev --package astro-api --no-install-workspace

COPY packages/shared/flags packages/shared/flags
COPY packages/shared/analytics packages/shared/analytics
COPY services/api services/api
RUN uv sync --frozen --no-dev --package astro-api

RUN useradd --uid 10001 --no-create-home app
USER app
WORKDIR /app/services/api
EXPOSE 8000
# Migrations run before the server starts in development; production runs them as a release step.
CMD ["sh", "-c", "/app/.venv/bin/alembic upgrade head && exec /app/.venv/bin/uvicorn astro_api.main:app --host 0.0.0.0 --port 8000 --no-access-log"]
