#!/usr/bin/env bash
# Create deploy/.env from deploy/env.example with fresh random secrets and a preview password.
# Usage: deploy/gen-secrets.sh <domain> <acme-email> [public-ip]
set -euo pipefail
cd "$(dirname "$0")"
[[ $# -ge 2 ]] || { echo "usage: $0 <domain> <acme-email> [public-ip]" >&2; exit 2; }
[[ ! -e .env ]] || { echo "deploy/.env already exists; delete it first to regenerate" >&2; exit 1; }

rand() { openssl rand -hex "$1"; }
password="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
hash="$(docker run --rm caddy:2.10.2-alpine caddy hash-password --plaintext "$password")"

umask 077
sed -e "s|^DOMAIN=.*|DOMAIN=$1|" \
    -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$2|" \
    -e "s|^PUBLIC_IP=.*|PUBLIC_IP=${3:-}|" \
    -e "s|^PREVIEW_PASSWORD_HASH=.*|PREVIEW_PASSWORD_HASH='$hash'|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 24)|" \
    -e "s|^SECRET_KEY=.*|SECRET_KEY=$(rand 32)|" \
    -e "s|^MESSAGES_KEY=.*|MESSAGES_KEY=$(openssl rand -base64 32)|" \
    -e "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=lk$(rand 6)|" \
    -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$(rand 32)|" \
    env.example > .env

echo "Wrote deploy/.env (mode 600)."
echo "Preview login: user 'preview', password: $password"
echo "Save the password now; only its hash is stored."
