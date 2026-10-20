# Carbon on GCP, accessible through Tailscale

Deploy the community edition's ERP, MES, Supabase database/auth/storage/realtime/edge functions,
Redis, Inngest and thumbnail browser on one private Compute Engine VM. This adapts
the existing `simple-docker-caddy` service definitions; upstream image changes
remain visible during upgrades. Compose is used because its port publishing can
bind HTTPS specifically to the host's Tailscale address.

The VM has **no public IP**, a dedicated VPC, outbound Cloud NAT, and SSH through
Google IAP. By default only Caddy publishes a port: `TAILSCALE_IP:443`. The database API is
private too. Cloudflare DNS-only A records point to that Tailscale address;
DNS-01 validation supplies publicly trusted certificates without opening port 80.
Existing services and records elsewhere in the DNS zone are preserved.

From a clean, committed `saturn/main` checkout on your laptop, one command after
the setup below:

```bash
make deploy
```

The command publishes the exact `saturn/main` commit to the public fork, uploads
its source directly from your laptop, and builds on the GCP server. It refuses other
branches, uncommitted changes, and non-fast-forward pushes. See
[the deployment workflow](WORKFLOW.md) for the operator steps. The existing root Makefile is only
the entry point; keep deployment changes and documentation in this directory.

`make deploy-check` validates configuration offline and makes no cloud requests.
`make deploy` calls the deployment script with `--apply` and creates billed GCP resources. Defaults are
`e2-standard-4` (4 vCPU, 16 GB memory), a 50 GB boot disk, a retained 200 GB data
disk, Cloud NAT and snapshots. Check your GCP region's costs and quotas. This is
a single server with planned downtime during updates, not a highly available
installation.

