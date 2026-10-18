# HQ feed exporter

> Status: implemented locally; not deployed
> Date: 2026-10-18
> Counterpart: HQ repository `saturnrobotics/hq`, plan 0006C (ingest endpoint)
> Implementation plan: ../plans/2026-10-18-hq-feed-exporter.md

## TLDR

A host timer pushes Carbon's open sales orders, purchase orders and jobs, without
any money, plus each employee's Carbon permissions, to HQ every five minutes.
HQ, an internal hub deployed separately, shows a record only when both HQ's policy
and these permissions allow it. A person with access to some Carbon companies or
modules sees only those records in HQ. The exporter reads `userPermission`,
`userToCompany` and `employee`; it changes no Carbon authentication, RBAC or
multi-tenancy logic.

The user approved this cross-repository work on 2026-10-18: "Carbon can trust the
HQ login system", "Have some kind of authz composition system ... even if I only
have access to some subset of carbon stuff I can still see the stuff I'm allowed to
see", and "you can make changes in other repos to make this work. use the repo
rules for code contribution".

## Contract (schema 1)

**Transport.** Every five minutes the Carbon host sends `POST <HQ_INGEST_URL>`.
`HQ_INGEST_URL` is private configuration; in production it is HQ's
`/ingest/carbon` URL, reached over the tailnet. Headers are
`Content-Type: application/json` and `Authorization: Bearer <JWT>`. HQ answers 200
or 204; any other status, including a redirect, fails the run with a non-zero exit.
The client sends no proxy, follows no redirect, verifies TLS against the system
trust store, and times out after 30 s.

**Token.** HS256, signed with the shared key `hq_ingest_carbon_key`: at least 32
bytes, used as its UTF-8 bytes on both sides. Claims:

| Claim | Value |
| --- | --- |
| `iss` | `"carbon"` |
| `aud` | `"hq-ingest"` |
| `iat` | Unix seconds at send time |
| `exp` | `iat + 60` |
| `jti` | a fresh UUID4 per push (HQ refuses reuse) |
| `body_sha256` | lowercase hex SHA-256 of the exact body bytes sent |

**Body.** At most 8 MiB of UTF-8 JSON, compact, in this key order:

```json
{"schema": 1, "source": "carbon", "generated_at": "2026-10-18T14:00:00Z",
 "companies":       [{"id": "c1", "name": "Example Works"}],
 "entitlements":    [{"email": "ada@example.com", "scope": "c1", "permissions": ["sales_view"]}],
 "sales_orders":    [{"id": "…", "scope": "c1", "readable_id": "SO-1", "status": "Confirmed",
                      "customer": "…", "order_date": "2026-10-01", "promised_date": "2026-10-12",
                      "requires": ["sales_view", "inventory_view", "invoicing_view"]}],
 "purchase_orders": [{"id": "…", "scope": "c1", "readable_id": "PO-1", "status": "To Receive",
                      "supplier": "…", "order_date": "2026-10-02", "due_date": "2026-10-11",
                      "requires": ["purchasing_view", "inventory_view", "invoicing_view"]}],
 "jobs":            [{"id": "…", "scope": "c1", "readable_id": "J-1", "status": "In Progress",
                      "item": "…", "due_date": "2026-10-19", "requires": ["production_view"]}]}
```

- `generated_at` is the database snapshot time (transaction start), RFC 3339 UTC
  with `Z`. `scope` is the company id. Dates are `YYYY-MM-DD` or `null`.
- `companies` lists every company.
- `entitlements` has one row per active `user` and company where
  `userToCompany.role = 'employee'` and the `employee` row is active. It lists the
  `userPermission.permissions` keys whose array contains that company id, sorted.
  Carbon no longer treats `"0"` as every company, so only exact ids count. Emails
  are lowercased. Only addresses in the configured domain are included:
  `HQ_INGEST_EMAIL_DOMAIN`, defaulting to `AUTH_ALLOWED_GOOGLE_DOMAIN`. Both are
  private configuration, so no company domain appears in source. If two users'
  emails differ only by case, their shared (email, company) pair is dropped
  rather than merged.
- Only open records are listed:
  - sales orders whose status is not Completed, Invoiced, Cancelled or Closed;
  - purchase orders whose status is not Completed, Closed or Rejected;
  - jobs in Draft, Planned, Ready, In Progress or Paused.
- `promised_date` is the earliest `salesOrderLine.promisedDate` of the order.
  `due_date` for a purchase order uses each line's `promisedDate`, or its
  `requiredDate` when no promise exists, and takes the earliest. A job's
  `due_date` is `job.dueDate`. `customer` and `supplier` are names joined within
  the same company. `item` is the item's `readableIdWithRevision`, else
  `readableId`, else `name`.
