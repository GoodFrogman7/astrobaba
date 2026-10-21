# Build from the repo root: docker build -f services/worker/Dockerfile .
# Background jobs (ADR-0009): report PDFs (headless Chromium), report emails, AI answers, partner
# leads; also the horoscope CLI. Same image runs `python -m astro_worker jobs run`.
FROM python:3.13-slim AS base
RUN pip install --no-cache-dir "uv>=0.11,<0.12"
# Chromium prints the web app's private report pages to PDF. Noto fonts cover Latin and
# Devanagari (fonts-noto-core ships Noto Sans/Serif Devanagari), so Hindi reports never fall
# back to boxes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fontconfig fonts-noto-core fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && fc-list | grep -qi "Noto Sans Devanagari"
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 SHARED_DIR=/app/packages/shared \
    DATA_DIR=/app/data/astro MARKETPLACE_DIR=/app/data/marketplace DOCUMENTS_DIR=/app/uploads \
    CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY services/api/pyproject.toml services/api/
COPY services/astro/pyproject.toml services/astro/
COPY services/worker/pyproject.toml services/worker/
RUN uv sync --frozen --no-dev --package astro-worker --no-install-workspace

COPY packages/shared/flags packages/shared/flags
COPY packages/shared/analytics packages/shared/analytics
COPY data/astro data/astro
COPY data/marketplace data/marketplace
COPY data/seo data/seo
COPY services/api services/api
COPY services/worker services/worker
RUN uv sync --frozen --no-dev --package astro-worker

# Reports are written to DOCUMENTS_DIR, which must be the same volume the API reads from.
RUN useradd --uid 10001 --create-home app \
    && mkdir -m 0700 /app/uploads && chown app /app/uploads
USER app
WORKDIR /app/services/worker
CMD ["/app/.venv/bin/python", "-m", "astro_worker", "jobs", "run"]
