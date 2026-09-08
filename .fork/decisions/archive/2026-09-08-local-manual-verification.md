# Manual-v1 local verification

Date: 2026-09-08. All seven local acceptance steps passed on the isolated
`feat/knowledge-local-docker` branch, based on the approved manual release.
Only synthetic data and task-owned Docker resources were used. No developer
database was reset and no cloud resources were provisioned or deployed.

## Acceptance evidence

| Requirement | Verified result |
| --- | --- |
| Production images | All six units built for arm64 and amd64; production default commands exercised and runtime bundles checked for test adapters. |
| Actual extraction | Both final parser images extracted the expected PDF identifier and OCR identifier from a raster image; duplicate output generations stayed unchanged and nonexistent input generations were rejected. |
| Local stack | Portal, query, ingestion, PostgreSQL, Redis, fake GCS, parser and Inngest ran in Docker with persistent task-owned volumes. |
| Complete workflow | Lead browser rerun passed 1/1: upload, actual extraction, review, publication, search and byte-for-byte original download. Test 8.5 seconds; suite 8.9 seconds. |
| Security and reliability | Real-role SQL, query/Redis integration and browser checks passed for company isolation, revocation, removal, duplicate prevention and durable Inngest retry after an injected processing failure. |
| Lifecycle and restore | Lead independently reran service restarts, portal-only image update and isolated database/object restore. All passed. |
| Checks and performance | Scoped tests/typechecks, infrastructure checks, build-context/endpoint guards and local query latency measurement passed. |

## Automated checks

- Knowledge unit: 25 files, 112 tests.
- Query unit: 7 files, 23 tests.
- Worker unit: 13 files, 27 tests.
- Portal unit: 9 files, 22 tests.
- Shared integration configuration: 33 files, 124 tests. The merged configuration
  includes the shared unit tests as well as eight integration files; these counts
  are not additive with the unit count above.
- Query integration: two files, four tests, including actual Redis cache hits,
  canonical user revocation, document-grant revocation and company denial.
- Security aggregate: all nine attacks passed. Component counts: A01 26, A02 1,
  A03 9, A04 7, A05 5, A06 20, A07 4, A08 3, A09 1.
- Additional SQL checks: budgets 7, epochs 3, machine budgets 3, retention 3.
- Python deployment/infrastructure suite: 33 tests.
- Direct typechecks passed for all four knowledge packages; changed TypeScript
  passed Biome. ShellCheck, shell/Node/Python syntax, Compose configuration,
  workflow YAML and diff whitespace checks passed.

Commit validation ran these scoped gates directly; Husky was not initialized
in the isolated checkout. Public Carbon schema and locale files did not change,
so public schema/dataset and translation generation gates were not applicable.
The owning knowledge package generated its private types after the migration.

Database checks used the labelled disposable PostgreSQL fixture on loopback
59920 and Redis on 59923. They used the guarded synthetic migrator URL and
`KNOWLEDGE_TEST_DATABASE_DISPOSABLE=1`. Browser tests used the separate labelled
Compose database on 59910 and Redis on 59911.

Principal package commands, with the disposable test environment configured:

```bash
corepack pnpm --filter @carbon/config run build
corepack pnpm --filter @carbon/knowledge run test
corepack pnpm --filter knowledge-query run test
corepack pnpm --filter knowledge-worker run test
corepack pnpm --filter knowledge run test
corepack pnpm --filter @carbon/knowledge run typecheck
corepack pnpm --filter knowledge-query run typecheck
corepack pnpm --filter knowledge-worker run typecheck
corepack pnpm --filter knowledge run typecheck
corepack pnpm --filter @carbon/knowledge run test:integration
corepack pnpm --filter knowledge-query exec vitest run --config vitest.integration.config.ts
corepack pnpm --filter @carbon/knowledge run verify:security
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_*.py'
```

Full build, browser, parser, lifecycle, recovery and benchmark commands are in
`contrib/deploying/knowledge/README.md`. CI now invokes the actual Docker browser
workflow and includes the new query security and private-context checks.
Remote CI was not triggered as part of this local task.

## Runtime images

Final amd64 web/query/ingest default commands started in uniquely labelled,
loopback-only containers and returned their expected unconfigured HTTP 503
health responses. The schema default command returned `unchanged: true` against
the disposable migration database. The retention default command exited 0 with
zero candidates using a login restricted to the maintenance role. That finite-job
smoke does not claim a physical-retention deletion occurred.

Both final parser default commands passed real PDF/OCR execution. Expected text
was `PDF MANUAL ALPHA 4827` and `IMAGE MANUAL BRAVO 7391`. Production runtime
build/dist scans found no E2E gateway, synthetic identity or E2E route markers.
Separate E2E image targets supply the local identity and parser-job transport.

These are inspected local Docker image IDs, not registry manifest digests:

