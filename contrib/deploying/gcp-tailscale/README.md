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
its source directly from your laptop, and builds on the GCP server. It checks that
the latest `upstream/main` has already been merged. It refuses other branches,
uncommitted changes, and non-fast-forward pushes. See [the branch workflow](WORKFLOW.md)
for feature branches and upstream updates. The existing root Makefile is only
the entry point; keep deployment changes and documentation in this directory.

`make deploy-check` validates configuration offline and makes no cloud requests.
`make deploy` calls the deployment script with `--apply` and creates billed GCP resources. Defaults are
`e2-standard-4` (4 vCPU, 16 GB memory), a 50 GB boot disk, a retained 200 GB data
disk, Cloud NAT and snapshots. Check your GCP region's costs and quotas. This is
a single server with planned downtime during updates, not a highly available
installation.

An optional private PostgreSQL listener supports another backend on a connected
GCP VPC. See [private database clients](#private-database-clients) below.

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

Use [the branch workflow](WORKFLOW.md) to create features from `saturn/main`, merge
finished features back, and merge the latest `upstream/main`. Resolve conflicts,
run the relevant verification, review privacy and licensing, then run `make deploy`.
Deployment fetches upstream to check freshness and publishes `saturn/main`;
it does not merge unreviewed upstream changes during a rollout.

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
digest in the root Dockerfile; preparation reads those reviewed references without
consulting mutable registry tags. Actual builds still require registry access.
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
changes, then update both Dockerfile defaults as appropriate. Run the image-pin
regressions and actual builds before merging. Keep these updates in regular
dependency maintenance; pinned images do not update themselves.

The Docker dependency layer installs the pruned manifests and lockfile before
application source is copied. A BuildKit package cache retains downloaded packages
when an installation really changes. CI exercises the actual Dockerfile with
synthetic workspaces: app source and unrelated-app edits must reuse the dependency
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
