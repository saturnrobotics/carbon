# Company knowledge platform execution

Execution window: 2026-09-07 23:46:58 UTC through 2026-09-08 03:46:58 UTC.
Implementation branches in Carbon and the sibling Kanban repository:
`feat/company-knowledge-platform`.

The user approved narrowing this release to **manual-v1**: authorized upload,
metadata review, keyword/exact search, immutable original download, revocation and
deletion. The broader program is deferred. Implementation and local verification
are distinct from staged or production readiness. Existing unrelated invoice
changes are excluded from implementation commits. No live deployment has occurred.

## Verified implementation evidence

- Shared bounded contracts, workforce/service assertion verification, canonical
  identity resolution, host-only browser sessions, and source-owned authorization
  paths are implemented. Tests cover forged assertions, wrong audiences, revoked
  memberships, capability intersections and browser request boundaries. Real
  Google sign-in, device policy and private ingress still require staging.
- Release planning uses actual Turbo pruning/task graphs and normalized dependency
  inputs. Focused tests cover transitive changes, deleted files, catalog changes,
  configuration drift and selected-service rollout. Production package extraction
  caught and corrected missing runtime dependencies. Local runtime artifact tests
  are distinct from full Docker image builds or deployed revision verification.
- The Supabase OAuth evaluation recorded failed isolation gates for the evaluated
  token-bridging approach. Storage/Realtime and live Identity Platform integration
  were not proven. The selected architecture continues to use Google workforce
  identity with bounded server-side adapters.
- Carbon has bounded canonical read operations for item identity, receipts,
  document references and purchase status. Kanban has authenticated board-scoped
  reads and receipt-backed ticket creation. Receipt projections preserve reversal
  and missing-identity information rather than guessing.
- Private knowledge migrations, forced row security, imported/local ACL
  intersections, immutable version relationships, source epochs and current
  canonical membership checks have behavioral PostgreSQL coverage under restricted
  runtime roles. Public function execution was separately restricted so a read
  database role cannot invoke existing business mutators through PUBLIC grants.
- Immutable capture, extraction review, publication, outbox delivery, isolated
  parser jobs, Drive acquisition/access checks and exact-generation document
  downloads have implementation and focused tests. Long-document limits and the
  final complete upload-to-search workflow are still under review.
- Read routing, current source records, exact/manual resolution, bounded evidence,
  provider policy checks, hybrid retrieval and strict user-scoped answer caching
  are implemented. Generic engineering/CRM adapters now connect through the actual
  source registry and entity/search paths, with finite projections and tests.
- Durable provider reservations enforce token/spend/rate/concurrency ceilings.
  Nonbillable query/entity admission has separate durable user/company limits.
  Eight concurrent PostgreSQL admission attempts against a limit of one produced
  exactly one admission without Redis.
- Content-free telemetry and hard HTTP deadlines are wired into query/actions.
  Unknown metadata, credentials, prompts, document text and raw upstream errors
  are excluded from standard log records. Source deadlines include credential
  acquisition; query cancellation propagates into retrieval/synthesis.
- A real synthetic Redis test caught a first-connection failure; connection
  management was corrected and the initial write/read test passed. Strict cache
  policy checks also run before delivery and after revocation.
- Ticket and procurement command implementations have focused denial/idempotency
  tests. Scheduled procurement stores actor references and proposals, not IAP
  credentials, and rechecks current authorization at execution. Schedule tests
  prove due-time selection and one dispatch under a race. The schedule fixture's
  PO write is synthetic; the full canonical purchasing transaction has separate
  integration coverage and full-schema verification is still being strengthened.

## Full public database compatibility

A dedicated labelled disposable PostgreSQL container was initialized with
Supabase auth/storage schemas only. All **996 checked-in public migrations** were
then replayed, recording each successfully applied migration. The private
knowledge migration chain was applied with its standard checksum-ledger runner.
No company records were copied, and the developer database was not migrated or
rebuilt.

Against that complete isolated database:

- The standard root `generate:types` command succeeded for public/storage/GraphQL
  types. No generated public types were hand-edited.
- `db:check:datasets` passed all four datasets: satellite, robotics, precision,
  and motor. Each dataset check rolls back its synthetic writes.
- `db:check:backups` reported the public baseline manifest restorable.
- ERP/jobs typechecks after generation exposed and corrected an invalid
  supplier-payment currency field and removed temporary knowledge receipt type
  escapes. Subsequent typechecks passed.

The helper-container network was explicitly shared with the disposable database
for type generation, using a loopback-only synthetic proxy. This worked around
Docker host-loopback differences without changing the developer environment.

## Performance evidence and unresolved gates

The first isolated scale run used 100,000 logical chunks with separate lexical
and vector-profile rows, ten synthetic users and the 500-question workload.
The exact authorized lookup baseline measured p50 4.19 ms, p95 6.62 ms and p99
11.61 ms with recall 1 for its synthetic cases. These are local database timings,
not end-to-end IAP/browser latency.

The same baseline exposed lexical timeouts and vector extension permissions.
Set-based authorized retrieval corrected those failures, with parity tests against
base-table row security. The completed local benchmark used 100,000 logical chunks
(200,000 physical lexical/vector rows), ten users and 500 synthetic questions:

