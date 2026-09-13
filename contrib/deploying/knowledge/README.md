# Knowledge manual-v1 operations

This directory provisions and releases the `manual-v1` knowledge workload in a
dedicated production or nonproduction project. The release contains only the web,
query, ingestion, parser, schema and retention units. Drive synchronization,
vector search, generated answers, voice, commands and generic source adapters are
not part of this release. `release.py` rejects those units and rejects their
environment variables or secrets even if deferred implementation remains in the
repository. A Carbon ERP may optionally be registered as a live source of
records alongside the uploaded manuals — see [Live source registry](#live-source-registry-optional);
that is a `carbon` source, not one of the generic adapters, and the planner
refuses every other kind.

Terraform creates the workload identities, private buckets, managed Redis,
Direct VPC egress, Secret Manager containers, immutable Artifact Registry, the
IAP-protected `knowledge-web` service shell, the exact service-to-service invoker
grants and the private path to Carbon's PostgreSQL listener. It does not migrate
a database, write a secret value, download a service-account key or deploy an
application revision. `terraform apply` is an operator action after review of
private `terraform.tfvars`. Keep endpoints, certificates, secret values, IAP
evidence and staging results outside tracked files.

## Deploy with one command

After the one-time setup below and merging the change into `saturn/main`, run:

```bash
make deploy-knowledge
```

This deploys the six `manual-v1` workloads. It checks the clean, published
`saturn/main` revision and its successful fork and knowledge CI runs, builds
production images for `linux/amd64` from a Git archive of that exact commit,
publishes them to Artifact Registry, records their immutable digests, replaces
and executes the schema job when migrations are pending, rereads the **live**
migration ledger, and releases parser, query, ingestion, retention and web in
that order. Services must pass an HTTP `/health` startup probe on their new
revision before it can be promoted. Existing services keep their prior traffic
allocation during staging; a brand-new service has no prior revision and can
receive traffic once its first revision passes the startup probe.

Run `make deploy-knowledge-check` for the same setup/source/live-state preflight
without building, publishing, migrating or replacing workloads. It performs
read-only provider calls and writes a private local log. Neither target provisions
Terraform resources, creates secret values, enrolls users or changes IAM grants.
`make deploy` continues to deploy the ERP/MES stack separately.

### One-time setup

1. Complete the cloud foundation, private PostgreSQL/TLS connection, runtime
   secret versions, source/library configuration and identity enrollment in the
   sections below. Apply Carbon's public migrations first. Run Terraform from
   this checkout using its selected private backend; the command reads live
   `terraform output -json` and checks its project/region against the target.
2. Install Git, Docker with Buildx, Python 3.10+, Terraform, PostgreSQL's `psql`,
   Google Cloud CLI, GitHub CLI (`gh`) and curl. Authenticate `gh` and `gcloud` as
   the operator. Configure Docker's credential helper once:
   `gcloud auth configure-docker <region>-docker.pkg.dev`.
   The operator needs image publication, service/job list/read/replace/update,
   workload service-account attachment and schema-job execution permissions.
   The existing narrow deployment service account alone does not provide all
   those permissions; use the reviewed operator identity.
3. Configure a private libpq service named `knowledge-operator` in your
   `~/.pg_service.conf` (or `PGSERVICEFILE`), with a protected password file and
   `sslmode=verify-full`. It must reach the **same Carbon database** as the
   runtime secrets over your authenticated private connection. This connection
   only reads `knowledge_migrations.ledger`; migrations run as the Cloud Run
   schema job. Keep any required tunnel connected while deploying.
4. Copy the synthetic template and replace every `<placeholder>`:

   ```bash
   mkdir -p contrib/deploying/knowledge/.local
   cp contrib/deploying/knowledge/deploy.example.json contrib/deploying/knowledge/.local/deploy.json
   chmod 600 contrib/deploying/knowledge/.local/deploy.json
   ```

   Set the project, region, public source repository, image repository and runtime
   configuration once. `database_ca_secret` names a **numbered** version of the
   source database CA secret. The controller mounts it only in database workloads
   at `/var/run/secrets/knowledge-source-database/ca.crt`; each runtime database
   URL secret must use that `sslrootcert` path and `sslmode=verify-full`. Secret
   values remain in Secret Manager; JSON contains version-pinned references only.
   Caller registries are JSON-encoded strings; validate them using
   `callers:validate` as described below. Audience environment variables omitted
   from the template are supplied from Terraform outputs. All three manual-source
   settings must identify the same uploaded-document library. Images, build
   receipts and migration windows are generated by the command.

The current foundation still needs its initial IAM integration checked: the web
runtime needs permission to invoke ingestion, and ingestion needs permission to
execute the parser **with overrides**. The existing Terraform invoker edge list
omits web-to-ingestion, and its parser `roles/run.invoker` grant does not include
`run.jobs.runWithOverrides`. Those grants are first-deployment blockers for the
upload workflow; the command does not broaden permissions automatically. Do not
consider the pilot complete until real Google access, upload/parser execution,
search/download and revocation have passed against the deployed services.

For another configured target, use an isolated private directory and set
`KNOWLEDGE_DEPLOY_CONFIG=/path/to/private/deploy.json make deploy-knowledge`.
Only one operator should deploy a target at a time. The command holds a local
configuration lock; it does not coordinate independent laptops.

### Repeated releases and recovery

After a feature PR is merged and CI passes, update the clean `saturn/main`
checkout and run `make deploy-knowledge` again. Knowledge CI runs for every push
to `saturn/main`, so an unrelated merge cannot leave this required check absent.
The command never force-pushes or deploys a feature branch.

Each source revision builds all six images with Docker's layer cache. Retries
reuse verified image receipts for that same commit. Unchanged runtime digests
are not replaced, and an up-to-date schema job is not executed again. This is
not yet per-service source-change analysis across different commits.

Logs, plans, build receipts, the selected target and per-unit release progress
live beside the configuration under ignored `deploy-state/`. The command prints
its private log path; inspect or tail that file for build/provider diagnostics.
A later unit failing does not erase earlier successful releases. Rerun the same
command after fixing the cause. Failed service staging restores the previous
service template and traffic where one exists; successful schema migrations are
never reversed automatically. A failed first creation or a manual cloud edit can
require explicit recovery. Restore the existing manifest when changing laptops;
missing receipts do not authorize adopting or overwriting an existing runtime.
Back up this private state, and follow [recovery.md](recovery.md) for database
and object recovery. There is no transaction across all services and the schema. The inherited drift
guard compares recorded digest labels; it does not reconstruct every live
configuration field, so edits retaining those labels are outside that check.


## Cloud foundation

All identifiers below are synthetic. Real project IDs, bucket names, brand
names and addresses belong in ignored `.local/` files.

### State backend

`main.tf` declares a partial `gcs` backend. The bucket and the per-environment
prefix are supplied at `init`, so a tracked file never names a project and the
two environments cannot share a state object:

```bash
terraform -chdir=contrib/deploying/knowledge init \
  -backend-config="bucket=example-knowledge-terraform-state" \
  -backend-config="prefix=knowledge/nonproduction"
terraform -chdir=contrib/deploying/knowledge init -reconfigure \
  -backend-config="bucket=example-knowledge-terraform-state" \
  -backend-config="prefix=knowledge/production"
```

Keep the backend values in `contrib/deploying/knowledge/.local/backend.<environment>.hcl`
and pass `-backend-config=.local/backend.production.hcl`. The state bucket must
have object versioning and uniform bucket-level access, with write access limited
to the operators who apply. Local state files (`*.tfstate`) are ignored by Git;
never commit one. CI validates with `init -backend=false`, which needs no bucket.

### IAP client and audiences

`knowledge-web` is a Terraform-created Cloud Run service shell with
`iap_enabled = true`, the IAP service agent as its only `run.invoker`, and
`roles/iap.httpsResourceAccessor` for exactly `var.iap_workspace_group`. Its
revision template is the synthetic probe image (`var.probe_image`) and is
ignored by every later apply; the release controller owns it. The controller
copies the service-level `run.googleapis.com/iap-enabled` and `ingress`
annotations from the observed service onto each replacement, and refuses to
promote `knowledge-web` when that shell is absent or IAP is off — a promotion
cannot switch IAP off, and the foundation must be applied before the first
release.

IAP on Cloud Run uses a Google-managed OAuth client for users inside the
Workspace organization, which is the only admission this deployment allows, so
no OAuth brand or client exists in this configuration. The Terraform
`google_iap_client` and `google_iap_brand` resources are deprecated and the
provider reports that the IAP OAuth Admin API behind them stopped functioning
after July 2025, so declaring them would produce a foundation that cannot
apply; `test_infrastructure.py` fails if either reappears. A custom OAuth
client is only relevant for admitting users outside the organization, which is
not a supported configuration here. If that ever changes, the brand and client
are created manually in the console and attached through IAP settings, and
that manual step must be recorded privately with the deployment evidence.

Audiences are outputs, never typed values:

| Output key | Value | Consumed as |
|---|---|---|
| `service_audiences["knowledge-web"]` | `/projects/<number>/locations/<region>/services/knowledge-web` | `KNOWLEDGE_WEB_IAP_AUDIENCE` on web; `sourceIapAudience` in the caller registries |
| `service_audiences["knowledge-query"]` | `https://knowledge-query-<number>.<region>.run.app` | `KNOWLEDGE_QUERY_AUDIENCE` on web, `KNOWLEDGE_IDENTITY_AUDIENCE` on ingest |
| `service_audiences["knowledge-ingest"]` | `https://knowledge-ingest-<number>.<region>.run.app` | `KNOWLEDGE_WORKER_AUDIENCE` on web |
| `service_audiences["knowledge-actions"]` | `https://knowledge-actions-<number>.<region>.run.app` | reserved; the actions unit is not part of manual-v1 |

Export them privately and hand them to the controller:

```bash
terraform -chdir=contrib/deploying/knowledge output -json \
  > contrib/deploying/knowledge/.local/foundation-outputs.json
```

`release.py --foundation-outputs <file>` fills every audience variable in
`AUDIENCE_ENVIRONMENT` from `service_audiences` and rejects a plan whose own
value differs. To keep a plan's audience values instead (for example a custom
domain audience under test), pass `--override-audiences`; without either flag
the controller refuses to run, so an audience cannot drift silently between the
foundation and a release.

