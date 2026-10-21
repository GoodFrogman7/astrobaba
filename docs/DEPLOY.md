# Deploying a private preview (free)

The whole platform on one Linux server you already have (or a free one), with no paid
services. It is a **private preview**: every page asks for a password, nothing is indexed, and
it uses the development providers. Sign-in codes appear in the server log instead of being
sent by SMS, payments are simulated, KYC files stay on the server disk, and horoscope pages
show template text built from engine facts. Production refuses all of these by design
(`check_production_settings`). §4 lists what a public launch needs.

Files: `deploy/` (Compose override, Caddyfile, scripts, crontab). Runbook for the launch itself:
[LAUNCH.md](LAUNCH.md).

## 1. A server

You need Linux (Ubuntu 22.04/24.04 or Debian 12), x86_64 or arm64, at least 2 vCPU and 4 GB of
memory (6 GB or more is comfortable; `bootstrap.sh` adds swap on smaller machines), 30 GB of
disk, a public IPv4 address, and inbound TCP 80/443 open.

- **A server you already rent** (for example the New York one): no new cost.
  - Latency to India is about 200–250 ms, which is fine for a preview.
  - For launch, the plan assumes Mumbai (ap-south-1), close to users.
  - Check that the rental contract allows a public web service.
- **Oracle Cloud Always Free**: up to 4 Arm (Ampere A1) cores and 24 GB of memory, enough for
  this stack. The trade-offs:
  - It needs a card for identity verification, which is not charged unless you upgrade.
  - Free resources live only in the home region you pick at sign-up, so pick Mumbai or Hyderabad.
  - Free Arm capacity is often "out of capacity"; retry later or in smaller shapes.
  - Sources: [Oracle Free Tier docs](https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm).
- **Your own computer** with a tunnel: possible, but Cloudflare's no-account Quick Tunnels give one
  random hostname per service and no uptime guarantee
  ([docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)). The server
  route above is simpler.

**Domain:** none is needed. [sslip.io](https://sslip.io) resolves `203-0-113-7.sslip.io` (and
`api.203-0-113-7.sslip.io`, etc.) to `203.0.113.7` for free. Caddy then gets free Let's Encrypt
certificates for each host. A domain of your own works the same way: point `@`, `api`,
`portal`, `admin` and `lk` at the server.

## 2. First deploy

On the server, as a user with sudo:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/GoodFrogman7/astrobaba/<branch>/deploy/bootstrap.sh)"
# or copy deploy/bootstrap.sh over and run: sudo bash bootstrap.sh
sudo git clone https://github.com/GoodFrogman7/astrobaba.git /opt/astrobaba   # a deploy key or token if private
sudo chown -R "$USER" /opt/astrobaba && sudo usermod -aG docker "$USER" && newgrp docker
cd /opt/astrobaba && git checkout <branch>
deploy/gen-secrets.sh 203-0-113-7.sslip.io you@example.com 203.0.113.7   # prints the preview password once
deploy/deploy.sh            # builds every image on the server, migrates, starts, waits for HTTPS
```

- The first build takes 15–30 minutes. It downloads the Swiss Ephemeris files and the city
  index from their free sources.
- After that:
  - the site is at `https://<domain>`;
  - the astrologer portal at `https://portal.<domain>`;
  - the admin console at `https://admin.<domain>`.
- Every page asks for user `preview` and the printed password.

Then:

1. **Make yourself admin:**
   - Sign in on the site with your phone number.
   - Read the code with `deploy/otp.sh`.
   - Run `docker compose --env-file deploy/.env -f docker-compose.yml -f deploy/compose.preview.yml exec api /app/.venv/bin/python -m astro_api.cli grant-role +91XXXXXXXXXX admin`.
2. **Demo astrologers** (optional, preview only): the same `exec api ...` with `-m astro_api.seed demo-astrologers`.
3. **Scheduled jobs:** edit the path in `deploy/crontab` if the checkout is not `/opt/astrobaba`,
   then run `crontab deploy/crontab`.
4. **Voice calls** (optional):
   - Set `FLAG_VOICE_CALLS=true` and `PUBLIC_IP` in `deploy/.env`.
   - Run `deploy/deploy.sh --voice`.
   - Check that UDP 50000–50100 and TCP 7881 are open in any provider firewall too.

**Updates:** `git pull && deploy/deploy.sh`. **Backups:** `deploy/backup.sh` runs nightly from the
crontab and keeps 14 dumps in `deploy/backups/`. Copy them off the server.

## 3. What the preview protects and what it does not

- **Protected:**
  - Every page is behind HTTPS and a password.
  - The API's public host only serves the chat socket; its other routes, including the
    development payment simulator, are reachable only inside the server.
  - Only Caddy listens on the internet, and the firewall allows only SSH, web and LiveKit.
  - Secrets are generated per server and live in `deploy/.env`, which is git-ignored and mode 600.
- **Not suitable for real users:**
  - OTP codes are read from logs.
  - Payments are simulated.
  - KYC files are not in encrypted object storage.
  - The policy texts are drafts.
  - Share the preview password only with testers.

## 4. What a public launch needs (and what is free)

| Need | Free option | Paid when |
|---|---|---|
| Server | your NYC server, Oracle Always Free | a Mumbai VM once there are real users (latency, data locality) |
| HTTPS, DNS | Caddy + Let's Encrypt, sslip.io | a real domain (~₹800/year) for the brand and email |
| Payments | Razorpay test mode costs nothing; live mode has no fixed fee | per-transaction fee on real payments |
| Email | Brevo/Resend free tiers over SMTP (`EMAIL_PROVIDER=smtp`) | above their daily limits |
| KYC storage | self-hosted MinIO, Backblaze B2 free 10 GB | S3 support still has to be built (`storage.py`) |
| Voice calls | self-hosted LiveKit (in this stack) | managed LiveKit at scale |
| SMS OTP | none for Indian numbers at scale | per message (DLT registration required); the only unavoidable running cost at launch |
| Horoscope prose, AI assistant | none allowed: PLAN.md §6 requires paid no-training LLM tiers | per token |
| Monitoring | Uptime Kuma (self-hosted), UptimeRobot free | — |

The launch gates in [LAUNCH.md](LAUNCH.md) §1 still apply. They are mostly decisions and
reviews rather than money: lawyer approval, verified helplines, astrologer sign-off on the
tables, and vetted astrologers.
