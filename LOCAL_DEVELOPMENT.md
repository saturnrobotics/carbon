# Local Development

This guide gets Carbon running from the current checkout. Carbon's `crbn` CLI
starts an isolated Docker/Supabase stack, applies migrations, generates database
types, and launches the ERP and/or MES applications.

## Prerequisites

Install these before continuing:

- Git
- nvm (the commands below use it to select the repository's Node version)
- Node.js 22 (`.nvmrc` contains `v22`)
- Docker Desktop on macOS/Windows, or Docker Engine on Linux
- Corepack, included with Node.js
- A POSIX shell: macOS, Linux, WSL, or Git Bash

Native PowerShell and `cmd.exe` are not supported by the development CLI. Make
sure Docker is running before starting Carbon.

## First-time setup

From the repository root:

```bash
nvm use
corepack enable
pnpm install
source ./setup.sh
cp .env.example .env
```

`source ./setup.sh` installs the `crbn` command and activates it in the current
shell. If you run `./setup.sh` instead, open a new shell or source your shell's
rc file afterward.

For the default local login, the placeholder values in `.env.example` are
enough. At minimum, keep non-empty values for required settings such as
`SESSION_SECRET`, `POSTHOG_PROJECT_PUBLIC_KEY`, and `RESEND_API_KEY`; the app
validates several variables as soon as it boots. Use real credentials only when
testing the corresponding external service.

Keep genuine secrets in `.env`. Do not add local ports, URLs, Supabase keys,
Redis settings, or Inngest settings there—`crbn up` generates those values in
`.env.local` for the current checkout. Do not edit or commit `.env.local`.

## Start Carbon

Confirm Docker is running, then execute:

```bash
crbn up
```

Choose ERP, MES, or both in the prompt. The first run may take several minutes
while Docker images are downloaded and the database is initialized. Subsequent
runs reuse the installed dependencies, images, and database volume.

For a non-interactive ERP + MES start:

```bash
crbn up --all
```

When startup finishes, `crbn` prints the URLs for the applications and local
services. They normally follow this pattern:

| Service | URL |
| --- | --- |
| ERP | `https://<checkout>.erp.dev` |
| MES | `https://<checkout>.mes.dev` |
| Supabase Studio | `https://<checkout>.studio.dev` |
| Inngest | `https://<checkout>.inngest.dev` |
| Local email | `https://<checkout>.mail.dev` |

The exact URLs and dynamically allocated ports are always available with:

```bash
crbn status
```

The main checkout may use the shorter `https://erp.dev` and
`https://mes.dev` aliases.

## Log in

1. Open the ERP URL printed by `crbn up`.
2. Enter `test@carbon.ms` in the email field.
3. Select **Sign in with Email**.

`crbn up` seeds this user and writes the local-only bypass configuration into
`.env.local`, so no email provider is required. Other email addresses use the
normal magic-link flow; development messages appear in the local email service.
The authenticated session also works in MES.

## Daily commands

```bash
crbn up                 # start the stack and select applications
crbn up --all           # start ERP and MES without a prompt
crbn up --no-apps       # start backing services only
crbn status             # show URLs, ports, and container health
crbn down               # stop containers and preserve local data
crbn reset              # erase this checkout's local data and start fresh
pnpm db:migrate         # apply new migrations to the running stack
pnpm run generate:types # regenerate database types after schema changes
```

Stopping the foreground `crbn up` process also tears down its application
processes. Use `crbn down` if backing services remain active.

## Troubleshooting

### `crbn` is not found

Activate the installed shell configuration:

```bash
source ./setup.sh
```

Alternatively, open a new terminal after running `./setup.sh`.

### Docker is unavailable

Start Docker Desktop or the Docker daemon, verify `docker info` succeeds, and
run `crbn up` again.

### `*.dev` certificate or routing problems

The default setup uses Portless for local HTTPS. Let `setup.sh` complete its
Portless installation and approve any requested system permissions. If local
HTTPS is not usable in your environment, start with direct localhost URLs:

```bash
crbn up --no-portless
```

### A migration or generated type is stale

With the stack running:

```bash
pnpm db:migrate
pnpm run generate:types
```

Do not rebuild or reset the database merely to apply a migration. `crbn reset`
is destructive and should only be used when you intentionally want fresh data.

### Inspect service state and logs

Start with:

```bash
crbn status
```

The status output identifies the checkout's Compose project and assigned ports.
Use standard Docker tooling against that project if deeper inspection is
needed.

## Optional: 3D assembly service

ERP and MES run without the Rust assembler. To enable STEP-to-GLB conversion and
assembly motion planning on macOS, install the native dependencies and perform
the one-time OpenCASCADE build:

```bash
brew install fcl cmake ninja
./apps/assembler/scripts/build-occt.sh
cargo build --release -p assembler
```

Then select **Assembler** when running `crbn up`. Linux requires the equivalent
FCL, libccd, Eigen, Octomap, CMake, Ninja, and C/C++ development packages. See
the assembler section in the main [README](README.md#optional-the-assembler-geometry-service)
for platform details.

## Validate a change

Use the smallest validation scope relevant to your work:

```bash
pnpm exec turbo run typecheck --filter=erp
pnpm exec turbo run typecheck --filter=mes
pnpm --filter @carbon/react test
pnpm run lint
```

Avoid the whole-repository typecheck for routine changes because it can exhaust
available memory.

# Saturn Production

Saturn production runs on the server rack behind the company VPN. Production is
separate from the local development stack: never run `crbn up`, `crbn reset`, or
development seed commands on the production host.

## Branch model

The repositories and branches have distinct responsibilities:

```text
crbnos/carbon:main
        ↓ sync the unmodified upstream branch
saturnrobotics/carbon:main
        ↓ reviewed integration PR
saturnrobotics/carbon:saturn/main
        ↓ successful production workflow
Saturn production rack
```

- `main` in the Saturn fork remains a clean mirror of upstream Carbon.
- `saturn/main` is the protected production integration branch.
- Set `saturn/main` as the Saturn fork's default branch. This makes new pull
  requests target production intentionally and is required because GitHub only
  runs scheduled workflows, including the daily backup, from the default branch.
- Create feature branches from `saturn/main` and merge them back through pull
  requests.
- Bring upstream changes into `saturn/main` through a `main` → `saturn/main`
  pull request. Do not automatically merge upstream into production.
- A commit on `saturn/main` expresses production intent. It is confirmed as a
  production release only after the deployment workflow succeeds.

### Make commands for branch promotion

The root [`Makefile`](Makefile) wraps the routine Git and GitHub CLI operations.
It assumes `origin` is `saturnrobotics/carbon` and uses `saturn/main` as the
production branch. The commands are guarded, but they still create branches,
push commits, merge pull requests, or create tags when explicitly invoked.

```bash
make help

# Create feature/my-change from the latest origin/saturn/main.
make feature NAME=my-change

# Push the current feature branch and open its production PR.
make push-feature
make feature-pr

# After review, wait for required checks and merge the PR.
make merge-pr PR=123

# Fast-forward the fork's main mirror, then open the reviewed upstream PR.
make sync-upstream
make upstream-pr

# Inspect the most recent successful deployment.
make production-status

# Tag the current successfully deployed saturn/main commit.
make production-tag TAG=prod-2026.07.16.1
```

`production-tag` refuses to tag when the latest successful production workflow
does not match the current `origin/saturn/main` commit. Production tags are
annotated and follow `prod-YYYY.MM.DD.N`. Add a GitHub tag ruleset matching
`prod-*` that blocks deletion, updates, and force pushes so release tags remain
immutable.

The repository's production workflow is
[`.github/workflows/saturn-production.yml`](.github/workflows/saturn-production.yml).
It triggers only for `saturnrobotics/carbon` pushes to `saturn/main` and runs on
a dedicated runner inside the VPN. The upstream Carbon AWS/Supabase workflows
are explicitly restricted to `crbnos/carbon` so they cannot deploy the Saturn
fork.

## Protect the production branch

Create a GitHub ruleset for `saturn/main` with:

- Pull requests required; no direct pushes.
- At least one approval, with two recommended for database or infrastructure
  changes.
- Stale approvals dismissed after new commits.
- Code-owner review and resolved conversations required.
- The Lint, Typecheck, Test, and Lingui jobs required.
- The branch required to be current before merging.
- Force pushes and branch deletion blocked.
- Bypass access limited to an emergency administrator group.

Protect `main` as well so it remains a trustworthy upstream mirror. Create a
GitHub Environment named `production`, restrict it to `saturn/main`, and require
an operator approval until the deployment and restore processes have been
proven. The production job is serialized and cannot be cancelled by a newer
commit.

## Rack and VPN topology

Install the production runner and Docker Swarm manager on a hardened Linux host
inside the VPN. Give the runner these labels:

```text
self-hosted, linux, x64, saturn-production
```

The runner must be dedicated to this repository and must not accept jobs from
untrusted repositories or pull requests. A self-hosted runner executes workflow
code with access to Docker and therefore effectively has root-equivalent access
to the production stack.

Network policy:

- Permit inbound ERP, MES, and API traffic only from approved VPN subnets.
- Permit SSH only from the management VPN subnet.
- Do not expose Postgres, Redis, Inngest, Supabase Studio, or the Docker socket.
- Allow outbound HTTPS for GitHub Actions, container images, email, and required
  integrations.
- Apply host firewall rules even if the rack firewall already filters traffic.
- Keep Supabase Studio disabled unless it is placed behind separate strong
  authentication and VPN ACLs.

The included Caddy configuration normally obtains public Let's Encrypt
certificates using inbound ports 80/443. A VPN-only hostname cannot complete a
public HTTP-01 challenge. Before the first deployment, choose one of these
approved TLS models:

1. Terminate TLS at an existing VPN ingress/load balancer using the company PKI.
2. Use an internal CA and install its root certificate on every VPN client and
   on the production runner.
3. Use DNS-01 certificate issuance through the DNS provider without exposing
   the rack publicly.

Do not disable TLS verification or use `curl -k`. The deployment runner must
trust the selected production CA so its post-deploy health checks are meaningful.

## One-time production host setup

Install and configure:

- A supported Linux distribution with automatic security updates.
- Docker Engine with Swarm mode initialized.
- Git, curl, gzip, tar, OpenSSL, and standard GNU utilities.
- The dedicated GitHub Actions runner service.
- A monitored external backup target mounted at `/mnt/carbon-backups`.

The runner service account needs access to Docker and write access to:

```text
/opt/carbon/releases
/mnt/carbon-backups
```

Create the production configuration from the example:

```bash
sudo install -d -m 755 /etc/carbon /opt/carbon/releases
sudo install -m 600 \
  contrib/deploying/simple-docker-caddy/.env.example \
  /etc/carbon/production.env
```

Edit `/etc/carbon/production.env` with the production hosts, URLs, SMTP
settings, edition, and capacity settings. The workflow overwrites
`CARBON_REPO`, `CARBON_IMAGE_ERP`, and `CARBON_IMAGE_MES` inside each staged
release, so production always uses the approved commit SHA.

Initialize Swarm secrets once from a controlled checkout on the rack:

```bash
cd contrib/deploying/simple-docker-caddy
./deploy.sh init
```

Move the resulting protected configuration into
`/etc/carbon/production.env`, set its mode to `600`, and replace placeholder
Docker secrets before the first deployment. Never commit the production `.env`
or copy secret values into GitHub logs. If OAuth credentials are placed in this
file, treat it as a secret-bearing file and include it in the rotation policy.

## Production deployment sequence

On each merge to `saturn/main`, the self-hosted workflow:

1. Verifies the repository and exact production ref.
2. Exports the approved commit into `/opt/carbon/releases/<git-sha>`.
3. Copies the protected production configuration into that immutable release.
4. Tags ERP and MES images with the exact commit SHA.
5. Requires `/mnt/carbon-backups` to be a mounted external filesystem.
6. Creates a Postgres dump and object-storage archive before an upgrade.
7. Builds the new images.
8. On an existing stack, applies forward migrations while the old applications
   remain live.
9. Deploys and rolls the new ERP/MES tasks.
10. Waits for container health and checks the ERP and MES `/health` endpoints.
11. Records the successful release through `/opt/carbon/releases/current` and
    `/opt/carbon/releases/current-sha`.

The first installation is necessarily different: it creates the data plane,
then applies migrations, and finally rolls the application tasks.

## Migration rules

Production migrations are forward-only and append-only:

- Create migrations with `pnpm db:migrate:new <name>`.
- Never edit or rename a migration already applied to production.
- Never use a timestamp older than the newest deployed migration.
- Test against a recent sanitized production snapshot before merging.
- Use expand/contract changes so the old app remains compatible while the
  migration runs: add → dual-read/write if necessary → backfill → switch →
  remove in a later release.
- Do not combine a destructive schema change and the only compatible app version
  in one rollout.
- Never reset, rebuild, or reseed the production database.

Database rollback is not automatic. If an application rollout fails after a
migration, prefer fixing forward. Redeploying an earlier application image is
safe only when the migration is backward-compatible.

## Backups and recovery

The deployment workflow takes a backup before every upgrade. The scheduled
workflow [`.github/workflows/saturn-backup.yml`](.github/workflows/saturn-backup.yml)
also runs daily at 05:17 UTC and verifies both archives.

`/mnt/carbon-backups` must be storage outside the production host—for example a
NAS with snapshots and replication. A directory on the production server's
system disk is not a backup. Configure retention and a second offsite or
immutable copy at the storage layer.

At least quarterly, restore a backup into an isolated non-production stack and
record:

- Backup timestamp and size.
- Database restoration result.
- Object-storage restoration result.
- Application login and representative transaction checks.
- Recovery time and any manual steps.

Do not test restoration against the production volumes.

## Routine operations

From the active release directory on the rack:

```bash
cd /opt/carbon/releases/current/contrib/deploying/simple-docker-caddy
./deploy.sh status
./deploy.sh logs erp
./deploy.sh logs mes
./deploy.sh logs postgres
```

Monitor at minimum:

- ERP, MES, and API uptime and latency.
- Swarm task restarts and unhealthy containers.
- CPU, memory, disk, inode, and storage-volume capacity.
- Postgres connections, locks, replication/PITR status if configured, and slow
  queries.
- Backup freshness and archive verification.
- TLS certificate expiry.
- GitHub production workflow failures.

Never run `./deploy.sh down --volumes` in production. That option deletes the
database and storage volumes.
