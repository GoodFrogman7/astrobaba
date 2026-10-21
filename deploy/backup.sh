#!/usr/bin/env bash
# Nightly compressed Postgres dump, keeping the last 14 (run from cron, see deploy/crontab).
# Copy deploy/backups/ off the server regularly; a backup on the same disk is not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p deploy/backups && chmod 700 deploy/backups
user=$(grep '^POSTGRES_USER=' deploy/.env | cut -d= -f2- || true)
docker compose --env-file deploy/.env -f docker-compose.yml -f deploy/compose.preview.yml \
  exec -T postgres pg_dump -U "${user:-astro}" -Fc "${user:-astro}" \
  > "deploy/backups/astro-$(date -u +%Y%m%dT%H%M%SZ).dump"
ls -1t deploy/backups/astro-*.dump | tail -n +15 | xargs -r rm --
