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

A separate cloud staging environment is not required. Finish the local Docker
integration gate before deploying: use disposable PostgreSQL and Redis, emulated
object storage, local job execution, and the actual parser image to exercise the
browser upload/review/publish/search/download workflow. Test revocation, deletion,
retries and recovery with synthetic fixtures. The existing browser proof still
substitutes storage and parser execution; this expanded gate is pending.

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
