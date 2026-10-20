# Build from the repo root: docker build -f services/astro/Dockerfile .
# Licence: AGPL-3.0-only (Swiss Ephemeris; ADR-0001). Source: /v1/source.

# Build stage: pyswisseph compiles from source (no Python 3.13 wheel). The full python image
# already has a C compiler; the runtime stage below stays slim.
FROM python:3.13 AS build
RUN pip install --no-cache-dir "uv>=0.11,<0.12"
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY services/api/pyproject.toml services/api/
COPY services/astro/pyproject.toml services/astro/
COPY services/worker/pyproject.toml services/worker/
RUN uv sync --frozen --no-dev --package astro-engine --no-install-workspace

# Engine data: ephemeris files (checksummed) and the city index (GeoNames, falling back to the
# extract bundled with geonamescache when download.geonames.org is unreachable).
COPY data/fetch_ephemeris.py data/import_cities.py data/
RUN .venv/bin/python data/fetch_ephemeris.py && .venv/bin/python data/import_cities.py

COPY services/astro services/astro
RUN uv sync --frozen --no-dev --package astro-engine --no-editable

# Runtime stage: no compiler, no build tools.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 DATA_DIR=/app/data/astro EPHE_PATH=/app/data/raw/ephe \
    CITIES_FILE=/app/data/build/cities.tsv.gz PATH=/app/.venv/bin:$PATH
WORKDIR /app
COPY --from=build /app/.venv .venv
COPY --from=build /app/data/raw data/raw
COPY --from=build /app/data/build data/build
COPY data/astro data/astro
COPY services/astro/LICENSE LICENSE
RUN useradd --uid 10001 --no-create-home app
USER app
EXPOSE 8001
CMD ["uvicorn", "astro_engine.main:app", "--host", "0.0.0.0", "--port", "8001"]