### Invoker grants

Cloud Run IAM is the entrance check for every internal hop; the receiver still
verifies the service token and the forwarded IAP assertion. Grants are exactly
the platform plan's §1.4 forwarding table plus the two job triggers. Each is a
`roles/run.invoker` member bound by an exact `resource.name` condition — the
receivers are controller-created, so a service-level binding cannot exist before
the first release — and `test_infrastructure.py` fails on any grant outside this
table, on any unconditioned `run.invoker`, and on `allUsers` or
`allAuthenticatedUsers` anywhere.

| Caller identity | Receiver |
|---|---|
| `knowledge-web` | `services/knowledge-query` |
| `knowledge-web` | `services/knowledge-actions` |
| `knowledge-ingest` | `services/knowledge-query` |
| `knowledge-ingest` | `jobs/knowledge-parser` |
| `knowledge-maintenance` (Cloud Scheduler) | `jobs/knowledge-retention` |
| IAP service agent | `services/knowledge-web`, `services/knowledge-probe` (service-level) |

### Private source path

Carbon's PostgreSQL listener is reachable only over VPC peering plus Direct VPC
egress, the same path Kanban uses (`../kanban/deploy/shared-database-setup.py`).
There is no Cloud NAT and no public route. Set both variables together:

```hcl
private_source_network = "projects/example-carbon/global/networks/carbon-vpc"
private_source_cidrs   = ["10.73.0.2/32"]
```