| Unit | Architecture | Local image ID |
| --- | --- | --- |
| web | arm64 | `sha256:1e8b5d88110cdd9c8624c14635af1633a70aff9774078220dc55c028766ed528` |
| query | arm64 | `sha256:9e7ab3293c9b476a106dce65b45374ae27e76378cfe7e80592075b80260c2efd` |
| ingest | arm64 | `sha256:6dc597f05e84de4b0a61e391d662e565978ead1a3b4400518d6dfb5c5955e29c` |
| parser | arm64 | `sha256:88d68dc593a38ba916e2f5c3b89b71f38c36f59d49cdee13311707888f06103f` |
| schema | arm64 | `sha256:be9b09ff8f051414cb0daa07751b45a1cd913ff0f0c9440658d092b9f7a822e8` |
| retention | arm64 | `sha256:891c0371a61a8e77cff89800a0d5ba9125260456d100cc0d5e8ff8b875c2ab2f` |
| web | amd64 | `sha256:10dbfcf7baf2d3f2c6849ebc1e19e581b2f18bc28c31ac417bdf3195486b64e3` |
| query | amd64 | `sha256:017f35fd4ee91c2a0a3a2a8ed17a9b5bb96b0dccc14fff1a2f6e2a515e1abdca` |
| ingest | amd64 | `sha256:431e581589b450d0bbbe46a38af2a0f22c9cd35835b8155484c76d4da68341ec` |
| parser | amd64 | `sha256:8001eb9c77e8c29ad92937e52b8b59156391f7e6a62ed165ea01c828d3fe5e83` |
| schema | amd64 | `sha256:54cc9322dca315ad4be2d30bcfefaaacff84c22068b25ccfcb47758063b734ef` |
| retention | amd64 | `sha256:615ceb13c29f177797557c34141e862ea7b926bbeaeea95171921b17b7855430` |

## Performance

Final lead query benchmark after the lifecycle/restore checks: 100 requests,
concurrency 4, zero errors, p50 **23.443 ms**, p95 **27.406 ms**, p99 **34.819 ms**,
throughput **165.641 requests/second**. The first successful request took
85.036 ms; it is not asserted to be a cold-cache measurement.

A recorded guarded browser run measured upload through extracted review at
3235.799 ms and publication through visible search at 249.077 ms. It included
an injected processing failure and actual Inngest retry before parser success.
The lead subsequently reran the complete browser workflow successfully.

This is a small synthetic corpus on the local machine. Query measurements
include the synthetic identity boundary, real PostgreSQL/RLS and real Redis;
they exclude Google authentication and cloud network latency.

## Service lifecycle and restore

The lead ran `verify-local-lifecycle.sh` successfully. PostgreSQL/storage
restarts, followed by Redis and every application/background service restart,
retained all nine container IDs. Pending outbox count returned zero, authorized
search worked, and the portal downloaded the exact original bytes/generation.
This is an idle-service restart proof, not a claim about every possible in-flight
crash boundary.

A new portal image with a unique proof label was deployed with
`compose up -d --no-deps portal`. Only the portal image/container changed;
all eight other container IDs stayed unchanged. The original image tag was
restored. This proves local update isolation, not a business behavior change or
Cloud Run rollout.

- Base portal test image: `sha256:ea2d733fbf8e85644777259e48bc685bc2e322776880988ae9c7fa736351fef0`.
- Lead updated test image: `sha256:2c99f65caef6ee0e82a2cb8b8d019f48de43a9ffad36fb0deb5332081b5418c4`.

After stopping the stack, the lead independently ran
`python3 contrib/deploying/knowledge/verify-local-recovery.py --synthetic --disposable`.
It restored into a new empty database and separate object volume. **31 objects,
14,363 bytes** matched exact generation, SHA-256, size and content type.
Database owners, roles/memberships, RLS flags, policies, ACLs, tombstones and
role-scoped lexical search results matched. The linked real original retained
generation `1788846357186334` and SHA-256
`3d896f95295c8c65bebffbce6d18b3354f282c3afa53563a573525f86f938ba8`.
Temporary restore resources were removed; original task volumes were preserved.
The local stack was started again after this proof.

The restore preserves the backed-up database/index. It does not claim to rebuild
a lost index from original files; the separate bounded rebuild-candidate tests
only prove candidate forwarding and failure propagation.

## Defects resolved and review boundaries

- Real ingestion exposed a missing EXECUTE privilege on a helper referenced by
  its RLS policy. A narrow append-only private migration fixes it, with a real-role
  regression rejecting unassigned callers and companies. Generated private types
  remained unchanged.
- Schema image startup exposed a CommonJS driver bundled incompatibly with ESM;
  keeping `pg` external fixed the actual default-command failure.
- The emulator image's baked `-data` entrypoint reimported persisted files and
  changed generations. Explicit entrypoint overrides remove seed reimport, while
  live-argument guards catch recurrence. GNU tar preserves the emulator metadata
  extended attributes during object-volume backup/restore.
- Fresh restore targets use an empty template0 database, avoiding collisions with
  the image's preinstalled extensions. TCP readiness avoids the temporary Unix
  initialization server.
- A late Docker context allow-list overrode private-path exclusions. A real
  synthetic COPY probe failed before the fix and passed afterward. The verifier
  checks local, environment, secret and Terraform-state exclusions.
- Endpoint guards now reject external browser, gateway and query origins before
  fixture actions. Database fixture checks require matching loopback bindings.

Self-review found no remaining must-fix issue within the seven-step scope.
Production and test entrypoints remain separate; no production authentication
bypass was added. The parser metadata-path proxy only adapts the SDK/emulator URL
shape and does not synthesize extraction output, generations or object bytes.
Local bridge networks and synthetic Google assertions do not establish Google
sign-in, real GCP IAM/GCS permissions, cloud networking or deployment readiness.
Production enrollment/deployment and all deferred integrations remain out of scope.

Endpoint rejection probes (each exits 1 before external network access):

```bash
KNOWLEDGE_E2E_GATEWAY_URL=https://example.com corepack pnpm exec tsx -e \
  '(async()=>{const setup=await import("./apps/knowledge/tests/setup.ts"); await setup.default()})()'
KNOWLEDGE_E2E_QUERY_FIXTURE_URL=https://example.com corepack pnpm exec tsx -e \
  '(async()=>{const setup=await import("./apps/knowledge/tests/setup.ts"); await setup.default()})()'
KNOWLEDGE_E2E_BASE_URL=https://example.com \
  corepack pnpm --filter knowledge exec playwright test --list
```