An optional private PostgreSQL listener supports another backend on a connected
GCP VPC. See [private database clients](#private-database-clients) below.
An optional [private load balancer mode](#private-load-balancer-mode) instead
serves the same stack behind another deployment's internal load balancer, on a
data disk copied from an existing installation, with no tailnet node.

## One-time setup

The optional private PostgreSQL listener requires **OpenSSL 3 or later** on the
machine rendering its certificates (OpenSSL 3 is tested). Check `openssl version`
before enabling it. macOS's bundled LibreSSL lacks the required certificate
verification options. With Homebrew OpenSSL installed, select it for the current
shell:

```bash
export PATH="$(brew --prefix openssl@3)/bin:$PATH"
openssl version
```

An unsupported or unavailable TLS tool fails before certificate files or their
permissions change. Use the same supported toolchain for local deployment tests.

You need four values: a Cloudflare API token, a Tailscale auth key, and the Google
OAuth client ID and secret. Save them in `.local/secrets.json`. Save the project,
hostnames and certificate contact email in `.local/config.json`. Both files are
gitignored. Do not overwrite files that you have already filled in.

On a new clone, create the private files first. Run this from the repository root;
it preserves any existing configuration:

```bash
(
  cd contrib/deploying/gcp-tailscale
  mkdir -p .local
  chmod 700 .local
  test -f .local/config.json || cp config.example.json .local/config.json
  test -f .local/secrets.json || cp secrets.example.json .local/secrets.json
  chmod 600 .local/*.json
)
```

1. Create a dedicated billed GCP project. Install Python 3 and `gcloud` locally,
   and `make`, then run `gcloud auth login`. The deploy operator needs Compute administration,
   API enablement, IAP tunnel access and OS Login with sudo. In the project's
   **IAM & Admin → IAM** page, grant the deploying account these roles if it
   does not already have equivalent permissions: **Compute Admin**,
   **Service Usage Admin**, **IAP-secured Tunnel User**, and **Compute OS Admin Login**.
   Organization policies may additionally restrict these actions. The VM has no
   service account or project API privileges. Use a GCP region such as `us-east1`;
   `us-east-1` is an AWS region spelling.
2. In Cloudflare, open **My Profile → API Tokens → Create Token → Create Custom Token**.
   Name it `Carbon DNS`. Add permissions **Zone / DNS / Edit** and **Zone / Zone / Read**.
   Under **Zone Resources**, choose **Include → Specific zone → your domain**.
   Create the token and paste it into `CLOUDFLARE_API_TOKEN` in the private secrets file.
   Leave client-IP filtering unset: deployment uses the token from both the operator's
   machine and the VM for certificate renewal.
   Existing A/AAAA/CNAME records for the three new hosts must be absent, or an A
   record must already match the private address and be DNS-only. The script
   refuses conflicting records; it never changes unrelated records or Workers.
3. In Tailscale's admin console, open **Access controls** and merge the fragment
   below into the existing policy: add the tag inside `tagOwners` and add the
   rule inside `grants`. Keep the existing entries. Then open **Settings → Keys →
   Generate auth key**. Set **Reusable: off**, **Ephemeral: off**, **Pre-approved: on**
   (when device approval is enabled), and select the tag `tag:carbon`.
   Paste the new key into `TAILSCALE_AUTH_KEY` in the private secrets file.
   The key is read from a file
   during enrollment, then removed from the VM. Tailscale node state is retained
   on the data disk; later deploys do not require a fresh enrollment key while
   the node is still authenticated. Do not enable Funnel or share this node
   outside the organization. Ensure existing split DNS settings resolve the
   three DNS-only records. No app connector or exit node is needed.

   ```json
   {
     "tagOwners": { "tag:carbon": ["autogroup:admin"] },
     "grants": [{ "src": ["*"], "dst": ["tag:carbon"], "ip": ["tcp:443"] }]
   }
   ```

4. In Google Cloud Console, open **Google Auth Platform → Clients** and select
   your OAuth **Web application** (or create one). Under **Audience**, choose
   **Internal** within your Workspace organization. In the client settings, add
   the ERP and MES HTTPS URLs under **Authorized JavaScript origins**, and add
   this exact URL under **Authorized redirect URIs**, substituting your API host:

   ```text
   https://api.hq.example.com/auth/v1/callback
   ```

   Save the client. Paste its ID into `GOOGLE_CLIENT_ID` and its secret into
   `GOOGLE_CLIENT_SECRET` in the private secrets file. Email suffix matching alone is not
   the policy: the token hook verifies Google's signed hosted-domain claim,
   verified email, identity ownership and the session's OAuth authentication
   method. Email/password, magic links, phone, anonymous, Azure and SAML logins
   are disabled in this deployment. Google consent and callbacks occur in the
   user's Tailscale-connected browser, so the callback host stays private.

   The stack separately allowlists where Supabase Auth returns the browser after
   Google sign-in. MES uses `/callback?redirectTo=...`; its allowlist pattern
   fixes the HTTPS origin and callback path and permits values only after the
   literal `?redirectTo=` delimiter. Do not replace it with a hostname wildcard
   or `/callback**`. The production-image callback regression runs in fork CI:

   ```bash
   python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth -p 'test_callback_redirects.py'
   ```

   This test needs Docker and PyYAML. It creates and removes an isolated temporary
   authentication database and cancels synthetic OAuth flows without Google login.
5. Fill in both private files, then validate them from the repository root:

   ```bash
   make deploy-check
   ```

   `DNS_ZONE_NAME` is the Cloudflare zone root; each host may be beneath an existing
   subdomain. `AUTH_ALLOWED_GOOGLE_DOMAIN` is the exact primary Workspace domain
   accepted in both `email` and Google's `hd` claim. `SOURCE_REPO_URL` is the public
   GitHub fork. `ACME_EMAIL` is your certificate-expiry contact. Do not commit even
   the non-secret deployment configuration: it includes private company details.
6. Review and commit the code on `saturn/main`. Deployment requires a
   clean checkout, publishes that branch automatically, and verifies that the exact commit is publicly accessible.
   Only `git archive HEAD` is uploaded and built; ignored local files never enter
   the source archive. Separate private configuration travels through SSH, never
   instance metadata, build arguments, images, or GitHub Actions logs.
7. From the repository root, run `make deploy`. On first use, certificates, image builds and hundreds
   of upstream migrations take time. The script finishes only after private HTTPS,
   ERP dependency health, MES, Supabase, Inngest registration and event delivery
   checks pass. Sign in with a permitted Google account and create your company
   through Carbon's onboarding. Enter real company data in the private running
   application, never seed files or source fixtures.

Both login pages display a **Source code** link to the exact deployed commit.
Preserve the root license and commercial-file exclusions; choosing community
edition does not grant a commercial license. See [public fork policy](../../../docs/public-fork.md)
and [the authentication implementation](auth/README.md).

Optional [Mercury payment and Gmail invoice sync](PAYMENT-SYNC.md) runs hourly
inside ERP, with application controls for pausing the sync or individual mailboxes.
Bank and mailbox credentials are separate private deployment inputs.

## Updates, backup and recovery

Land changes on `saturn/main` through reviewed pull requests, review privacy and
licensing, then run `make deploy`. Deployment publishes `saturn/main`; it does not
merge anything during a rollout.

### Automatic release preparation

After the one-time account and credential setup, the normal deployment command is:

```bash
make deploy
```

It generates the release manifest, selects the required rollout, takes a recovery
snapshot before coordinated maintenance, and applies the release. Missing initial
release tracking is initialized through that same command. There is no separate
manifest-writing or baseline command to run. `make deploy-check` and
`make deploy-plan` are optional diagnostic commands, not prerequisite steps.

Preparation requires the workspace dependencies (including the repository's
Turbo binary), Python 3 with venv/pip support, and an authenticated `gcloud`
session with permission to list the deployment VM and reach it through IAP/SSH.
The `make deploy*` wrapper reuses Python with the pinned PyYAML version, or
automatically installs PyYAML 6.0.2 into the ignored `.local/deploy-python/venv`.
First setup needs package-registry access; later runs reuse that environment.
Installation logs remain private in `.local/deploy-python/bootstrap.log`, and a
failed setup stops before deployment. System Python packages are not modified.
The preview can inspect a work in progress; it is not approval of uncommitted
source. Apply still requires a clean, reviewed `saturn/main` checkout.

The generated `.local/release-plan.json` contains the complete desired ERP/MES
inventory; `.local/release-preview.json` contains the comparison with the last
successful deployment. Both are gitignored, atomically replaced with mode 600,
and contain content fingerprints rather than credential values. The command
prints affected service names and the changed input components or paths, without
printing configuration values or credentials. Node base images are pinned by
digest in root `Dockerfile.saturn`; preparation reads those reviewed references
without consulting mutable registry tags. Actual builds still require registry access.
Both app builds (`APP=erp|mes`) and the migration/seed `ops` target explicitly use
`--file Dockerfile.saturn`. Root `Dockerfile` remains upstream-owned; do not put
fork build changes there. The fork file retains workspace pruning and runtime
behavior. Portal services use their own `contrib/deploying/portal/Dockerfile.*`.
Every apply regenerates inputs, so an old preview cannot silently authorize a
different revision. The explicit `--release-plan PATH` option remains available
for operators supplying a custom reviewed input.

A server installed before release manifests has no verified baseline. `make deploy`
detects this and automatically chooses the existing coordinated snapshot/migration
rollout. It does not pretend the running images match the current source. Shared
database, authentication, routing, or infrastructure changes select the same
rollout. The command explains its choice before proceeding; coordinated maintenance
can interrupt service. Ordinary app-only changes keep the routine service-scoped
path after the baseline exists. `--maintenance` remains an optional operator
override to force maintenance, and the old `make deploy-maintenance` alias remains
compatible, but neither is required for normal use.

A failed state read stops preparation instead of being treated as a first
installation. New installations initially mark host-generated secret
versions as unknown; the next preparation observes their actual hashes and may
select additional app reconfiguration or platform maintenance. The planner does
not treat unobserved secret state as a verified baseline. Existing persistent secrets are never
generated or rotated by the preview.

Preparation compares effective rendered service configuration and mounted input
contents. An ERP-only renderer change therefore reconfigures ERP without changing
MES or selecting platform maintenance. Rendering for comparison does not write
private files or issue certificates. Platform, database and authentication inputs
retain conservative maintenance checks. This does not establish rollback safety
for the host's shared secret-file writes; secret changes still need operational
review.

The private release planner is the authority for a routine application release.
It fingerprints each service's source closure, workspace dependencies, lockfile
and catalog, generated inputs, build configuration, base image, runtime config,
and pinned secret versions. It preserves an unchanged service's deployed commit,
image digest, source link, and content-addressed config mount. A no-op performs
no VM mutation. Unknown changed-input ownership stops for review; path-filtered
CI is only a convenience.

For repository-backed planning, each service declares its pnpm `workspace` name,
the build `task` (normally `build`), its Docker or other `build_paths`, and the
pinned `base_image_digest`. The planner runs the checked-in Turbo binary to obtain
the transitive task graph and `turbo prune --docker` closure. It fingerprints only
the resulting lockfile plus catalog entries actually referenced by that closure;
manual `owned_paths` remain available for non-workspace release units. A release
invoked through `deploy.py` materializes these inputs from the reviewed checkout
before comparing the last successful manifest.

The comparison uses the last successful per-service receipts, not `HEAD~1` or the
latest merge's patch. Upstream changes, conflict resolutions, multiple skipped
deployments, removed files and changed dependency edges are included. The service's
source identity changes only when its actual build inputs change. Effective Turbo
task configuration, installed dependencies, relevant catalog entries, generators,
patches and assets are build inputs; unrelated root tasks and catalog entries do
not by themselves select both apps. Unknown changed paths require explicit
ownership or a reviewed classification as having no runtime effect.

Build input tracking is versioned. An older receipt without detailed input
evidence requires a conservative refresh; do not fabricate evidence from the
current checkout to suppress that first build. Subsequent equivalent inputs are
no-ops. The preview explains the distinction between build, configuration and
maintenance work.

Base-image security updates are ordinary reviewed source changes. Inspect the
current multi-platform digests with `docker buildx imagetools inspect node:22`
and `docker buildx imagetools inspect node:22-slim`, review the upstream image
changes, then update both `Dockerfile.saturn` defaults as appropriate. Run the
image-pin regressions and actual builds before merging. Keep these updates in regular
dependency maintenance; pinned images do not update themselves.

The Docker dependency layer installs the pruned manifests and lockfile before
application source is copied. A BuildKit package cache retains downloaded packages
when an installation really changes. The cache proof exercises `Dockerfile.saturn`
with synthetic workspaces: app source and unrelated-app edits must reuse the dependency
image; removing a workspace dependency must invalidate it. Run this proof locally
with `python3 contrib/deploying/gcp-tailscale/verify-build-cache.py`.

Routine releases build, reconfigure, and restart only the selected ERP or MES
container. PostgreSQL, Redis, Inngest, GoTrue/auth hooks, edge runtime, proxy and
network services are health-checked as dependencies and are never restarted by a
routine app release. Before promotion, the controller compares the expected
manifest generation and active service configuration digest. A stale plan or
a changed configuration label stops promotion for review. These checks do not
constitute a full audit of manually modified runtime files. A failed app
health check restores only that changed app's previously compatible Compose
definition; it never restores the shared database.

Before rollout, the host inspects actual built/reused images and records their
Docker image IDs (local configuration digests, not registry manifest digests).
Prepared Compose refers to those immutable IDs. A missing or changed reused image
stops before maintenance can interrupt services. Maintenance still prepares its
migration/seed image, but it builds an application image only when selected by
the plan. Startup or readiness failure rolls back selected apps and leaves the
last successful manifest unchanged. The controller publishes the successful receipt
only after its final cloud and service checks; finalization rechecks the live app
images, health, configuration labels, and manifest generation. A late verification
failure preserves the previous receipt, but may leave the candidate running for
operator recovery; it does not promise to reverse infrastructure changes. Run one
deployment at a time: the final receipt lock serializes publication, not the whole
provisioning and rollout process.

Database migrations, auth hooks, private-role isolation, edge runtime, proxy/
network changes, base infrastructure, and first installation select maintenance
automatically inside `make deploy`. That path quiesces the stack, takes a
consistent snapshot, applies the maintenance work, and verifies the complete
stack. It never resets the database, imports demo companies, repairs migration
history, or rotates generated database/JWT/session credentials implicitly.

All durable state is under `/var/lib/carbon` on the retained data disk, including
Docker volumes, database, uploaded files, Inngest state, secrets, certificates,
Tailscale identity and release archives. Root-only parent directories protect
these files; secrets mounted into differently privileged containers use readable
individual files inside those protected directories. Docker administrators can
access runtime secrets and must be trusted.

A daily disk snapshot schedule retains 14 days; daily snapshots of the running
stack are **crash-consistent**, not coordinated database/storage checkpoints.
The optional [managed cold backups](backups/README.md) add 90 days of daily
recovery points, monthly points for one year, external attachment bucket coverage,
and failure/overdue monitoring. Configure ignored `.local/backups.json` once;
subsequent `make deploy` runs maintain that setup independently of app releases.
Pre-deployment snapshots are retained until you deliberately remove them. Neither
images nor old source releases are pruned automatically. Monitor disk space,
certificate renewals, snapshots and costs. The VM and data disk have deletion
protection/retention; the script provides no destructive uninstall command.

If a maintenance deployment fails after migration starts, it reports failure
rather than automatically running old code against a changed schema. Inspect
private VM logs through `gcloud compute ssh ... --tunnel-through-iap`. The active
and previous Compose descriptions are in `/var/lib/carbon/runtime/`; release files
referenced by those descriptions remain in `/var/lib/carbon/prepared/` and
`releases/`. For stateful recovery, restore the **whole** pre-maintenance snapshot
to a new retained disk and boot the matching source release. Restore database,
files and secrets together; do not downgrade the schema by rerunning old
migrations. Never run the old and recovered Tailscale identities concurrently.
Practice this recovery on a separate isolated VM before relying on it.

## Private database clients

To connect another application's backend directly to PostgreSQL, add both fields
to the ignored `.local/config.json`. These are synthetic examples; use the VM's
actual internal address and the client's dedicated GCP subnet:

```json
{
  "POSTGRES_PRIVATE_IP": "10.73.0.2",
  "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26"]
}
```

The address must match the existing VM's private NIC address. Deployment reserves
it as a regional static internal address named `<VM_NAME>-postgres`. Source
networks must be explicit RFC1918 IPv4 `/24`–`/32` subnets. Deployment adds one
firewall allow rule for TCP 5432 from exactly these sources to the VM's tag and
rejects unexpected or broadened firewall rules. It binds PostgreSQL only to the
configured private address. Omitting both fields preserves the original stack
without a published PostgreSQL port. Removing previously enabled access requires
reviewing and deleting its firewall rule; deployment fails if that rule remains.

Configure private routing separately, for example VPC peering plus Cloud Run
Direct VPC egress on a dedicated client subnet. Routing, client identities,
database roles and application migrations belong to the client deployment and
are not created by Carbon's deploy command. Use a restricted login role and
isolated schema with explicitly reviewed permissions for the other application.
The private listener admits encrypted, password-authenticated connections only
to the `postgres` database and rejects access to other databases and replication.
The HTTPS Supabase API hostname is
not a PostgreSQL connection endpoint. Do not expose port 5432 publicly or publish
these credentials to a browser.

PostgreSQL presents a certificate whose IP SAN matches the private address.
Its private CA and certificate files live under
`/var/lib/carbon/private-postgres/` on the retained data disk. Copy **only
`ca.crt`** to the client application's secret/configuration store through an
authenticated operator connection. Configure its PostgreSQL driver with
`sslmode=verify-full` and `sslrootcert` pointing to that certificate. Use the
private IP as the database hostname. Passwords belong in the client's secret
store. Plaintext connections from the configured client subnets are rejected;
existing in-container Carbon connections retain their existing behavior.

The 10-year CA remains stable across deployments. Server certificates last 825
days and renew during deployment when fewer than 30 days remain. Deploy at least
once during that window or schedule a deployment before expiry. Near CA expiry,
plan renewal and distribute the replacement trust certificate to clients. Never
delete TLS state to rotate it implicitly. All database clients share Carbon's
PostgreSQL service downtime, server resources, and disk snapshot recovery point.
Their application releases can remain independent of Carbon's releases.

## Private load balancer mode

`INGRESS_MODE` selects how users reach this installation. `tailscale` (the
default, also when the key is absent) is everything described above, and its
behavior and rendered output are unchanged. `private-lb` runs the same stack as
the HTTPS backend of an internal Application Load Balancer that another
deployment owns, on that deployment's VPC, and adopts a data disk copied from an
existing installation. In this mode the tooling creates only the instance and its
daily snapshot schedule. It verifies everything else and never creates or
changes it.

What changes in `private-lb` mode:

- **Network.** `NETWORK` and `SUBNET` name an existing VPC network and subnet.
  No network, subnet, router, NAT, address or firewall rule is created, and no
  API is enabled.
- **Address.** The reserved internal address `<VM_NAME>-ip` must exist and hold
  `POSTGRES_PRIVATE_IP` in `SUBNET`. It is the VM's only address: Caddy publishes
  `POSTGRES_PRIVATE_IP:443` and PostgreSQL publishes `POSTGRES_PRIVATE_IP:5432`.
  The VM has no external address.
- **Identity.** The VM runs as `SERVICE_ACCOUNT`, an existing, enabled service
  account in `PROJECT_ID`, with the `cloud-platform` scope. That account's IAM,
  managed by the owning deployment, is the permission boundary.
- **Data disk.** `<VM_NAME>-data` must already exist, made from a snapshot of an
  installation's data disk. Provisioning refuses to create it, and bootstrap
  refuses to format a blank disk or to adopt one without Carbon state.
- **No Tailscale.** Nothing is installed. Bootstrap deletes the identity copied
  with the disk (`/var/lib/carbon/tailscale` and any saved auth key), so no second
  node can claim it. Docker waits for the private address instead of the tailnet,
  and its networks use the `172.31.0.0/16` address pool.
- **DNS.** Deployment writes no DNS records; the owning deployment points them at
  its load balancer. The Cloudflare token is still required, because certbot's
  DNS-01 validation keeps renewing the same certificates.
- **Proxy.** Caddy sets `default_sni` to `ERP_HOST`, because the load balancer and
  its health check may connect without SNI, and it answers `GET /healthz` with 200
  on every host itself, so one app's failure cannot fail its siblings' health
  checks. It trusts `X-Forwarded-For` only from the private (RFC1918) sources that
  the allowlist admits to TCP 443 on `SERVICE_ACCOUNT`, which is the load
  balancer's proxy-only subnet. Public health-check ranges are never trusted.
- **Firewall.** The enabled ingress rules on `NETWORK` must equal
  `INGRESS_ALLOWLIST` exactly: name, priority, ports, source ranges and one target
  service account. Tag targets, source tags, unlisted rules (allow or deny) and
  missing, changed or disabled listed rules all stop deployment before any change.
  GCP's implied deny covers everything else, so no deny rule is created. The list
  must admit TCP 5432 to `SERVICE_ACCOUNT` from exactly `POSTGRES_CLIENT_CIDRS`,
  because Supabase's own `pg_hba.conf` would accept other sources with a password,
  and TCP 443 from a private proxy-only subnet.
- **PostgreSQL.** The owning platform's settings are passed on the command line,
  which overrides `postgresql.conf` and earlier `ALTER SYSTEM` values:
  `max_connections=200`, `shared_buffers=1GB`, `effective_cache_size=3GB`,
  `work_mem=8MB`, `maintenance_work_mem=256MB`, `wal_level=logical`,
  `password_encryption=scram-sha-256`, `archive_mode=on`,
  `archive_command='wal-g wal-push %p'` and `archive_timeout=60s`, with a 4 GB
  container memory limit and the private listener's `ssl=on`. See
  [WAL-G archiving](#wal-g-archiving-and-base-backups).
- **Host agents.** Bootstrap installs the pinned WAL-G release, a daily base-backup
  timer and Google's Ops Agent (host metrics and logs, sent as `SERVICE_ACCOUNT`).
- **Labels.** A new instance gets the labels `app=hq,role=data`, which the owning
  platform's data-plane contract checks.
- **Refused.** Managed cold backups (`backups.json`), invoice intake
  (`INVOICE_INTAKE_ENABLED=true`), the Portal receiver (`PORTAL_*`) and
  `TAILSCALE_*` settings. Each would create or need resources outside the shared
  platform.

A synthetic example of the keys that differ from the tailscale configuration
(remove `TAILSCALE_HOSTNAME`, `PORTAL_*` and `TAILSCALE_AUTH_KEY`):

```json
{
  "INGRESS_MODE": "private-lb",
  "NETWORK": "shared-vpc",
  "SUBNET": "shared-data",
  "SERVICE_ACCOUNT": "carbon-vm@your-gcp-project.iam.gserviceaccount.com",
  "POSTGRES_PRIVATE_IP": "10.73.8.2",
  "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/24"],
  "INGRESS_ALLOWLIST": [
    {"name": "shared-allow-proxy-to-carbon", "priority": 1000, "ports": ["tcp:443"],
     "sources": ["10.73.4.0/26"], "target": "carbon-vm@your-gcp-project.iam.gserviceaccount.com"},
    {"name": "shared-allow-hc-to-carbon", "priority": 1000, "ports": ["tcp:443"],
     "sources": ["35.191.0.0/16", "130.211.0.0/22"], "target": "carbon-vm@your-gcp-project.iam.gserviceaccount.com"},
    {"name": "shared-allow-run-to-postgres", "priority": 1000, "ports": ["tcp:5432"],
     "sources": ["10.81.0.0/24"], "target": "carbon-vm@your-gcp-project.iam.gserviceaccount.com"},
    {"name": "shared-allow-iap-ssh-carbon", "priority": 1000, "ports": ["tcp:22"],
     "sources": ["35.235.240.0/20"], "target": "carbon-vm@your-gcp-project.iam.gserviceaccount.com"}
  ]
}
```

### Adopting a copied data disk

1. Quiesce the source installation and snapshot its data disk (stop Compose with
   `host-deploy.sh … quiesce`, then stop Docker), and create `<VM_NAME>-data` in
   `ZONE` from that snapshot. Keep the source VM stopped from then on: never run
   both installations against the same DNS names.
2. Select the private-lb configuration, either as `.local/` files or with
   `deploy.py --config … --secrets …`.
3. Run `make deploy-adopt` from a clean `saturn/main` whose CI passed. It
   verifies the shared resources and the allowlist, creates the instance on the
   disk and bootstraps it. Bootstrap marks the copied containers stopped, which
   is what `docker compose stop` records, so Docker's first start on the copy runs
   nothing even if the snapshot was crash-consistent. The host then keeps the
   PostgreSQL CA, reissues the server certificate only if the address changed,
   and removes the old host's containers and networks with `docker compose down`
   (never volumes) so they are recreated in the new address pool. It refuses to
   run while Carbon containers are running. Nothing is started, and no source is
   published.
4. Run `make deploy-maintenance`. The release plan observes the moved release
   manifest. Maintenance takes a recovery snapshot, applies migrations, starts the
   stack and checks every host through the private address, including `/healthz`.

Without adoption, `make deploy` in this mode stops before any change when the VM
does not exist. Deployment never follows an address change on its own: only
adoption reissues the PostgreSQL server certificate. The CA does not change, so
database clients keep their trusted `ca.crt`.

### WAL-G archiving and base backups

In `private-lb` mode PostgreSQL archives every WAL segment with WAL-G to the bucket
`<PROJECT_ID>-pg-wal`, at most a minute after it is written, and the host takes a
base backup daily at 07:00 UTC. The owning deployment creates that bucket and
grants `SERVICE_ACCOUNT` object create and read only; this tooling never creates
the bucket, holds no key file and needs no secret. WAL-G gets the account's token
from the metadata server, which containers on the Compose bridge network reach
through the host's NAT like any other address. `GCE_METADATA_HOST` names it by
address, so no DNS lookup is involved.

- **Binary.** `wal_g.py` pins WAL-G's PostgreSQL release build for linux/amd64
  by version, URL and the release's published sha256. Bootstrap downloads it to
  `/var/lib/carbon/wal-g/<version>/wal-g` and refuses any other bytes, including
  an installed file that changed. The Supabase PostgreSQL image's userland is
  musl and the release binary is linked against glibc, so `wal-g-glibc.sh` is
  mounted read-only as `/usr/local/bin/wal-g` and runs the binary, mounted
  read-only beside it, with the newest glibc loader from the image's Nix store,
  where PostgreSQL's own glibc lives.
- **Settings.** The rendered, secret-free `wal-g.env` beside `compose.json` is the
  PostgreSQL container's `env_file`: the bucket prefix, `zstd` compression,
  `WALG_PREVENT_WAL_OVERWRITE=true`, `GCS_MAX_RETRIES=3`,
  `WALG_UPLOAD_CONCURRENCY=2` and `GCE_METADATA_HOST`.
- **Fail closed.** Any WAL-G failure exits non-zero, so PostgreSQL keeps the segment
  in `pg_wal` and retries it; nothing is archived to `/dev/null`. Watch
  `pg_stat_archiver` and the free space of the data disk.
- **Base backups.** `carbon-wal-g-backup.timer` runs `/usr/local/sbin/carbon-wal-g-backup`,
  which runs `wal-g backup-push` as `postgres` inside the running PostgreSQL
  container, connected as the superuser over the container's loopback. Take the
  first one right after the first deployment in this mode, since archived WAL is
  only restorable on top of a base backup:

  ```bash
  gcloud compute ssh <VM_NAME> --zone <ZONE> --project <PROJECT_ID> --tunnel-through-iap \
    --command 'sudo systemctl start carbon-wal-g-backup.service; sudo journalctl -u carbon-wal-g-backup.service -n 20 --no-pager'
  ```

  `systemctl start` returns when the backup ends. Then confirm both halves of the
  archive: `gcloud storage ls 'gs://<PROJECT_ID>-pg-wal/basebackups_005/*_backup_stop_sentinel.json'`
  lists the backup, and `gcloud storage ls -l 'gs://<PROJECT_ID>-pg-wal/wal_005/'`
  shows segments a minute or two old.
- **Restore.** The owning deployment's restore runbook runs a scratch container of
  the same image with the same two read-only mounts and `--env-file wal-g.env`:
  `wal-g backup-fetch <directory> LATEST`, then `recovery.signal` with
  `restore_command='wal-g wal-fetch %f %p'`. The pgsodium root key is not in the
  archive; it stays in the `pgconfig` volume, which only disk snapshots cover.
- **No delete rights.** WAL-G's GCS uploader writes each object as a temporary
  `<object>_chunks/chunk0`, composes the object from it and then tries to delete
  the chunk. The account may not delete, and the bucket's retention policy forbids
  it anyway, so every object leaves its chunk behind until the bucket's lifecycle
  rule removes it, doubling the stored bytes. `GCS_MAX_RETRIES=3` bounds that
  refused delete to about two seconds per object; WAL-G's default of 16 retries
  would hold each segment for about half an hour. The same names make one failure
  permanent: if a push stops after its chunk was written but before the object
  was composed, every retry must replace that chunk, which is refused, and
  `pg_stat_archiver.last_failed_wal` stays on that segment. Clearing it takes the
  bucket owner removing that stray chunk, which the retention policy must first
  allow; until then WAL accumulates on the data disk.
- **Existing instance.** Provisioning only labels an instance it creates. Label a
  VM that predates this once, then deploy:

  ```bash
  gcloud compute instances add-labels <VM_NAME> --zone <ZONE> --project <PROJECT_ID> --labels=app=hq,role=data
  ```

The first `make deploy-maintenance` after this change installs everything and
recreates PostgreSQL with the new settings; archiving starts with it.

## Portal workforce receiver

The ERP API (`/api/v1/portal/*`) also accepts delegated requests from the
separately deployed portal services. A caller presents its own Google-signed
service token plus the end user's IAP assertion; ERP admits the pair only when
the caller is named in a trusted-caller registry and the user is enrolled. Two
optional private inputs wire that receiver; both reach only the ERP container,
never MES.

- `PORTAL_RECEIVER_AUDIENCE` in `.local/config.json`: the HTTPS URL callers
  mint their service tokens for, normally the ERP origin. Ordinary configuration,
  because it is the reviewable statement of what ERP accepts.
- `PORTAL_TRUSTED_CALLERS_JSON` in `.local/secrets.json`: the registry as a
  single-line JSON string in the shape of
  `../portal/callers.schema.json`. It names service-account subjects and IAP
  audiences, so it is a secret. It is written to the host secrets directory,
  mounted into ERP alone, and pinned in the release plan by content hash like
  the other per-service secrets, so rotating it reconfigures ERP without
  touching MES or selecting platform maintenance.

Validation is fail-closed: the registry must parse and match the schema, its
`receiver.audience` must equal `PORTAL_RECEIVER_AUDIENCE`, and the example
placeholder is refused rather than deployed. Supplying the audience alone is
allowed; the receiver then stays disabled. Remove the placeholder key from your
copy of `secrets.example.json` if you do not run the portal services.

Runtime behaviour matches the API-key branch: a workforce request is answered
with a plain `401 Unauthorized` on any verification failure, and with
`503 Workforce authentication is not configured` when no registry is set. The
body never says why. Enrolling users and registering the portal services'
identities happens in [the portal deployment](../portal/README.md); this
deployment only carries ERP's half of the contract.

## Sign-in through HQ (optional)

ERP and MES can sign people in through an HQ identity provider: HQ authenticates
them with Google Workspace, applies its own app-entry policy, and serves a
Keycloak-compatible OpenID provider that GoTrue's built-in Keycloak provider
uses. The same token hook still admits only verified accounts on
`AUTH_ALLOWED_GOOGLE_DOMAIN` (see [the authentication policy](auth/README.md#sign-in-through-hq)).
Google sign-in stays available as break-glass until you turn it off.

**HQ's app gating applies only once Google sign-in is off (cutover).** During
the transition a person HQ denies can still sign in with Google; rendering
prints a warning while both are enabled. With HQ enabled, GoTrue also applies
HQ's session limits to every session (`GOTRUE_SESSIONS_TIMEBOX=12h`,
`GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=2h`), so a revocation in HQ reaches Carbon
within the 2-hour inactivity timeout, or 12 hours after sign-in at most, plus up
to 15 minutes for the last access token: access tokens live 15 minutes instead
of an hour (`GOTRUE_JWT_EXP=900`, HQ plan 0006B). They cannot be shorter while
ERP and MES refresh a token once 10 minutes or less remain; at 10 minutes every
request would refresh and every page load would redirect to itself.
`hq_capabilities` from HQ is never used for authorization in Carbon; Carbon's
roles and RLS stay authoritative.

Private inputs, all optional and off by default:

- `HQ_SIGN_IN_ENABLED` (`"true"`/`"false"`) and `HQ_ISSUER` (HQ's origin,
  `https://<host>` without a path) in `.local/config.json`. GoTrue uses
  `<HQ_ISSUER>/oidc/keycloak` with client id `carbon` and the same
  `https://<SUPABASE_HOST>/auth/v1/callback` redirect URI as Google; register
  that URI with HQ.
- `HQ_OIDC_CARBON_SECRET` in `.local/secrets.json`: the `carbon` client secret
  HQ issued (at least 32 characters). It is mounted into GoTrue alone; the
  bootstrap GoTrue, ERP and MES never receive it. Remove the example placeholder
  if you do not use HQ.
- `GOOGLE_SIGN_IN_ENABLED` (`"true"` by default) in `.local/config.json`.
  `"false"` is accepted only together with HQ sign-in, so a deployment always
  keeps one way in. The Google client stays configured either way.

GoTrue calls HQ's token and userinfo endpoints from this VM, so the VM must reach
HQ over the tailnet: the Tailscale node must accept the subnet route to HQ, the
tailnet policy must let `tag:carbon` reach HQ on TCP 443, `HQ_ISSUER`'s host must
resolve to that private address from the VM, and HQ must present a certificate
the GoTrue image trusts. Browsers reach HQ from their own tailnet devices.
Changing any of these inputs selects coordinated maintenance, because it
reconfigures GoTrue as well as ERP and MES.

Rollout:

1. **Transition.** Set `HQ_SIGN_IN_ENABLED` to `"true"` with `HQ_ISSUER` and the
   secret, and deploy. Both login pages show **Sign in with HQ** above **Sign in
   with Google**. An employee's first HQ sign-in adds an HQ identity to their
   existing Google-created account by verified email; nothing is migrated.
   Sessions now end after 12 hours, or 2 hours idle, so existing sessions older
   than 12 hours end at their next refresh. HQ does not yet gate entry: anyone
   who qualifies can still use Google.
   Verify from a tailnet device: an HQ sign-in lands in ERP and MES; a person HQ
   denies stays on HQ's page; Google sign-in still works.
2. **Cutover.** Set `GOOGLE_SIGN_IN_ENABLED` to `"false"` and deploy. GoTrue
   refuses Google and both apps use `AUTH_PROVIDERS=hq`: a visit to a protected
   page goes straight to HQ, while a plain `/login` (for example after signing
   out) shows the HQ button. From here HQ's app gating applies to every new
   sign-in. Existing sessions continue until the session limits end them or they
   are revoked.
3. **Break-glass.** If HQ is unavailable, set `GOOGLE_SIGN_IN_ENABLED` back to
   `"true"` (keep the Google client and its Internal audience in place) and
   deploy. Setting `HQ_SIGN_IN_ENABLED` to `"false"` returns the stack to
   Google-only exactly as before.

## API access managed by HQ (optional)

Once HQ's authz service manages Carbon's permissions (see
[Permissions managed by HQ](auth/README.md#permissions-managed-by-hq)), the token
hook puts a top-level `authz_api` claim in every access token GoTrue issues: the
`api:` resources authz grants that person, never anything from user metadata.
With `AUTHZ_API_CLAIM_REQUIRED` set to `"true"` in `.local/config.json` (it
requires `HQ_SIGN_IN_ENABLED`), Kong answers 403 to such a token unless it lists
the resource its route needs:

| Route | Upstream | Needs |
| --- | --- | --- |
| `/rest/v1/` | PostgREST | `api:supabase.rest` |
| `/storage/v1/` | Storage | `api:supabase.storage` |
| `/realtime/v1/` (socket) and `/realtime/v1/api` | Realtime | `api:supabase.realtime` |
| `/functions/v1/` | edge runtime | `api:supabase.functions` |
| `/auth/v1/` and `/verify` | GoTrue | nothing: they issue and refresh the tokens |

- Kong checks the `Authorization` bearer, the `apikey` and `x-api-key` headers
  and the `apikey` query argument, every value of each. A credential that is not
  a JWT gets 401.
- anon and service_role tokens keep today's routes. So do the five-minute
  user-scoped tokens Carbon's own server signs (`getUserScopedClient`: MCP,
  `/api/v1` workforce calls, download links, workflows and Inngest dispatch),
  which carry no `session_id` and never leave that server; RLS still applies to
  them. Requests without a credential, such as public objects and image
  uploads, pass as before.
- Kong decodes tokens but holds no secret and verifies nothing: PostgREST,
  Storage, Realtime and the edge dispatcher verify every signature, so a token
  with an edited claim fails there.
- Routes are classified by the upstream they forward to. Rendering fails if
  `packages/dev/docker/kong.yml` gains an upstream the module does not classify,
  or a `pre-function` that would override the check.
- The check is a sandboxed `pre-function`, bundled with the pinned Kong 2.8.1,
  running [`auth/kong-authz-api.lua`](auth/kong-authz-api.lua); only Kong's
  `cjson.safe` is allowed into the sandbox.

Off (the default), the rendered stack is unchanged. Changing the setting
reconfigures Kong, which is platform state, so `make deploy` selects coordinated
maintenance.

Limits: Realtime's socket carries the person's token inside the socket
(`phx_join`), where Kong cannot see it, so channels stay gated by RLS alone. A
grant or revoke reaches Kong at the person's next token refresh, within one
access-token lifetime (15 minutes).

Rollout, after HQ's seed gate passes:

1. Turn on the projection (`carbon_private.authz_projection.enabled`, see
   [Permissions managed by HQ](auth/README.md#permissions-managed-by-hq)), then
   wait at least 15 minutes, one access-token lifetime, so every live token was
   issued with the claim. Kong cannot read that switch: enabling the check first
   refuses every signed-in browser request.
2. Set `AUTHZ_API_CLAIM_REQUIRED` to `"true"` and run `make deploy`. Its
   readiness check proves from the ERP container that Kong refuses a synthetic
   GoTrue-shaped token without the claim and passes one with it.
3. Verify from a tailnet device: a person without `api:supabase.storage` gets
   403 from `https://<SUPABASE_HOST>/storage/v1/`, and reaches Storage once HQ
   grants it and their session refreshes; ERP and MES pages, uploads and live
   updates still work for a person holding all four.
4. To roll back, set `AUTHZ_API_CLAIM_REQUIRED` to `"false"` and run
   `make deploy` again.

## Private-network limitations

External webhook senders cannot reach this installation. Payment, accounting,
supplier portal and similar integrations needing inbound callbacks require a
separate reviewed design. No public callback bypass is created. Google browser
OAuth works without such a bypass. Outbound email is disabled unless you supply
an optional `RESEND_API_KEY` in private secrets; that explicitly enables an
external email provider. AI, Stripe and other optional external integrations are
not configured. Thumbnail rendering and job orchestration run locally.

Two pure image-transform edge endpoints retain their upstream anonymous behavior
inside the tailnet. All other exposed edge calls require a verified Supabase JWT;
database event wake-ups use the signed deployment anon key. Direct service-role
keys remain administrative credentials and must never reach browser configuration.

## Verification

Local checks need Python 3, PyYAML in an isolated environment, Docker, and the
repository's pinned pnpm dependencies. These do not operate the developer database:

```bash
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_*.py'
python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth -p 'test_kong_authz_api.py'
bash -n contrib/deploying/gcp-tailscale/bootstrap.sh
bash -n contrib/deploying/gcp-tailscale/certificates.sh
bash -n contrib/deploying/gcp-tailscale/host-deploy.sh
git diff --check
```

See `auth/README.md` for isolated PostgreSQL and edge-policy tests. After a live
deploy, additionally verify from your own device: permitted-domain Google login
and ERP/MES access work with Tailscale on; both hosts fail with Tailscale off;
outside-domain Google accounts are rejected. VM-local health checks cannot prove
your client DNS or tailnet grants. Google OAuth configuration and the off-VPN
check require real operator credentials/devices.

References: [GCP private VM + NAT](https://docs.cloud.google.com/nat/docs/gce-example),
[IAP SSH](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding),
[Docker port binding](https://docs.docker.com/engine/network/port-publishing/),
[Cloudflare DNS-only records](https://developers.cloudflare.com/dns/proxy-status/),
[Certbot Cloudflare DNS validation](https://certbot-dns-cloudflare.readthedocs.io/en/stable/),
[Tailscale enrollment key files](https://tailscale.com/docs/reference/tailscale-cli/up).
