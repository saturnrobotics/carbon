# Knowledge manual-v1 operations

This directory provisions and releases the `manual-v1` knowledge workload in a
dedicated production or nonproduction project. The release contains only the web,
query, ingestion, parser, schema and retention units. Drive synchronization,
vector search, generated answers, voice, commands and generic source adapters are
not part of this release. `release.py` rejects those units and rejects their
environment variables or secrets even if deferred implementation remains in the
repository.

Terraform creates the workload identities, private buckets, managed Redis,
Direct VPC egress, Secret Manager containers and immutable Artifact Registry.
It does not migrate a database, write a secret value, download a service-account
key or deploy an application revision. `terraform apply` is an operator action
after review of private `terraform.tfvars`. Keep endpoints, certificates, secret
values, IAP evidence and staging results outside tracked files.

## Database and library enrollment

Apply the public Carbon migrations first, followed by every private migration in
`packages/knowledge/migrations` through the schema job. Use separate login roles
whose only memberships are the matching NOLOGIN runtime roles:
`knowledge_read`, `knowledge_ingest`, `knowledge_review` and
`knowledge_maintenance`. The schema login is used only by the finite schema job.
Do not give the web or parser service a database credential.

Before traffic, a human administrator must review and apply an enrollment change
through the privileged source database administration path. Runtime roles cannot
create identities, sources or initial grants. The change must atomically create:

1. one active `upload` source for the company;
2. an active IAP subject binding to an existing active Carbon user and current
   company membership;
3. explicit source-level local grants for each user or managed group; and
4. a bounded `knowledge.query` request policy.

The following is a shape-only SQL template. Replace every angle-bracket value,
review the exact subject, company, source, user and rate limits, and run it as the
source database owner in one transaction. Never use email as the IAP subject and
never auto-enroll an assertion observed at runtime.

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

INSERT INTO knowledge."identityBinding" (
  id, "companyId", "createdBy", issuer, subject, "canonicalUserId", active,
  capabilities
) VALUES (
  '<identity-binding-id>', '<company-id>', '<existing-user-id>',
  'https://cloud.google.com/iap', '<iap-subject>', '<existing-user-id>', true,
  ARRAY[
    'knowledge.read',
    'knowledge.intake.capture',
    'knowledge.intake.review',
    'knowledge.intake.publish',
    'knowledge.document.download',
    'knowledge.document.delete'
  ]
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
ceilings must contain only the capabilities each receiver uses. Configure the
machine caller with `source.index.read`, the enrolled company and source only;
its caller ID and database login must match the source `providerPolicy` values.
Validate trusted-caller JSON against `callers.schema.json` before release.

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
controller stages a service without traffic, calls its configuration-aware
`/health`, promotes only a ready revision, and atomically updates the private
manifest. A failed probe restores that selected service's prior revision. Jobs are
replaced without execution.

```bash
terraform -chdir=contrib/deploying/knowledge init -backend=false
terraform -chdir=contrib/deploying/knowledge validate
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_*.py'
python3 contrib/deploying/knowledge/release.py \
  --plan contrib/deploying/knowledge/.local/release-plan.json \
  --current contrib/deploying/knowledge/.local/release-manifest.json \
  --project example-project --region us-central1
```

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

See the approved plan's “Revised release approach: local Docker validation” for
execution order. No cloud environment has been provisioned for this release.


## Local Docker workflow

Use Docker Compose v2, Corepack/pnpm, Python 3 and a Chromium installation for
Playwright. Run commands from the repository root. All fixture identities and
passwords are synthetic; these test images must never be deployed publicly.
The runner uses ports 4200, 4301, 4302 and 59910–59914 on loopback. Resolve a
port conflict without stopping an unrelated development database. The host-facing
Compose network uses a normal bridge so loopback published ports work on Docker
Desktop. The parser has only an internal network, with storage reached through
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
The stack persists its own named PostgreSQL, Redis, storage and Inngest volumes.
`local-stack.sh up` applies pending private migrations and idempotent synthetic
fixtures without resetting a developer database. Use `local-stack.sh status`,
`local-stack.sh logs ingest` and `local-stack.sh stop` to inspect or stop only
this stack. Stopping preserves its volumes.

For an explicit production architecture build, use `build-images.sh amd64`.
Production targets use their production entry points; separate `e2e` targets
supply local identity and job-transport adapters. The browser portal runs the
application through its Vite test configuration. Production entry points also
require separate runtime smoke checks; browser success alone does not establish
that production configuration is correct.

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

After a successful browser journey, run the lifecycle proof against the retained
synthetic manual, then stop task services before the isolated restore proof. The proof refuses a running writer, restores into newly named
disposable resources, then removes only its restore targets and temporary rows.
It preserves original stack volumes; restart the stack afterward.

```bash
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