Terraform creates the peering in both directions (the second needs
`compute.networks.addPeering` in the Carbon project), an egress allow for TCP
5432 to `private_source_cidrs` for instances tagged
`knowledge-source-database-client`, and an egress deny of that destination for
everything else. `release.py` stamps that tag only on units holding a database
credential (`DATABASE_UNITS`: query, ingest, schema, retention); web and parser
can never open the listener. Carbon admits only the client subnets listed in its
own `POSTGRES_CLIENT_CIDRS`, so `var.subnet_cidr` (default `10.82.0.0/24`) must
be added there and Carbon redeployed before the first connection succeeds.

Transport security is the listener's TLS certificate. Copy only Carbon's
`ca.crt` into the `knowledge-source-database-ca` secret through an authenticated
operator connection, and build every database URL with `sslmode=verify-full`
and `sslrootcert` pointing at that CA. Every identity holding a database URL
also holds the CA; web and parser hold neither. The deployment command supplies `database_ca_secret` to each database unit;
the controller mounts that pinned secret at
`/var/run/secrets/knowledge-source-database/ca.crt`. Use that path in runtime
`sslrootcert` parameters. Never promote a URL that lacks `verify-full`.

## Database and library enrollment

Apply the public Carbon migrations first, followed by every private migration in
`packages/knowledge/migrations` through the schema job. Use separate login roles
whose only memberships are the matching NOLOGIN runtime roles:
`knowledge_read`, `knowledge_ingest`, `knowledge_review` and
`knowledge_maintenance`. The schema login is used only by the finite schema job
and by the enrollment command below. Do not give the web or parser service a
database credential.

Before traffic, a human administrator must review and apply an enrollment change
through the privileged source database administration path. Runtime roles cannot
create identities, sources or initial grants. The change must create:

1. one active `upload` source for the company;
2. an active IAP subject binding to an existing active Carbon user with current
   company membership;
3. explicit source-level local grants for each user or managed group; and
4. a bounded `knowledge.query` request policy.

### Workforce identity binding

`knowledge."identityBinding"` accepts no direct `INSERT`, `UPDATE` or `DELETE`
from any role: the runtime policies are `false`, and the only writers are
`knowledge.enroll_workforce_identity` and `knowledge.unbind_workforce_identity`,
`SECURITY DEFINER` functions owned by the NOLOGIN `knowledge_enrollment_owner`
role and executable only by `knowledge_migrate` and `service_role`. Enroll with
the operator command, connected as the schema login:

```bash
KNOWLEDGE_MIGRATION_DATABASE_URL='postgresql://<schema-login>@127.0.0.1:<port>/<database>' \
pnpm --filter @carbon/knowledge identity:enroll -- \
  --company <company-id> \
  --user-email <workspace-email> \
  --iap-subject accounts.google.com:<numeric-iap-user-id> \
  --capabilities knowledge.read,knowledge.intake.capture,knowledge.intake.review,knowledge.intake.publish,knowledge.document.download,knowledge.document.delete
```

The email is a lookup hint only: the command resolves it to the Carbon user id,
prints that id, and binds the id. Pass `--user-id <carbon-user-id>` instead when
the connection cannot read `public."user"`. The subject is printed once, on the
confirmation line, and nowhere else. A non-local database URL is refused unless
`--allow-remote` is given and the interactive confirmation is answered.

The function refuses, and writes nothing, when the subject contains `@` or does
not match `accounts.google.com:<numeric id>`; when the user does not exist, is
inactive, or has no current membership in an active company; and when the
subject is already bound to a different user for the issuer, in any company.
Re-running with identical input is a no-op; a different capability list updates
the ceiling in place and bumps the row version. `revocationVersion` is `1` on
first insert and only advances: `knowledge.unbind_workforce_identity(issuer,
subject, company)` deactivates a binding and increments it, and a later
re-enrollment keeps the advanced value. Never use email as the IAP subject and
never auto-enroll an assertion observed at runtime.

### Emergency disablement

Three things revoke a binding. Each sets it inactive and advances its
`revocationVersion`, which is part of every cached principal's `policyVersion`
and of the answer-cache policy snapshot, so a warmed cache entry is never
delivered again and the next request that presents the subject is refused.

1. The operator command, for one subject or for every binding of one user,
   connected as the schema login:

   ```bash
   KNOWLEDGE_MIGRATION_DATABASE_URL='postgresql://<schema-login>@127.0.0.1:<port>/<database>' \
   pnpm --filter @carbon/knowledge identity:revoke -- \
     --company <company-id> --iap-subject accounts.google.com:<numeric-iap-user-id>

   pnpm --filter @carbon/knowledge identity:revoke -- \
     --user-id <carbon-user-id>            # or --user-email <hint>; --company narrows it
   ```

   It prints one `revocationVersion=<n>` line per binding and nothing else
   that identifies the binding. Listing a user's bindings needs a connection
   that can `SET ROLE knowledge_migrate`; otherwise pass `--iap-subject` with
   `--company`. A non-local database URL is refused unless `--allow-remote` is
   given and the interactive confirmation is answered.
2. Deactivating the Carbon user (`public."user".active` to false) revokes every
   binding of that user in every company, through the source-owned trigger
   installed by Carbon migration `20260911211525_knowledge-identity-revocation`.
   Re-activating the user does not re-enable a binding; re-enroll explicitly.
3. Removing the user's company membership (`public."userToCompany"` row)
   revokes that user's bindings in that company only.

Permission edits need no revocation: the resolver's `permissionsVersion`
already changes with every `userPermission` write.

Propagation budget: a local revocation takes effect on the next request to
any knowledge service, with no cache flush or restart, because every delivery
re-reads the binding. Google Workspace suspension and IAP session or access
level propagation are separate systems with their own delays and are not
promised here; revoke locally first and treat the Workspace side as a second,
independent step.

The trigger function is owned by `knowledge_enrollment_owner` and returns
without touching anything while `knowledge."identityBinding"` does not exist,
so the Carbon migration applies on installs without the knowledge platform and
the triggers start working once the private enrollment migration has run,
whichever order the two are applied in.