- `requires` lists the permissions, any one of which lets a person see the row in
  Carbon. Sales and purchase orders mirror Carbon's RLS. Jobs require
  `production_view`, which is stricter than Carbon, whose employees may view every
  job.
- **No money.** No price, cost, rate, total, currency, exchange-rate or tax column
  is read or emitted. Before sending, the exporter refuses any key matching
  `/price|cost|rate|total|currency|tax|amount/i`. The top-level `generated_at`
  is the one exemption, because "gene*rate*d" contains `rate`.
- Each list is the complete current set; HQ replaces the source's rows atomically
  per push.

## Design

| Decision | Choice | Rationale |
| --- | --- | --- |
| Runner | systemd `carbon-hq-feed.timer` (`OnCalendar=*:0/5`) on the host, installed by `host-deploy.sh finalize` | The host routes to HQ over the tailnet. Only a verified release installs it, and the same function removes it. Same pattern as `carbon-certificates.timer` |
| Docker dependency | `After=docker.service` only, never `Requires`/`Wants` | A timer firing during a maintenance snapshot must fail, not restart Docker |
| Database read | `docker compose exec -T postgres carbon-secrets-entrypoint.sh psql -h 127.0.0.1 -U supabase_admin`, then `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE service_role` | The admin connection the host already uses, narrowed to the service role. One consistent snapshot with statement and lock timeouts |
| Dependencies | Python standard library only | The host has `python3` but no PostgreSQL driver. No new production dependencies |
| Projection | Explicit SQL columns, then an explicit Python field list per row | A widened query cannot widen the payload |
| Key storage | `HQ_INGEST_CARBON_KEY` in private secrets, then `/var/lib/carbon/secrets/hq_ingest_carbon_key` (mode 0400, root) via `render.initialize_secrets`. Removed when unset | Host-only secret: no container mounts it |
| Logging | Counts, byte size, HTTP status and error class names | Never the token, the key, the body, or a transport message that names the private host |
| Dry run | `--dry-run` prints the body to stdout and sends nothing. `--local-psql` reads a local development database through `PG*` variables | HQ plan 0006C acceptance: a dry run prints the payload |
| Route acceptance | `TAILNET_ACCEPT_ROUTES`, a private allowlist. `tailnet_routes.py apply` in `bootstrap.sh`, `check` before each push | See below |
| Release planning | `hq_feed.py` and `tailnet_routes.py` are `MAINTENANCE_PATHS`. The new config keys are unclassified, so they select maintenance too | No service owns `contrib/` files, so otherwise a change to them would be a no-op release that never reached the host |

### Route acceptance

HQ's address is a subnet route advertised by another tailnet node. Linux
Tailscale uses it only with `--accept-routes`, and it installs accepted routes
in table 52, which is consulted before the main table. Accepting every approved
route could divert the VM's own traffic: its VPC subnet, Docker bridges,
link-local metadata, or private PostgreSQL clients. So:

- Enrollment keeps `--accept-routes=false`.
- Each deployment runs `carbon-tailnet-routes apply`. With an empty or absent
  `TAILNET_ACCEPT_ROUTES` it sets `--accept-routes=false`, which preserves the
  current behaviour. Otherwise it sets `true`, then verifies that every accepted
  non-tailnet route lies inside the allowlist and overlaps no local route. On any
  violation, or if the tables cannot be read, it sets `false` again and fails.
- `carbon-tailnet-routes check` runs as the timer's `ExecStartPre` and enforces
  the same rule, so a conflicting route approved later lasts at most five minutes.
- Allowlist entries must be private /24 (IPv6 /64) or narrower, outside the tailnet
  range, the VM subnet, Docker's default pools, link-local and
  `POSTGRES_CLIENT_CIDRS`.

The HQ login back channel (HQ plan 0013) will use the same route.

## Private inputs

| Key | File | Notes |
| --- | --- | --- |
| `HQ_INGEST_URL` | `.local/config.json` | HTTPS, no credentials, query or fragment. Alone, it leaves the feed disabled |
| `HQ_INGEST_EMAIL_DOMAIN` | `.local/config.json` | Optional; defaults to `AUTH_ALLOWED_GOOGLE_DOMAIN` |
| `TAILNET_ACCEPT_ROUTES` | `.local/config.json` | List of CIDRs, normally HQ's single /32 |
| `HQ_INGEST_CARBON_KEY` | `.local/secrets.json` | ≥32 printable non-space ASCII bytes (`openssl rand -hex 32`). Requires the URL |

## Out of scope

- HQ's ingest endpoint, RLS composition and tailnet grant (HQ plan 0006C and its
  tailnet plan).
- Any Carbon schema, RLS, authentication or permission change.
- Kanban or other sources (the same contract with another `source`).
