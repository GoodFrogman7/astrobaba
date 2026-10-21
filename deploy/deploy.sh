#!/usr/bin/env bash
# Build and (re)start the private preview from the current checkout. Safe to re-run.
# Usage (from the repo root on the server): deploy/deploy.sh [--voice]
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f deploy/.env ]] || { echo "deploy/.env missing: run deploy/gen-secrets.sh first" >&2; exit 1; }

compose=(docker compose --env-file deploy/.env -f docker-compose.yml -f deploy/compose.preview.yml)
[[ "${1:-}" == "--voice" ]] && compose+=(--profile voice)

# Swiss Ephemeris files and the city index are downloaded at image build time (free sources).
"${compose[@]}" build
"${compose[@]}" up -d --remove-orphans   # the API applies database migrations on start
"${compose[@]}" ps

domain=$(grep '^DOMAIN=' deploy/.env | cut -d= -f2-)
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --resolve "api.${domain}:443:127.0.0.1" "https://api.${domain}/healthz"; then
    echo "Up: https://${domain}  https://portal.${domain}  https://admin.${domain}"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 5
done
echo "API not healthy after 5 minutes; see: ${compose[*]} logs api caddy" >&2
exit 1
