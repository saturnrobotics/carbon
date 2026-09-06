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
Deployment fetches upstream to check freshness and publishes `saturn/main`; it
does not merge unreviewed upstream changes during a rollout.

The script builds the candidate release before stopping the existing stack. It
then stops all Carbon containers and Docker, takes a **consistent pre-deployment
snapshot**, restarts Docker, applies pending migrations using the dedicated ops
image, installs the private auth policy and seeds only required system lookups.
It never resets the database, imports demo companies or repairs migration history.
Application/database credentials are reused. Supplied Google credentials are
updated on deployment; generated database/JWT/session credentials are not rotated
implicitly.

All durable state is under `/var/lib/carbon` on the retained data disk, including
Docker volumes, database, uploaded files, Inngest state, secrets, certificates,
Tailscale identity and release archives. Root-only parent directories protect
these files; secrets mounted into differently privileged containers use readable
individual files inside those protected directories. Docker administrators can
access runtime secrets and must be trusted.

A daily disk snapshot schedule retains 14 days; daily snapshots of the running
stack are **crash-consistent**, not coordinated database/storage checkpoints.
Pre-deployment snapshots are retained until you deliberately remove them. Neither
images nor old source releases are pruned automatically. Monitor disk space,
certificate renewals, snapshots and costs. The VM and data disk have deletion
protection/retention; the script provides no destructive uninstall command.

If a deployment fails after migration starts, it reports failure rather than
automatically running old code against a changed schema. Inspect private VM logs
through `gcloud compute ssh ... --tunnel-through-iap`. The active and previous
Compose descriptions are in `/var/lib/carbon/runtime/`; release files referenced
by those descriptions remain in `/var/lib/carbon/prepared/` and `releases/`.
Resume a fixed release with the normal deploy command. If rollback is required,
stop the VM, restore the **whole** pre-deployment data snapshot to a new retained
disk, attach it as `carbon-data`, and boot the matching source release. Restore
database, files and secrets together; do not downgrade the schema by rerunning
old migrations. Never run the old and recovered Tailscale identities concurrently.
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