### Source, grants and request policy

The remaining rows are a shape-only SQL template. Replace every angle-bracket
value, review the exact company, source, user and rate limits, and run it as the
source database owner in one transaction. Run it before or after the enrollment
command; the binding does not depend on the source.

```sql
BEGIN;

INSERT INTO knowledge.source (
  id, "companyId", "createdBy", kind, "externalId", "displayName",
  "ownerId", classification, "providerPolicy", status
) VALUES (
  '<manual-source-id>', '<company-id>', '<existing-user-id>', 'upload',
  '<manual-source-id>', '<friendly-library-name>', '<existing-user-id>',
  'internal',
  jsonb_build_object(
    'machineCallers', jsonb_build_array('<index-caller-id>'),
    'ingestDatabaseRoles', jsonb_build_array('<ingest-session-user>')
  ),
  'active'
);

INSERT INTO knowledge."grant" (
  id, "companyId", "createdBy", "sourceId", "subjectKind", "subjectId",
  capability, origin, "policyVersion"
) VALUES (
  '<source-grant-id>', '<company-id>', '<existing-user-id>',
  '<manual-source-id>', 'user', '<existing-user-id>', 'admin', 'local', 1
);

INSERT INTO knowledge_metering."requestPolicy" (
  "companyId", endpoint, "userPerMinute", "companyPerMinute"
) VALUES ('<company-id>', 'knowledge.query', 30, 300);

COMMIT;
```

An `admin` grant includes read, review and publish at that source. Use separate
`read`, `review` and `publish` grants when duties must be split. An upload source
uses local grants only; source-origin grants and `sourceUserBinding` are for
external sources and are not a substitute for the workforce identity binding.
There is no default request allowance: a missing `requestPolicy` row returns 429.

Use the same strict private value for all three services:

```text
KNOWLEDGE_RELEASE_PROFILE=manual-v1
KNOWLEDGE_MANUAL_SOURCE_JSON={"sourceId":"<manual-source-id>","displayName":"<friendly-library-name>"}
```

The web service account must be registered as a trusted caller of query for
`knowledge.identity` and `knowledge.query`, and of ingestion for the five
`knowledge.intake.*`/`knowledge.document.*` operations listed in the identity
capabilities above. The ingestion service account must also be registered as a
query caller for `knowledge.identity`, because ingestion resolves the forwarded
IAP subject through query without holding identity tables. Caller capability
ceilings must contain only the capabilities each receiver uses. Every caller's
`sourceIapAudience` is `service_audiences["knowledge-web"]` from the foundation
outputs. Configure the machine caller with `source.index.read`, the enrolled
company and source only; its caller ID and database login must match the source
`providerPolicy` values.

Validate every trusted-caller registry before release:

```bash
pnpm --filter @carbon/knowledge callers:validate contrib/deploying/knowledge/.local/callers.json
```

The validator parses the file with the runtime zod schema the receivers use,
checks it against `callers.schema.json`, and applies the release rules the
runtime leaves open for local fixtures: the receiver audience must be a bare
https URL, service-account subjects must be Google's numeric unique IDs (never
an email) and unique across callers, and IAP audiences must be `/projects/...`
resource paths. It prints each caller's subject, operations and audiences and
exits non-zero on any issue. `callers.example.json` is a synthetic shape
reference that the `fork-checks` workflow validates on every change; a test pins
the zod schema and the JSON Schema to the same verdicts. Real registries belong
in `.local/` or the deployment secret store, never in a tracked file.

### Required assurance

An IAP assertion proves admission, never assurance. Each caller's `assurance`
says how its requests satisfy a company's Carbon MFA requirement
(`companySettings.requireMfa`, forced on under `CONTROLLED_ENVIRONMENT`):

- `{"mode": "carbon-mfa"}` (the default when omitted): Carbon's own MFA gate
  applies. The forwarding contract carries no Carbon session, so a company that
  requires MFA denies every delegated read with `step_up_required` and the
  portal tells the user to sign in to Carbon with two-factor authentication.
  The web service renders a login link on that page when
  `KNOWLEDGE_CARBON_LOGIN_URL` (a bare https URL) is set; `release.py` does
  not accept that key yet, so until the receiver deployment wiring lands the
  page shows the instruction without a link.
- `{"mode": "workspace-equivalent", "accessLevel": "<IAP access level>"}`:
  the operator has recorded, in the decision record for the production
  verification, that Workspace 2-step verification plus that access level is
  accepted as equivalent. The verifier then requires the level in the
  assertion's `google.access_levels` and refuses the request without it; it
  never falls back to `carbon-mfa`.

There is no third mode and nothing is inferred from an email or a domain. The
delegated path never marks a Carbon session as verified. A company that does
not require MFA is unaffected by either mode.

### Live source registry (optional)

The query service reads registered live sources — today, a Carbon ERP — through
one environment value on `knowledge-query` alone:

```text
KNOWLEDGE_SOURCES_JSON={"version":1,"sources":[{"id":"<carbon-source-id>","kind":"carbon","origin":"https://<erp-host>","audience":"<erp-receiver-audience>"}]}
```

Without the value the service registers no live source: item search answers
`unavailable` so intake review can still publish a generic document, and every
question is answered from the manual library. That is the shape the release
shipped with, and it stays supported.

**Present and malformed refuses to start.** `readSourceRegistryConfiguration`
parses the value with the runtime schema at start-up, so `/health` answers
`not-configured`, the staged revision never becomes Ready, and the promotion
fails with the reason rather than the service starting with no sources — which
would present as an empty corpus rather than as a typo. `release.py` checks the
same shape first, so a malformed registry is refused before any cloud write.

Origins are bare `https://` URLs with no embedded credentials, no path, query or
fragment — the policy the transport already applies to a URL it acquires, so
configuration is not a way around it. Source IDs are unique. `kind` must be
`carbon`: kanban belongs to the deferred command surface and the generic source
adapters are not part of this release, so the planner refuses those kinds even
though the runtime schema knows them.

