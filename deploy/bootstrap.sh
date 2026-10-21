#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 or Debian 12 server (x86_64 or arm64), as root.
# Installs Docker, a firewall that allows only SSH, HTTP(S) and LiveKit, automatic security
# updates, and 4 GB of swap on small machines. Everything here is free software.
# Usage: curl/scp this file to the server, then: sudo bash bootstrap.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git ufw unattended-upgrades openssl
dpkg-reconfigure -f noninteractive unattended-upgrades

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw allow 7881/tcp            # LiveKit TCP fallback (voice calls)
ufw allow 50000:50100/udp     # LiveKit media (voice calls)
ufw --force enable

# The full stack wants ~4 GB of memory; add swap when the machine has less than 6 GB.
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [[ $mem_kb -lt 6000000 && ! -e /swapfile ]]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "Done. Next: clone the repo, run deploy/gen-secrets.sh, then deploy/deploy.sh (docs/DEPLOY.md)."
