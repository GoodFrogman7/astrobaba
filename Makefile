.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help setup env data dev down logs ps seed admin-role reconcile expire-promo lint typecheck test test-integration build smoke ci fmt migrate clean

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

dev: env ## Boot the whole stack in Docker (db, cache, API, engine, LiveKit, web, admin, astrologer) and wait
	$(COMPOSE) up --build --detach --wait
	@echo ""
	@echo "  web    http://localhost:3000   (Hindi: http://localhost:3000/hi)"
	@echo "  api    http://localhost:8000/docs   readiness: /readyz"
	@echo "  astro  http://localhost:8001/docs"
	@echo "  admin  http://localhost:3001   (make admin-role PHONE=98xxxxxxxx; make seed for demo data)"
	@echo "  astrologer console  http://localhost:3002   (sign in with a live astrologer's phone)"
	@echo ""
	@echo "  logs: make logs    stop: make down"

down: ## Stop the dev stack
	$(COMPOSE) down

logs: ## Follow dev stack logs
	$(COMPOSE) logs -f

ps: ## Show dev stack status
	$(COMPOSE) ps

seed: ## Demo astrologers, reviews and a demo client (development only; refused in production)
	$(COMPOSE) exec api /app/.venv/bin/python -m astro_api.seed demo-astrologers

admin-role: ## Grant the admin role: make admin-role PHONE=9876543210
	$(COMPOSE) exec api /app/.venv/bin/python -m astro_api.cli grant-role $(PHONE) admin

reconcile: ## Daily money reconciliation (production: cron daily): make reconcile [DATE=YYYY-MM-DD]
	$(COMPOSE) exec api /app/.venv/bin/python -m astro_api.cli reconcile $(if $(DATE),--date $(DATE),)

expire-promo: ## Expire lapsed promo credit (production: cron hourly)
	$(COMPOSE) exec api /app/.venv/bin/python -m astro_api.cli expire-promo

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
