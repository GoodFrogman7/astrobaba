# Build from the repo root: docker build -f services/astro/Dockerfile .
FROM python:3.13-slim
RUN pip install --no-cache-dir "uv>=0.11,<0.12"
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY services/api/pyproject.toml services/api/
COPY services/astro/pyproject.toml services/astro/
COPY services/worker/pyproject.toml services/worker/
RUN uv sync --frozen --no-dev --package astro-engine --no-install-workspace

COPY services/astro services/astro
RUN uv sync --frozen --no-dev --package astro-engine

RUN useradd --uid 10001 --no-create-home app
USER app
EXPOSE 8001
CMD ["/app/.venv/bin/uvicorn", "astro_engine.main:app", "--host", "0.0.0.0", "--port", "8001"]
