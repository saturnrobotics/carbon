# Carbon on a single VPS — Docker Swarm + Caddy

Self-host the full Carbon stack (ERP + MES + Supabase + Redis + Inngest) on **one
Linux VPS** as a single-node [Docker Swarm](https://docs.docker.com/engine/swarm/)
behind an automatic-HTTPS [Caddy](https://caddyserver.com/docs/) reverse proxy.
Secrets are real Docker Swarm secrets; only ports 80/443 are exposed.

## 📖 Full guide → [docs.carbon.ms/docs/platform/self-hosting/docker-caddy](https://docs.carbon.ms/docs/platform/self-hosting/docker-caddy)

Prerequisites, step-by-step install, how secrets work, operations, and the
production checklist all live in the docs. Quick version:

```bash
sudo ./scripts/harden.sh    # firewall, fail2ban, swap (optional, recommended)
./deploy.sh init            # swarm init + generate Docker secrets + .env
$EDITOR .env                # hosts, URLs, ACME email, SMTP
./deploy.sh up              # build + deploy + migrate
./deploy.sh status
```

## Files

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | The Swarm stack (all services, secrets, volumes, overlay network). |
| `deploy.sh` | Lifecycle: `init` / `build` / `deploy` / `up` / `migrate` / `secret` / `status` / `logs` / `down`. |
| `Caddyfile` | Reverse proxy: erp/mes/api + security headers; optional Studio behind basic-auth. |
| `Caddyfile.gcp` | VPN-only Caddy configuration using Google Cloud DNS-01. |
| `Dockerfile.caddy-gcp` | Pinned Caddy + Google Cloud DNS module build. |
| `docker-compose.gcp.yml` | Optional Swarm overlay selected by `TLS_MODE=gcp-dns` (requires the Docker Compose plugin). |
| `bin/secrets-entrypoint.sh` | Injects Swarm secrets into env (`__SECRET__` placeholders) for each service. |
| `postgres/01-roles.sh` | Supabase role bootstrap. |
| `postgres/02-performance.sh` | Postgres tuning + `pg_stat_statements`. |
| `scripts/gen-supabase-keys.sh` | Generates the Supabase JWT key trio (openssl only). |
| `scripts/harden.sh` | Host hardening (UFW, fail2ban, swap, unattended-upgrades). |
| `scripts/backup.sh` | Postgres dump + storage volume archive. |
| `.env.example` | Non-secret configuration template. |

For a VPN-only Saturn deployment, delegate the public
`acme.saturnrobotics.co` child zone from Cloudflare to Google Cloud DNS, set
`TLS_MODE=gcp-dns`, keep the pinned `CADDY_IMAGE` value from `.env.example`, and
create the ADC credential secret without placing it in `.env`:

```bash
./deploy.sh secret gcp_application_credentials < /path/to/adc.json
```

The Google identity must have read access to list the project zones and write
access only to the dedicated ACME zone. Application A/AAAA records remain
private in Tailscale DNS; Google Cloud DNS hosts certificate challenges only.