| Path | p50 | p95 | p99 | Errors | Recall@10 |
| --- | --- | --- | --- | --- | --- |
| Keyword first pass | 22.78 ms | 27.47 ms | 30.10 ms | 0 | 1 |
| Keyword second pass | 24.23 ms | 29.11 ms | 34.03 ms | 0 | 1 |
| Exact authorized first pass | 4.61 ms | 6.90 ms | 11.89 ms | 0 | 1 |

Evidence: `knowledge-performance-100k.json`. These are local PostgreSQL/RLS
measurements, without true operating-system cache eviction, HTTP/IAP, parsing or
model latency. They are not a cloud end-to-end latency guarantee. Vector retrieval
was measured separately and is deferred from manual-v1.

At 03:00 UTC all finalized private migrations through immutable reviewed manual
metadata were applied successfully to both the small knowledge fixture and the
fresh 996-migration public compatibility fixture. Private types were regenerated.
The production query runtime now exposes identity and read-only manual query routes
only; readiness requires no model provider. Route tests prove old provider/action
environment values cannot enable deferred endpoints.

A one-gigabyte memory-backed test database filled during overlapping scale and
compatibility work. Only disposable test data was lost. Test workloads were
separated into labelled containers with bounded WAL/checkpoint settings and a
reproducible `packages/knowledge/scripts/setup-disposable.py` setup. No unrelated
Docker images, volumes, containers or build caches were removed.

## Manual-v1 final local evidence

The complete HTTPS Playwright journey passed: **1 test in 4.4 seconds**. It drives
actual portal, worker, query and PostgreSQL/RLS paths for capture, review, publish,
search, original PDF attachment download, cross-company denial, canonical-user
revocation, confirmed removal and post-delete search/download denial. Test code
substitutes Google verification, object storage, and parser job execution; it does
not establish real Google sign-in or OCR/container behavior. Test traces and
certificates are ignored and excluded from image contexts.

Final audit corrected real restricted-role defects: publish permission no longer
implicitly requires or grants admin; metadata freezes after publication; replay
is bound to the stored source revision; tombstoning works without admin; pending
publication events cannot resurrect a deleted document or block the outbox forever.
PDF/raster uploads require matching signatures, and downloads use attachment plus
`nosniff` with another current authorization check after object retrieval.

Manual-only dependency closure and its frozen lockfile were checked independently
of deferred Carbon/auth/Kanban changes. Public types were regenerated using a
separate synthetic schema copy excluding deferred command tables; four dataset
checks passed against that manual schema. The complete public compatibility
fixture also passed the backup-restorability check. Public type generation uses
schema introspection, not hand editing.

Final counts: shared unit **112**, shared integration **124**, portal unit **22**,
query unit **23** plus query integration **3**, worker unit **27**, and browser **1**.
The final manual-only security runner passed all **9 boundaries**, including
workforce forgery, release fences, read gateways, MIME/worker limits, cache
revocation, RLS, function execution, quotas and real-role publication. CI includes
the same manual profile and HTTPS Playwright command.

Scoped typechecks and production builds passed, along with role-policy tests,
Terraform validation, 23 offline infrastructure tests, and the workflow-catalog
check. A final rerun found stale documents left by earlier failed synthetic runs;
fixture cleanup was corrected and the entire shared integration suite passed.

The manual commit is assembled separately from deferred working-tree changes.
Validation is run explicitly on that closure. The repository's automatic commit
hook would regenerate/stage a Carbon API digest from the deferred source edits,
so it is not used for this isolated commit; its relevant format/type/test/build,
type generation, dataset, backup and catalog gates were run manually. No checks
are represented as passing solely because the hook was disabled. The original foundation SQL contains four whitespace-
only lines retained to preserve its already verified migration checksum; this is
a formatting exception, not a changed migration history.

## Outstanding operational gates and deferred work

- Real Google SSO/MFA/access-level proof and direct/private ingress tests.
- Parser OCI image build and actual isolated parser execution. The local Docker
  daemon exhausted disk during image context transfer; no unrelated data was pruned.
- Live isolated deployment, no-op/rollback proof, and pilot acceptance.
- Operator-reviewed private staging configuration and a confirmed GCP target.

Drive, synthesis/vector search, voice, Kanban commands, purchasing automation,
and generic CRM/engineering integrations remain outside manual-v1. Broader
implementation work is preserved separately without claiming release readiness.
No live GCP deployment, production migration, push, or external message occurred.


## Release approach correction: local Docker validation

The user explicitly approved local Docker testing in place of a required cloud
staging environment. The plan and operations guide now use local container
integration followed by restricted production checks for cloud-only boundaries.
Previous staging references above describe the earlier proposal, not an active
requirement. No cloud staging project is needed or provisioned.

Pending local work: actual parser image build/execution, object-storage emulator
integration, complete containerized browser workflow, failure/recovery checks and
recorded verification. Existing local results do not establish these new gates.
Kanban is not a dependency. Production target and initial access still need to be
settled before deployment; neither blocks the local work.
