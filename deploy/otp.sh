#!/usr/bin/env bash
# Preview only (console SMS): print the most recent sign-in codes from the API log, so the
# operator can pass a code to a tester. Phones are masked in the log.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --env-file deploy/.env -f docker-compose.yml -f deploy/compose.preview.yml \
  logs --since 30m api | grep -o 'OTP for [^"]*' | tail -n "${1:-5}"