Each registered source also needs a `knowledge.source` row for the reading
company with `kind = 'carbon'` and `status = 'active'` — the reader's own row
policy decides which registered sources a request may reach, and a registry entry
on its own reaches nothing. The audience is Carbon's receiver audience, the same
value the change feed below uses.

Both read paths use the registry:

- `POST /v1/items` (intake review's existing-item candidates) reads Carbon's
  `resolveItems` operation.
- `POST /v1/query` reaches a registered source for the structured intents the
  router names — a part lookup, a purchase-order status, the applicable manual
  for a recently received item. **The manual library stays primary**: a question
  the router did not send to a structured capability, and a structured one no
  registered source answers, is still answered from the uploaded manuals. The
  manual source pin (`KNOWLEDGE_MANUAL_SOURCE_JSON`) confines the *document*
  index read and does not constrain the live-source path.

One limit worth knowing before registering a source for a multi-company
deployment: "the manual for the item we received" is answered by the Carbon
resolver as soon as any registry is configured, and a reading company with no
active `carbon` source row of its own gets a clarification it cannot satisfy
rather than a fallthrough to keyword search. Register the source for every
company that asks that question, or leave the registry unset.

### Carbon change feed (optional)

The ingestion worker can carry Carbon's `knowledgeSourceOutbox` into the
knowledge index. It is registered only when both sides are configured; without
either value the worker's function list and Carbon's route stay closed.

- Worker: `KNOWLEDGE_CARBON_SOURCE_JSON={"sourceId":"<carbon-source-id>","origin":"https://<erp-host>","audience":"<erp-receiver-audience>"}`.
  The companies it serves are the machine callers in
  `KNOWLEDGE_MACHINE_CALLERS_JSON` that hold `source.changes.read` for that
  source id. Pulls run every minute (`knowledge-carbon-changes`); the
  reconciliation sweep for trigger-silenced bulk reloads runs every fifteen
  minutes (`knowledge-carbon-reconcile`), one keyset page per entity type per run.
- Carbon: `KNOWLEDGE_MACHINE_CALLERS_JSON` with the same shape the worker uses
  (`audience` is Carbon's receiver audience; each caller lists the worker
  service-account subject, `companyIds`, the knowledge `sourceIds` and
  `capabilities: ["source.changes.read"]`). The feed is
  `POST /api/v1/knowledge/source-changes`, machine-only: it refuses forwarded
  employee evidence and is not an employee operation of the `$.ts` dispatch.
  The `knowledge.source` row for that source id must exist in Carbon's database
  with `kind = 'carbon'` and `status = 'active'`, and its `providerPolicy` must
  name the worker's `machineCallers` and `ingestDatabaseRoles`.

### MCP transport (disabled; not deployable yet)

MCP is an optional transport over the query and command handlers that HTTP
already exposes, and **HTTP remains the primary integration surface**. It is off
in every deployment today, and turning it on takes three deliberate changes, not
one:

1. `KNOWLEDGE_MCP_ENABLED=true` on the service (`knowledge-query` serves it at
   `POST /v1/mcp`, `knowledge-actions` at `POST /mcp`). Only the exact string
   `true` counts; `1`, `yes` and `TRUE` are off.
2. A `KNOWLEDGE_RELEASE_PROFILE` other than `manual-v1`. The approved manual
   release is read-only document retrieval and activates no deferred surface
   even when old environment values are present, so the mount answers `404`
   under it regardless of the flag.
3. An edit to `REQUIRED_ENVIRONMENT` in `release.py`, which today rejects the
   variable as deferred runtime configuration and so refuses to stage a revision
   carrying it. That refusal is deliberate: it keeps the transport out of a
   deployed service until an intended client has passed authentication and the
   permission-parity gates below.

Do not make those changes until, on the real services:

- an intended MCP client authenticates with the ordinary machine pair —
  `Authorization: Bearer <receiver-audience service-account ID token>` plus
  `X-Portal-User-Evidence` and `X-Portal-Company-Id` headers. A browser IAP
  session **cookie is not an MCP authentication protocol**: cookies are never
  read as a credential and never forwarded, so a client holding only a browser
  session is refused; and
- `pnpm --filter @carbon/knowledge test mcp-parity` passes, which is what proves
  MCP exposes no operation and no data beyond HTTP for the same actor and
  caller. Every tool delegates to the service's own HTTP route — same identity
  verification, caller authorization, budgets, rate limits and idempotency key —
  and a tool whose path the service does not mount is neither listed nor
  callable.

The reviewed surface is `MCP_TOOLS` in `packages/knowledge/src/mcp/surface.ts`:
`knowledge_query`, `knowledge_get_source_entity` and `knowledge_create_ticket`.
The generated ERP tool catalog is a different, unrelated surface and is never
exposed here.

## Google Drive enrollment (deferred connector)

Drive synchronization is not part of `manual-v1`; `release.py` still rejects its
environment. The connector exists in the repository behind an explicit
enrollment so that a later release can enable it without a schema change.
Enrolling a Shared Drive or a set of folders is the same privileged
administrator action as enrolling the upload library. It never happens from
the portal, and signing into the portal never authorizes Drive access.

An enrollment records, in one transaction:

1. one active `drive` source whose `externalId` is the Drive scope identity,
   with the machine caller and ingest login that may synchronize it;
2. one `knowledge."driveEnrollment"` row naming the corpus (`drive` with a
   shared-drive id, or `user` with at least one root folder), the read-only
   connector scope (`drive.readonly` is the only value the table accepts), the
   Secret Manager **reference** of the OAuth refresh credential (never its
   value), the minimum scope the reader-delegated live check uses
   (`drive.metadata.readonly` by default), and `domainWideDelegation = false`
   (the worker refuses to sync an enrollment that sets it);
3. a `sourceUserBinding` for every employee whose Drive identity is known, so
   file permissions can be mapped to a canonical user (an unbound Drive
   principal receives no grant);
4. explicit local grants that admit employees to the source. A source-scoped
   local grant is required for a reader to see the source at all; the
   connector's per-file source grants are intersected with it, and a
   source-scoped **source** grant (the shared-drive membership the
   administrator vouches for) is what lets a reader list the source under
   Settings. The connector itself writes only file-level source grants and
   never broadens access.

```sql
BEGIN;

INSERT INTO knowledge.source (
  id, "companyId", "createdBy", kind, "externalId", "displayName",
  "ownerId", classification, "providerPolicy", status
) VALUES (
  '<drive-source-id>', '<company-id>', '<existing-user-id>', 'drive',
  '<shared-drive-id>', '<friendly-drive-name>', '<existing-user-id>',
  'source-restricted',
  jsonb_build_object(
    'machineCallers', jsonb_build_array('<drive-sync-caller-id>'),
    'ingestDatabaseRoles', jsonb_build_array('<ingest-session-user>'),
    'allowedProviders', jsonb_build_array(),
    'allowedClassifications', jsonb_build_array()
  ),
  'active'
);

INSERT INTO knowledge."driveEnrollment" (
  "companyId", "createdBy", "sourceId", corpora, "driveId", "rootFolderIds",
  "oauthScope", "credentialSecretRef", "userAccessScope",
  "notificationChannelId", "notificationTokenHash", "reconcileAfterHours"
) VALUES (
  '<company-id>', '<existing-user-id>', '<drive-source-id>', 'drive',
  '<shared-drive-id>', ARRAY['<folder-id>']::text[],
  'https://www.googleapis.com/auth/drive.readonly',
  'projects/<project>/secrets/<secret>/versions/<n>',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  '<channel-id>', encode(sha256('<channel-token>'::bytea), 'hex'), 24
);

INSERT INTO knowledge."sourceUserBinding" (
  id, "companyId", "createdBy", "sourceId", "canonicalUserId", "sourceUserId", active
) VALUES (
  '<binding-id>', '<company-id>', '<existing-user-id>', '<drive-source-id>',
  '<existing-user-id>', '<employee@example.com>', true
);

INSERT INTO knowledge."grant" (
  id, "companyId", "createdBy", "sourceId", "subjectKind", "subjectId",
  capability, origin, "policyVersion"
) VALUES
  ('<local-grant-id>', '<company-id>', '<existing-user-id>', '<drive-source-id>',
   'user', '<existing-user-id>', 'read', 'local', 1),
  ('<member-grant-id>', '<company-id>', '<existing-user-id>', '<drive-source-id>',
   'user', '<existing-user-id>', 'read', 'source', 1);

COMMIT;
```

The worker synchronizes an enrolled source only when both
`KNOWLEDGE_DRIVE_TOKEN_BROKER_URL` and `KNOWLEDGE_DRIVE_TOKEN_BROKER_AUDIENCE`
are set and its machine caller configuration lists the source with
`source.changes.read`. The broker exchanges the Secret Manager reference for a
short-lived connector token (`kind: "connector"`) and, for the live check that
runs before any restricted Drive text is delivered, cached or disclosed to a
provider, a token delegated by the reader (`kind: "user"`) — without one the
document is not delivered. Push notifications are registered with the
enrollment's channel id and token and addressed to
`/v1/drive/<source-id>/notifications?company=<company-id>`; a valid hint only
schedules the cursor-based sync that the five-minute cron runs anyway. A
reader's ingestion caller must also be allowed the `knowledge.read` operation
so the query service can perform the live check.

## Runtime requirements

`release.py` requires the exact environment and pinned-secret sets declared in
`REQUIRED_ENVIRONMENT` and `REQUIRED_SECRETS`. It rejects missing fields, extra
deferred provider fields, mutable image tags, `latest` secret versions, stale
manifest generations and observed configuration drift. Web and parser receive no
secrets. Query receives only the read database and Redis secrets. Ingestion
receives separate read, review and ingest database secrets plus the Inngest
signing key. Retention receives its maintenance database secret.

The ingestion identity can create and read immutable objects. The parser can read
captured generations and create extraction outputs, and has no database or Secret
Manager access. Its image contains `/usr/bin/pdftotext` and `/usr/bin/tesseract`.
Retention alone can delete the exact expired object generations selected by the
bounded database function. Ingestion must have permission to run the configured
parser job and inspect that job's operation. Every unit uses Direct VPC egress;
the parser keeps private Google API access while external internet egress is
denied by the deployment network policy.

Build each selected image, record its actual OCI digest and matching source commit
in the private release plan, then dry-run the controller. With `--apply`, the
controller preserves existing service traffic while staging, uses the new
revision's configuration-aware HTTP `/health` startup probe, promotes that exact
ready revision, and atomically records successful per-unit progress. Failed
staging restores the prior service template and traffic where one exists. A
first service creation becomes routable after its startup probe succeeds. The
low-level controller replaces jobs without execution; `make deploy-knowledge`
additionally executes pending schema migrations and rechecks the live ledger.

```bash
terraform -chdir=contrib/deploying/knowledge init -backend=false
terraform -chdir=contrib/deploying/knowledge validate
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_*.py'
python3 contrib/deploying/knowledge/release.py \
  --plan contrib/deploying/knowledge/.local/release-plan.json \
  --current contrib/deploying/knowledge/.local/release-manifest.json \
  --foundation-outputs contrib/deploying/knowledge/.local/foundation-outputs.json \
  --schema-ledger contrib/deploying/knowledge/.local/schema-ledger.json \
  --project example-project --region us-central1
```

### Compatible migration window

Every unit holding a database credential (`DATABASE_UNITS`: query, ingest,
schema, retention) declares in its plan entry the knowledge migrations its build
was verified against, as bare migration names (`<14-digit timestamp>_<slug>`,
the file name without `.sql`):

```json
"migrations": {
  "minimum": "20260908000245_knowledge-foundation",
  "maximum": "20260908050421_ingest-source-visibility-execute"
}
```

Migrations apply in name order, so the window compares as strings. Before
promoting such a unit the controller needs the deployed ledger head and refuses
a unit whose window does not contain it: below `minimum` means the schema job
must run first, above `maximum` means the build predates the schema and a
verified build must be selected instead. A ledger with no applied migration
admits only `knowledge-schema`. Web and parser hold no credential and must not
declare a window. The window is recorded next to the revision in the private
manifest.

Carbon's listener is reachable only over the private path, so the controller
does not read the ledger itself. Export it through the same authenticated
operator connection used for the CA copy, verbatim (the runner records file
names with their `.sql` suffix, which the controller normalizes):

```bash
psql "$KNOWLEDGE_OPERATOR_DATABASE_URL" -X -At -c \
  "SELECT json_build_object('schema_version', 1, 'names', coalesce(json_agg(name ORDER BY name), '[]'::json)) FROM knowledge_migrations.ledger" \
  > contrib/deploying/knowledge/.local/schema-ledger.json
```

Additive changes keep the previous build inside the new window, so query and
ingestion can straddle a schema release; a destructive contraction is a later
explicit maintenance release that narrows `minimum`.

## Release validation: local first

The active implementation goal ends after local validation. Production steps
below describe later operations and are not authorized work for this goal.

A separate cloud staging environment is not required. Finish the local Docker
integration gate before deploying: use disposable PostgreSQL and Redis, emulated
object storage, local job execution, and the actual parser image to exercise the
browser upload/review/publish/search/download workflow. Test revocation, deletion,
retries and recovery with synthetic fixtures. The Docker browser gate uses actual
PDF extraction, immutable object storage in the emulator, PostgreSQL RLS, Redis
and Inngest retries. Synthetic Google identity and parser-job transport are
confined to separate test image targets.

Local identity fixtures and emulators do not prove Google IAP, MFA/access levels,
Cloud Run IAM, private network routes, real GCS generation/permission behavior or
Cloud Run rollout. Verify those on the actual production deployment with initial
access restricted to the designated tester and synthetic documents only. Record
allowed/denied browser access, alternate-origin and service-audience denial,
parser execution, upload-to-search freshness, exact-version download, revocation,
deletion, health-gated promotion and rollback before broader use. Follow
`recovery.md` for retention and an isolated restore proof. Keep evidence private.

Before any release, run `callers:validate` (see "Database and library
enrollment") on each receiver's `KNOWLEDGE_TRUSTED_CALLERS_JSON` value and keep
the output with the private release evidence.

See the approved plan's “Revised release approach: local Docker validation” for
execution order. No cloud environment has been provisioned for this release.


## Local Docker workflow

Use Docker Compose v2, Corepack/pnpm, Python 3 and a Chromium installation for
Playwright. Run commands from the repository root. All fixture identities and
passwords are synthetic; these test images must never be deployed publicly.
The runner publishes ports 4200, 4301, 4302, 4303, 4304, 59910, 59911, 59912
and 59914 on loopback.
Resolve a port conflict without stopping an unrelated development database: every
published port, the Compose project name and the image tag are environment
variables that default to those values, so a second stack can run beside a
long-lived one without retagging or stopping it (see "Running a second stack"
below). The host-facing Compose network uses a normal bridge so loopback
published ports work on Docker Desktop. The parser has only an internal network, with storage reached through
the test proxy. Local bridge networking does not prove production egress policy.

```bash
corepack pnpm install --frozen-lockfile
contrib/deploying/knowledge/build-images.sh native
contrib/deploying/knowledge/build-images.sh e2e
corepack pnpm --filter knowledge exec playwright install chromium
KNOWLEDGE_E2E_PRESERVE_FIXTURE=1 contrib/deploying/knowledge/local-stack.sh test
```

The preserve flag retains the synthetic published manual and tombstone for
subsequent performance and recovery checks. Omit it for normal test cleanup.
After the full browser suite, the runner checks the database for the requested
final state: uploaded originals and tombstones must remain with preservation
enabled, and this run's captured intake/document rows must be absent otherwise.
The runner snapshots pre-existing fixture IDs first, so earlier explicitly
retained runs are allowed and cannot satisfy the new run's preservation check.
Seeded manuals alone cannot satisfy it either.
The stack persists its own named PostgreSQL, Redis, storage and Inngest volumes.
`local-stack.sh up` applies pending private migrations and idempotent synthetic
fixtures without resetting a developer database. Use `local-stack.sh status`,
`local-stack.sh logs ingest` and `local-stack.sh stop` to inspect or stop only
this stack. Stopping preserves its volumes.

`local-stack.sh down` removes this stack's containers and its named volumes.

### Running a second stack

Set a distinct stack name, image tag and published ports; unset variables keep
the defaults above, so an unparameterised invocation is unchanged.
`KNOWLEDGE_LOCAL_STACK` is one name doing two jobs — the Compose project name and
the prefix of every image `build-images.sh` tags — so the build and the stack
cannot disagree about which images belong to which stack. Export the variables
before `build-images.sh`, not only before `local-stack.sh`: the compose file
resolves the image names from the same two variables the build tagged them with,
and a stack started without them looks for the default images.

```bash
export KNOWLEDGE_LOCAL_STACK=knowledge-mine KNOWLEDGE_LOCAL_TAG=mine-v1
export KNOWLEDGE_LOCAL_PORTAL_PORT=4270 KNOWLEDGE_LOCAL_GATEWAY_PORT=4371
export KNOWLEDGE_LOCAL_QUERY_PORT=4372 KNOWLEDGE_LOCAL_DRIVE_GATEWAY_PORT=4373
export KNOWLEDGE_LOCAL_DRIVE_QUERY_PORT=4374 KNOWLEDGE_LOCAL_DATABASE_PORT=59970
export KNOWLEDGE_LOCAL_REDIS_PORT=59971 KNOWLEDGE_LOCAL_STORAGE_PORT=59972
export KNOWLEDGE_LOCAL_INNGEST_PORT=59974
contrib/deploying/knowledge/build-images.sh e2e
contrib/deploying/knowledge/local-stack.sh test
contrib/deploying/knowledge/local-stack.sh down
```

`test_local_stack_docs.py` pins the names in this section against the ones
`local-stack.sh`, `build-images.sh` and `compose.local.yaml` actually read, so a
renamed variable fails a check rather than silently starting the default stack on
the default ports beside the one it was meant to avoid.

`verify-local-recovery.py` uses the same `KNOWLEDGE_LOCAL_STACK` selection and
checks the containers' project/service ownership and their actual storage volume
before starting or copying anything. Keep the exported stack variables set for
the stop, recovery and restart commands below. `local-performance.py` takes the
selected query URL explicitly. `verify-local-lifecycle.sh` still names the default
project and `manual-v1` tag directly; do not run it against a second stack.

### The deferred Drive surface in the harness

`drive-source.spec.ts` exercises the Drive connector, which `manual-v1` defers.
Two pieces make that possible without touching the release fence:

- The route manifest is a BUILD-time artifact, so `build-images.sh e2e` passes
  `--build-arg KNOWLEDGE_DRIVE_ENABLED=true` to `Dockerfile.web`'s `e2e` stage
  only. The release `runtime` stage descends from `builder`, which never receives
  the argument, so passing it to a release build changes nothing;
  `test_images.py` pins that and `release.py` separately refuses the variable on
  a deployed revision.
- The `drive` Compose service runs the loopback Drive fixture (an in-memory
  Drive, no Google credential) on its own two ports, because the manual
  library's query fixture is pinned to the upload source and can never answer
  for a Drive one. The manual gateway forwards `/v1/drive/*` there, so the
  portal keeps a single worker URL as it does in production.

For an explicit production architecture build, use `build-images.sh amd64`.
Production targets use their production entry points; separate `e2e` targets
supply local identity and job-transport adapters. The browser portal runs the
application through its Vite test configuration. Production entry points also
require separate runtime smoke checks; browser success alone does not establish
that production configuration is correct.

### Base images and the license boundary

Every `Dockerfile.*` builds from `${NODE_IMAGE}`, whose default is the reviewed
multi-platform digest recorded once in `base-images.json`;
`test_base_image_pins.py` fails on a floating tag, an unreviewed `FROM`, or a
Dockerfile whose default drifts from the record. Refresh the pin by updating the
record and every Dockerfile default together (`docker buildx imagetools inspect
node:22-alpine` reports the current index digest); the build scripts pass no
override.

Carbon's LICENSE reserves commercial terms for `packages/ee` and files with
`.ee` in their names. `verify-license-boundary.py` walks the workspace closure
each Dockerfile prunes and refuses the enterprise package anywhere in the build
closure or a `.ee.` file in what `pnpm deploy --prod` ships, and requires the
shipped `runtime`/`e2e` stages to copy `LICENSE` (and `NOTICE` when one exists)
beside the code. With `--image` it inspects a built image through
`docker export` without running it. CI runs the static check with the
foundation tests and the image check against the six production images.

```bash
python3 contrib/deploying/knowledge/verify-license-boundary.py
python3 contrib/deploying/knowledge/verify-license-boundary.py \
  --image knowledge-manual-local-query:manual-v1
```

Verify private build-context exclusions and run the parser proof independently
of the browser stack:

```bash
python3 contrib/deploying/knowledge/verify-build-context.py
python3 contrib/deploying/knowledge/verify-parser-container.py
KNOWLEDGE_PARSER_TEST_IMAGE=knowledge-manual-local-parser:manual-v1-amd64 \
  python3 contrib/deploying/knowledge/verify-parser-container.py
```

This invokes the production parser command for a text PDF and raster OCR image,
checks extracted identifiers, checks duplicate output generation stability and
rejects a nonexistent input generation. The test-only storage proxy adapts the
SDK metadata URL path to the emulator; it does not synthesize object bytes,
generations or extraction results.

Set `KNOWLEDGE_E2E_PRESERVE_FIXTURE=1` when running the browser journey to retain
its synthetic manual for the proofs below. On the default stack only, the lifecycle proof
can run first. For either stack selection, stop task services before the isolated
restore proof. The proof refuses a running writer, restores into newly named
disposable resources, then removes only its restore targets and temporary rows.
It preserves original stack volumes; restart the stack afterward.

```bash
# Default stack only; omit this line for a separately named stack:
contrib/deploying/knowledge/verify-local-lifecycle.sh
contrib/deploying/knowledge/local-stack.sh stop
python3 contrib/deploying/knowledge/verify-local-recovery.py --synthetic --disposable
contrib/deploying/knowledge/local-stack.sh up
```

The lifecycle proof restarts storage/database and application/background services,
checks unchanged container IDs and exact downloads, then builds a portal image
with a new proof label and updates only that service with `--no-deps`. It verifies
a changed portal image/container and unchanged IDs for every other service. This
proves local update isolation, not a business behavior change or cloud rollout.
The original image tag is restored afterward; the updated test container remains
until the next `local-stack.sh up` reconciles it.

The restore compares immutable object generations and SHA-256 hashes, database
references, tombstones, RLS search results, roles, ownership, policies and ACLs.
Emulator object metadata uses filesystem extended attributes: a plain tar backup
is insufficient. The proof preserves these attributes using GNU tar. This is a
local database/object recovery drill, not a production GCS backup procedure.

Measure the direct query service using an exact part number from the latest
published synthetic manual:

```bash
python3 contrib/deploying/knowledge/local-performance.py --synthetic \
  --url http://127.0.0.1:4302/v1/query --text '<published synthetic part number>' \
  --requests 100 --concurrency 4
```

This reports HTTP latency and throughput with real PostgreSQL and Redis. A small
synthetic corpus and emulated authentication cannot establish production scale,
Google authentication latency or cloud network performance. The first request is
not asserted to be a cold-cache measurement.
