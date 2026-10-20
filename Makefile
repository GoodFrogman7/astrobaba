.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help setup env data dev down logs ps lint typecheck test test-integration build smoke ci fmt migrate clean

help: ## List targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")

setup: env ## Install JS and Python dependencies, fetch engine data
	pnpm install --frozen-lockfile
	uv sync --frozen
	$(MAKE) data

data: data/raw/ephe/sepl_18.se1 data/build/cities.tsv.gz ## Swiss Ephemeris files + city index

data/raw/ephe/sepl_18.se1: data/fetch_ephemeris.py
	uv run python data/fetch_ephemeris.py

data/build/cities.tsv.gz: data/import_cities.py
	uv run python data/import_cities.py

dev: env ## Boot Postgres, Redis, API, astro engine and web in Docker, wait until healthy
	$(COMPOSE) up --build --detach --wait
	@echo ""
	@echo "  web    http://localhost:3000   (Hindi: http://localhost:3000/hi)"
	@echo "  api    http://localhost:8000/docs   readiness: /readyz"
	@echo "  astro  http://localhost:8001/docs"
	@echo ""
	@echo "  logs: make logs    stop: make down"

down: ## Stop the dev stack
	$(COMPOSE) down

logs: ## Follow dev stack logs
	$(COMPOSE) logs -f

ps: ## Show dev stack status
	$(COMPOSE) ps

lint: ## Lint JS/TS and Python
	pnpm lint
	pnpm format:check
	uv run ruff check .
	uv run ruff format --check .

typecheck: ## Type-check TS and Python
	pnpm typecheck
	uv run mypy

test: data ## Unit tests (no services needed)
	pnpm test
	uv run pytest

test-integration: ## Tests that need Postgres and Redis (make dev, or CI services)
	DATABASE_URL=$${DATABASE_URL:-postgresql+asyncpg://astro:astro-dev-only@localhost:5432/astro} \
	REDIS_URL=$${REDIS_URL:-redis://localhost:6379/0} \
	uv run pytest -m integration

build: ## Production build of the web app
	pnpm build

smoke: build ## SSR smoke test: / and /hi render fully on the server
	pnpm --filter @astro/web smoke

ci: lint typecheck test test-integration smoke ## Everything CI runs

fmt: ## Format all code
	pnpm format
	uv run ruff format .
	uv run ruff check --fix .

migrate: ## Apply database migrations to DATABASE_URL
	cd services/api && uv run alembic upgrade head

clean: ## Remove build output and caches
	rm -rf apps/web/.next .pytest_cache .mypy_cache .ruff_cache
