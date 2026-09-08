# Company knowledge platform — execution plan

**Date:** 2026-09-07

**Status:** Planned; implementation and deployment have not started.

**Design baseline:** The requirements, decisions, contracts, and acceptance criteria in this document.

**Repositories:** Carbon at the repository root; the independent task-board application at ../kanban.

**Suggested implementation branch:** feat/company-knowledge-platform, split into the independently reviewable tasks below.

This plan covers a fast, mostly read-only natural-language interface to operational
records and documents, streamlined knowledge intake, Google workforce login, scoped
voice commands, and independently deployable services. It includes future Drive,
engineering, PCB, CRM, and purchasing integrations without treating those future
applications as already implemented.

All examples are synthetic. Actual domains, project IDs, user/group identifiers,
source inventories, credentials, deployment manifests, evaluation transcripts,
and production evidence stay outside tracked files. Carbon deployment inputs and
private evidence use contrib/deploying/gcp-tailscale/.local/; credentials use the
deployment secret store. Do not copy private company documents into the committed
Carbon product-doc corpus.

The user explicitly requested research-backed decisions and a plan, without another
design interview. Recommendations below are engineering decisions, not assertions
that live infrastructure has been inspected or configured. Existing unrelated
working-tree changes must be preserved.

## 1. Selected architecture

### 1.1 GCP organization and project boundaries

Google's canonical guidance is to choose projects around trust, ownership,
environment policies, and administrative boundaries. There is no universal
one-project-per-app requirement [G1, G2].

**Selected starting layout:** retain the existing Carbon and Kanban production
projects, and put the knowledge workload in a separate production project. Keep
nonproduction separate from production. The knowledge workload may contain several
Cloud Run services in one project. This preserves existing deployments and separates
the new document ingestion credentials and aggregated company corpus from ordinary
app deployments. Consolidating the two existing projects is not a prerequisite and
does not improve login or deployment isolation by itself.

A single production project is technically valid when all apps share administrators
and a trust boundary. The implementation must accept project placement as runtime
infrastructure configuration; no application code may assume project equality.
Project-per-service is explicitly unnecessary. Use dedicated runtime and deployment
service accounts, resource-level grants, and limited inherited organization roles.

Supabase remains in its current hosting arrangement initially. Distinguish a GCP
project, a Supabase installation, a PostgreSQL database, and a PostgreSQL schema.
The checked-in private PostgreSQL listener configuration admits the postgres database; separate app
schemas with restricted roles are the compatible starting point. Additional
PostgreSQL databases do not automatically receive the installation's Auth,
PostgREST, Storage, or Realtime services [R3, S8].

### 1.2 Authentication: managed Google first

**Selected baseline:**

1. Google Workspace is the workforce identity authority.
2. Google IAP protects new employee browser services on Cloud Run. Prefer IAP
   directly on the Cloud Run service, as current Google guidance recommends [G3].
3. Native Cloud Run IAM protects internal machine APIs. Existing VM API routes
   validate Google service-account ID tokens and explicitly allow permitted
   caller identities using Google's authentication libraries.
4. Carbon retains its current Supabase Google authentication, user UUIDs, session
   refresh, memberships, and RLS. Do not replace Carbon user IDs with Google
   subjects or assume an IAP/Firebase token is a Supabase session.
5. Kanban adopts the managed workforce entrance after its current private ingress
   has passed the IAP compatibility tests. Preserve the private network boundary.
6. No new Keycloak deployment, custom login broker, password store, token issuer,
   or shared parent-domain bearer cookie is part of the baseline.

IAP provides app admission; Carbon module permissions, Kanban board permissions,
document ACLs, and command approval remain application authorization. GCP IAM also
does not decide which business rows a person may read [G3–G6].

Validate authentication assurance as well as identity. An IAP assertion alone does
not prove a particular MFA level. Map source requirements to verified
Workspace/IAP controls explicitly; otherwise preserve the source's stronger MFA or
step-up requirement and deny the delegated operation until it is satisfied.
Never stamp Carbon's mfaVerified flag merely because an IAP signature is valid.

The normal browser experience is one Google credential interaction, with
redirects to establish app-specific sessions when needed. Existing Google sessions
should avoid another credential prompt when entering Carbon. First-use account
linking, consent, expired sessions, and security reauthentication can still require
interaction. Sharing an identity project alone does not share browser sessions.

Keep Carbon's private tailnet access during the initial integration. IAP is not a
switch that protects an unrelated Tailscale endpoint. Before changing Kanban or
Carbon ingress, demonstrate that the intended private route works with IAP and
that alternate origins cannot bypass it. If that is not possible with the existing
route, leave that application's current Google login operational and report the
specific ingress incompatibility; do not silently make a private service public.
This does not block the knowledge service or the existing Google credential SSO.

### 1.3 Managed identity product comparison

| Option | Decision | Reason and limits |
|---|---|---|
| Workspace + IAP | Use for new workforce browser apps | Google operates login/session admission; app authorization still required. |
| Cloud Run IAM | Use for machine APIs | Managed workload identities; exact receiving audience; no downloaded keys. |
| Identity Platform / Firebase Auth | Evaluate compatibility, do not migrate Carbon in this program | Supported Supabase third-party integration exists, but Carbon Auth session/MFA APIs and identity links need migration; Firebase web persistence is origin-local. Useful when future customer/mobile requirements justify it. |
| Supabase native OAuth server | Run an isolated evaluation; not a production dependency of the portal | Preserves existing UUIDs and standard grant handling, but current beta and raw-token isolation limitations need proof. |
| Carbon's existing MCP OAuth server | Keep for current consumers | It is a separate opaque-token implementation; do not label it generic OIDC or expand it into the company login system. |

Native Supabase OAuth exists in the pinned GoTrue v2.189.0 source [S1–S4].
Its identity scopes do not express arbitrary business API permissions. Current
native OAuth does not support custom scopes; client restrictions require
server-controlled client policy and claims.

Audience claims alone are insufficient to make those tokens read-only. The
tracked PostgREST configuration has no explicit JWT audience, and the pinned
GoTrue generic authentication middleware does not enforce a universal audience
check across account operations. Storage, Realtime, RPC, and Functions have
separate enforcement paths. A no-privilege database role does not protect every
Auth or privileged-function endpoint. Task 06 tests this rather than assuming
standards compliance implies the required isolation.

OIDC ID tokens also require asymmetric signing; OAuth refresh tokens are bound
to their client and cannot be dropped into Carbon's ordinary refreshSession
path. Any future adoption needs its own auth release, compatibility suite, and
rollback plan. A result requiring a broad custom token-aware proxy across
Supabase does not meet the goal of minimizing maintained authentication
infrastructure; record that result and keep the selected Google baseline.

### 1.4 Explicit trusted-forwarder contract

For employee requests along the explicitly registered forwarding graph:

~~~http
Authorization: Bearer <Google service-account ID token for the receiving API>
X-Portal-User-Evidence: <original Google-signed IAP assertion for the browser backend>
~~~

The angle-bracket values above describe token types, never literal deployment
configuration. This is an application **trusted-forwarder contract**, not a
Google OAuth token-exchange feature and not a general downstream IAP bearer token.

The browser backend:

- Validates its incoming IAP assertion.
- Constructs fresh outbound headers; removes client-supplied authorization,
  X-Serverless-Authorization, identity, and delegation headers.
- Gets a Google-signed service token with the exact destination audience.
- Forwards the original signed IAP assertion only as end-user evidence.

The only permitted employee forwarding edges are:

| Immediate caller | Receiver | Original IAP audience | Permitted capability |
|---|---|---|---|
| knowledge-web | knowledge-query | knowledge-web's exact IAP audience | query |
| knowledge-web | knowledge-actions | knowledge-web's exact IAP audience | propose/execute registered user commands |
| knowledge-query | Carbon or Kanban read API | knowledge-web's exact IAP audience | registered reads only |
| knowledge-actions | Carbon or Kanban command API | knowledge-web's exact IAP audience | exact registered command |

At each edge, the immediate caller obtains a fresh target-audience service token.
The original IAP assertion remains unchanged. A query/action service may forward
only after validating its own inbound pair and authorization. Additional hops
are denied by default. Source backends register query/actions identities, not just
the browser backend identity.

The receiving API verifies the complete service token, immutable caller identity,
and target audience. It verifies the user evidence against the exact source-IAP
audience registered for that caller. A token from an unrelated IAP application,
or an indexer service account paired with user evidence, must fail.
Cloud Run's native IAM is an additional entrance check. Do not use the
signature-stripped X-Serverless-Authorization header for application verification
[G5, G6].

Map verified issuer/subject identities to existing application user IDs.
Provision bindings from verified provider identity or a deliberate authenticated
account-linking flow. Email is an attribute and a migration hint, not permanent
identity proof. Unknown users receive no workspace or company access.

Two bearer assertions are not cryptographically bound to each other or to the
command body. The forwarding backend is therefore trusted to act for users whose
valid assertions it has observed. Bound its callable operations, protect browser
commands with CSRF/Origin checks, keep raw assertions out of logs and durable
queues, and reauthorize queued actions at execution. Do not propagate this
contract through arbitrary chains of services.

### 1.5 Independently deployed units

| Unit | Proposed source | Credential boundary |
|---|---|---|
| knowledge-web | apps/knowledge | IAP browser backend; can invoke approved query/action APIs; no source DB credentials |
| knowledge-query | apps/knowledge-query | Read-only index role, read source APIs, model access; cannot invoke business write APIs |
| knowledge-ingest | apps/knowledge-worker | Connector credentials and index-write permissions; no purchasing/ticket execution |
| knowledge-parser | apps/knowledge-worker, separate entrypoint/image | One staged document and bounded outputs; no source credentials or business DB access |
| knowledge-actions | apps/knowledge-actions | Narrow command APIs; no broad document connector credentials |
| knowledge-schema | packages/knowledge migration entrypoint | Migration-only role; never supplied to an application |
| Carbon ERP / MES | Existing apps | Independently built and rolled out |
| Kanban web / API / schema | Existing sibling repository | Independently built and rolled out |
| Supabase/Auth/Storage/Redis/Inngest/network | Existing infrastructure plus declared additions | Explicit maintenance releases, independent of app changes |

The browser backend is a small trusted component: deterministic routing, session
validation, and request validation. Model/tool execution happens in the query or
action service. A query-service compromise must not yield ticket-write credentials.

Use the current TypeScript/React Router/pnpm conventions for new Carbon workspaces.
Share pure schemas and algorithms through @carbon/knowledge; do not make the
Python Kanban backend import a TypeScript workspace. Publish versioned OpenAPI/JSON
Schema contracts and test Python/TypeScript interoperability.

Use managed GCP Secret Manager, service identities, Artifact Registry, logging,
and Cloud Run for new services. Use a dedicated managed Redis instance for the
knowledge workload when provisioning it; do not change the behavior of Carbon's
existing resilient cache package. Keep Postgres as the initial hybrid search
engine. No separate vector database, graph database, or general autonomous agent
framework is required.

### 1.6 Read paths, documents, and intake

~~~mermaid
flowchart LR
    U[Employee text or voice] --> W[Google IAP and browser backend]
    W --> Q[Read query service]
    Q --> P[Current authorization]
    P --> R[Bounded source reads]
    P --> H[Authorized hybrid document search]
    R --> E[Versioned evidence and citations]
    H --> E
    E --> A[Direct result or short generated answer]
    W --> C[Explicit command service]
    C --> V[Authorize and validate exact action]
    V --> K[Owning application API]
    I[Upload or source connector] --> X[Isolated extraction]
    X --> D[Review and entity linking]
    D --> H
~~~

Classify requests into four bounded paths:

| Path | Example | Execution |
|---|---|---|
| Locate | Open a known manual or ticket | Exact IDs/aliases, permitted metadata, direct link; usually no answer-model call |
| Structured read | Items received recently; pending board tickets | Parameterized source queries and aggregates with limits; no free-form SQL |
| Document answer | Explain a procedure or compare manual sections | Authorized lexical + vector search, optional reranking, cited synthesis |
| Explicit command | Create a ticket; prepare a purchase request | Separate intent schema and command service; source-side authorization |

Live operational facts come from the owning app. The index holds derived
projections and documents with source revisions and freshness timestamps.
No generated summary replaces a ledger, receipt, approved engineering revision,
or source document.

For a request such as “open the manual for the NEMA 34 motor received recently”:

1. Resolve the authorized receipt/item context through Carbon's inventory data.
2. Use posted, positive, non-voided receiving evidence; account for reversals and
   the authoritative receipt/item revision. Do not use a purchase order's creation
   date as proof of receipt.
3. Match manufacturer, MPN, item revision, and applicable serial/lot or product
   variant. A frame designation is not sufficient product identity.
4. Follow the verified entity-to-document link and return the applicable manual
   version with a source link.
5. If multiple products remain plausible, show a small selection instead of
   guessing. Access to a manual does not automatically grant price/contract access.

Knowledge intake accepts a PDF, source URL, scanned nameplate, photo, or existing
document reference. Reuse available item/supplier/receipt metadata. Extract
proposed fields with page/region provenance; require confirmation of uncertain
identity and applicability. Preserve user corrections across re-extraction.
Publishing knowledge and posting an ERP financial/inventory transaction are
different actions. Intake must not silently post receipts, create suppliers, or
change purchase orders.

Generic documents also work without an item link: procedures, meeting notes,
design rationale, specifications, and troubleshooting records have owners, ACLs,
versions, document status, and optional entity relationships.

### 1.7 Retrieval and token budgets

Use exact identifier/MPN lookup and normalized aliases before fuzzy matching.
Preserve engineering punctuation, decimal separators, units, revisions, and part
number distinctions. Combine indexed Postgres full-text search and pgvector with
reciprocal-rank fusion. Evaluate filtered approximate search against an exact
authorized baseline; filtering after ANN candidate selection can reduce recall.
Use iterative scans only if supported by the installed pgvector version [S5–S7].

Initial adjustable limits, enforced in code:

- Input: 8,000 characters and 2,000 model tokens; longer input becomes an explicit
  document attachment or a validation response.
- Router: deterministic rules first, then at most one small structured inference
  call. It chooses registered capabilities; it does not see the entire tool catalog.
- Retrieval: at most 40 candidates per source, four sources per ordinary request,
  and eight final evidence blocks.
- Model context: 8,000 input tokens including prompt/history/evidence; reserve
  1,000 for compact conversation state and trim evidence deterministically.
- Answer: 800 output tokens by default. Broader reports are explicit async jobs.
- No open-ended tool loops. One route call plus one answer call is the normal
  model budget; a single measured rerank stage is optional for difficult queries.
- Query deadlines: 1 second per live source initially, 2 seconds for retrieval
  orchestration, 10 seconds total interactive response deadline. Return a clearly
  labeled partial result when a permitted source is unavailable.

Provider/model IDs, regions, and retention settings are versioned runtime
configuration. Reuse current SDK abstractions; benchmark supported models against
the acceptance set before selecting the deployment profile. This plan does not
pin an unverified future model ID or assume any provider offers zero retention.
No automatic provider fallback may cross the permitted data boundary.

### 1.8 Cache correctness and freshness

Use separate caches for query routing, entity resolution, retrieval candidates,
source responses, and final answers. Cache keys include:

~~~text
company + canonical actor/access cohort + calling capability
+ policy version + normalized intent/entities + source query epochs
+ source/document revisions + embedding/index version
+ prompt/model version + locale + business timezone
~~~

Start with per-user exact answer caching. Cross-user reuse requires a proven
equivalent access cohort; semantic answer caching stays disabled until evaluation
shows it preserves permissions, exact entities, dates, and revisions. Query
embeddings can be cached separately without caching an answer.

Check current authorization before every cache hit and every source-link resolve.
ACL/policy uncertainty fails closed. Redis is an optimization; a miss or outage
falls back to authoritative data. Do not inherit Carbon's fail-open limiter as the
sole protection for model spend or command abuse.

Authenticated HTML/API responses use private, no-store browser/CDN caching policy;
application caches live behind authorization. Service workers must not retain
private result bodies. Public fingerprinted assets can use long-lived caching.
Revocation prevents future delivery; it cannot retract bytes a user already received.

Use per-query-family epochs, not only versions of returned rows. A newly received
item, new matching ticket, or deleted document can change a result set that did
not previously contain it. Commit source changes and outbox events atomically;
apply idempotent invalidation and periodic reconciliation. Permission revocations
bypass content-cache TTLs.

Default freshness rules:

| Data | Policy |
|---|---|
| Ticket status, quantities, receipt recency | Read source for explicitly current questions; ordinary source-cache TTL at most 15 seconds plus invalidation |
| Immutable document content | Cache by content hash/version; never reuse its old authorization decision |
| Search/answer cache | At most 60 seconds initially, additionally bounded by evidence and policy epochs |
| App permission/disabled-user state | Authoritative version check, with at most a 5-second local optimization and 30-second hard expiry |
| Drive permissions | Local sync alone cannot promise immediate revocation; live user-authorized checks for restricted content before delivery |
| Signed document download | At most 60 seconds; disclose that issued links remain usable until expiry unless served through an authorizing proxy |

Local emergency disablement must be enforceable without waiting for Google group
sync. Workspace suspension/IAP propagation and previously issued assertions have
separate latency limits. Do not claim instantaneous global logout. For voice or
streaming connections, recheck authorization for every command; IAP checks
WebSockets at connection establishment, not continuously [G7].

### 1.9 Security, privacy, and ownership invariants

1. Authorization filters apply before content reaches an external reranker,
   embedding/answer provider, or user. Provider eligibility is a separate policy
   from the user's permission to read.
2. Documents, OCR text, retrieved snippets, and tool results are untrusted data.
   They cannot add tools, alter policies, supply credentials, or authorize writes.
3. Source identity and ACL are independent of blob deduplication. Identical bytes
   do not merge users' access. Use an ACL-neutral content-addressed blob and keep
   separate source/document access records.
4. Read credentials have no business write permission. Audit PUBLIC privileges,
   role inheritance, security-definer RPCs, triggers, and storage endpoints; a
   function named getSomething is not proof of no side effects.
5. Source URL fetching blocks metadata endpoints, loopback, private-address
   targets unless explicitly approved, DNS rebinding, redirects to forbidden
   targets, archive expansion bombs, and credential forwarding.
6. Parsing runs with constrained CPU/memory/time, no broad source credentials,
   and minimal egress. File MIME sniffing and scanning precede indexing.
7. Application logs contain request IDs, operation IDs, result counts, timing,
   source IDs, and policy decisions. They exclude bearer tokens, full prompts,
   documents, model responses, and microphone recordings by default.
8. Conversation state is company/user-scoped and policy-revalidated on reuse.
   Store evidence references; do not recycle a historical snippet after access
   is revoked. Default transcript retention is 30 days, configurable downward.
9. Raw audio is discarded after successful transcription by default; explicit
   diagnostic retention is separate consent/configuration and private storage.
10. Source deletion removes searchable chunks and cached derivatives. Keep only
    permitted audit/tombstone metadata. Backup retention/deletion must be stated;
    deleting an index row is not erasure from every backup.
11. Canonical records and approved documentation are backed up. Derived indexes
    can be rebuilt. Test restoration of source/ACL versions together.
12. Supplier/customer communications and purchases are never sent merely because
    text inside a retrieved document requests them.

### 1.10 Command behavior

The first enabled command is create-ticket. Parse STT into the same schema as
typed input, resolve only permitted boards, and use the board's configured
initial column by stable ID. The synthetic example is a surface-grinding ticket
in a machine-build board's PENDING column. Never fall back to the first board or
first column after unresolved inference.

For a clear, explicit create-ticket request, execute after deterministic validation
and current authorization, then show the created ticket link and effective due
date. Ask a focused clarification for ambiguous board, item, date, or quantity.
Do not add a confirmation click to every low-risk ticket command by default.

Use a separate command-specific permission, board authorization, actor stamping,
optimistic version checks where updating, and a durable idempotency key scoped to
company/workspace + actor + action + canonical payload hash. Concurrent retries
produce one ticket. A repeated key with a different payload fails.

“Schedule purchase of 60x20 stators for month end” is not permission to invent a
quantity, supplier, units, budget, or interpretation of “schedule.” The later
purchasing capability prepares a reviewable proposal and creates a Draft purchase
order through Carbon's domain API once all required fields are resolved.
Submission, approval, release, payment, and
supplier communication keep their existing permissions and confirmation rules.
Scheduled execution reauthorizes the actor and verifies the stored command version.
Carbon currently has no procurement-request entity. The concrete later command
creates a Draft purchase order with validated lines once supplier, location, item,
quantity, units, and date intent are resolved. Until then, retain a knowledge
proposal rather than claiming a Carbon request already exists.

MCP is an optional transport over the same typed handlers. It must not introduce
an alternate execution path or expose the entire generated ERP catalog to every
request.

## 2. Measurable acceptance criteria

These are initial targets, not measured current performance. Benchmark from a
representative employee browser and separately inside the service region.

| ID | Acceptance |
|---|---|
| A01 | One normal Google credential interaction reaches the portal, Kanban, and Carbon; first-use consent and policy reauthentication are reported separately. |
| A02 | Unknown identities, wrong companies, unauthorized boards/documents, forged headers, wrong audiences, and unauthorized service accounts receive no data. |
| A03 | A same-input deployment is a no-op. An ERP-only edit preserves MES/DB/container uptime; a Kanban web-only edit preserves API revision and schema. |
| A04 | Authorized cached/direct lookup p95 at most 500 ms end-to-end on the warm path; auth/cache/DB timing reported separately. |
| A05 | Uncached structured read p95 at most 1 second; document answers show first meaningful evidence/token p95 at most 2 seconds and complete p95 at most 5 seconds on the standard query set. |
| A06 | Same-region auth/policy overhead p95 at most 50 ms excluding the external IAP boundary; measured IAP overhead remains part of end-to-end targets. |
| A07 | Authorized Recall@10 at least 0.95 for known-item/manual queries; no confident selection when the fixture is intentionally ambiguous. |
| A08 | Every factual generated claim has resolvable evidence; unsupported/contradictory cases abstain or explain conflict. |
| A09 | No cross-company/user/cache leakage in adversarial tests, including counts, snippets, autocomplete, errors, logs, and citations. |
| A10 | Local revocation enforced within 30 seconds including cache hits and queued writes; Google/Drive propagation limits measured separately. |
| A11 | New local content searchable p95 within 60 seconds after successful extraction; deletion and local ACL revocation invalidate query access within 30 seconds. |
| A12 | Re-extraction preserves accepted corrections; duplicate blobs preserve separate source ACLs; intake cannot post ERP transactions. |
| A13 | A permitted ticket command creates exactly one ticket on the correct board/initial column with actor, deadline, and audit metadata. |
| A14 | A read-only request/process cannot execute a business mutation through any exposed transport. |
| A15 | New connectors implement the same authorization, version, pagination, freshness, and deletion contract without modifying the router's core algorithm. |

Performance evaluation uses at least 500 synthetic questions, 10 concurrent users,
100,000 chunks, realistic per-user ACL selectivity, and both warm/cold paths.
Separate exact lookup, structured read, document synthesis, and commands. Report
p50/p95/p99, errors, cache hit rates, tokens, source fan-out, and cost per successful
answer. Do not optimize aggregate averages by hiding slow or unauthorized cases.

## 3. Progress and dependency graph

- [ ] Task 01: Add contracts, isolated test tooling, and package boundaries.
- [ ] Task 02: Build a dependency-aware release planner.
- [ ] Task 03: Remove Carbon's routine full-stack rollout coupling.
- [ ] Task 04: Split Kanban builds, migrations, and deployments.
- [ ] Task 05: Provision the managed workforce and service identity foundation.
- [ ] Task 06: Evaluate Supabase OAuth and Identity Platform in isolation.
- [ ] Task 07: Implement trusted-caller verification and stable identity binding.
- [ ] Task 08: Enforce Carbon read authorization through its canonical API.
- [ ] Task 09: Enforce Kanban user and board authorization.
- [ ] Task 10: Create the knowledge schema, roles, and policy tests.
- [ ] Task 11: Generate types and verify migration compatibility.
- [ ] Task 12: Implement bounded source adapters and the motor/manual resolver.
- [ ] Task 13: Implement immutable intake and correction preservation.
- [ ] Task 14: Build the intake review interface.
- [ ] Task 15: Implement incremental indexing and outbox delivery.
- [ ] Task 16: Implement authorized hybrid retrieval and evidence assembly.
- [ ] Task 17: Implement versioned caching, invalidation, and revocation.
- [ ] Task 18: Implement bounded routing, synthesis, and the portal interface.
- [ ] Task 19: Implement the Google Drive connector.
- [ ] Task 20: Implement explicit typed and voice ticket commands.
- [ ] Task 21: Add scheduled procurement proposals through Carbon.
- [ ] Task 22: Add generic engineering/CRM adapters and optional MCP transport.
- [ ] Task 23: Add observability, abuse budgets, retention, and recovery.
- [ ] Task 24: Run acceptance and stage the rollout.

Tasks 02–04 can progress alongside identity work. Task 06 is an evaluation and does
not gate the selected Google architecture. Tasks 08 and 09 depend on 07. Schema
10–11 can proceed alongside source authorization. Source adapter 12 needs 08, 09,
11. Intake 13–15 and retrieval 16–18 converge before Drive and commands are enabled.
Task 21 follows the proven ticket command path. Task 24 is required before broad
production use, with a smaller read-only pilot allowed once its applicable gates
pass. Unchecked tasks remain part of the program even after that pilot.

Each task is a reviewable change; do not combine unrelated auth, schema, and
deployment cutovers into one release. No task may reset the developer database.
New runtime values come from private configuration, not edits to this plan.

## Task 01: Add contracts, isolated test tooling, and package boundaries

**Depends on:** none

**Files:**

- Create: packages/knowledge/package.json, tsconfig.json, vitest.config.ts
- Create: packages/knowledge/src/contracts.ts, contracts.test.ts, test/database.ts
- Create: packages/knowledge/src/test/synthetic.ts
- Create: apps/knowledge/package.json, apps/knowledge-query/package.json,
  apps/knowledge-worker/package.json, apps/knowledge-actions/package.json
- Create: apps/knowledge/playwright.config.ts and apps/knowledge/tests/setup.ts
- Create: apps/knowledge/app/root.tsx, routes.ts, entry.client.tsx, entry.server.tsx
- Create: apps/knowledge/react-router.config.ts, vite.config.ts, tsconfig.json
- Modify: pnpm-workspace.yaml and turbo.json only for the new package/task graph.
- Copy from: packages/api/package.json and apps/starter/package.json for workspace
  conventions; packages/jobs/src/invoice-intake/contracts.ts for versioned extraction.

**Steps:**

1. Create @carbon/knowledge as a server-safe pure contract/algorithm package. Keep
   database/network clients in explicit server entrypoints. Do not export source
   credentials or application-only modules through its browser barrel.
2. Register script entrypoints: test, test:integration, typecheck, migration:new,
   migrate:test, generate:types, evaluate, verify:security, and verify:deployment.
   Implement each entrypoint in its owning task; do not represent later evaluation
   entrypoints as complete in this scaffold. Test scripts fail if required suites
   are missing. Integration scripts require
   an explicitly disposable local database and reject non-local URLs.
3. Define version-1 schemas for Principal, SourceCapability, QueryRequest,
   Evidence, SourcePage, DocumentVersion, IntakeProposal, and CommandProposal using
   the field contract in section 4. Derive JSON Schema/OpenAPI from the same schemas.
4. Create deterministic two-company fixtures, users with disjoint board/document
   access, identical blobs with different ACLs, revoked memberships, corrected
   receipts, two similar motors, and injection-bearing documents.
5. Name the app packages knowledge, knowledge-query, knowledge-worker, and
   knowledge-actions. Add typecheck/test/build scripts and knowledge's test:e2e
   script using Playwright with synthetic staging fixtures. Use current workspace dependency
   versions where already present; lock new Google SDK dependencies through pnpm.
   Pin parser container inputs and verify their license boundaries.
6. Make the knowledge browser skeleton runnable with existing layout/style
   conventions and a health route. Business routes deny access until their
   authentication/handler tasks are implemented; do not copy starter auth behavior
   as an implicit fallback.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test
pnpm exec turbo run typecheck --filter=@carbon/knowledge
~~~
Expected: schema round trips and invalid-identity/oversized-payload cases pass;
fixtures contain no deployment-specific values.

**Out of scope:** cloud resources, live data import, enabling any business write.

## Task 02: Build a dependency-aware release planner

**Depends on:** none

**Files:**

- Create: contrib/deploying/gcp-tailscale/release_plan.py
- Create: contrib/deploying/gcp-tailscale/release.schema.json
- Create: contrib/deploying/gcp-tailscale/test_release_plan.py
- Modify: Dockerfile, turbo.json, contrib/deploying/gcp-tailscale/render.py
- Copy from: contrib/deploying/gcp-tailscale/test_render.py for offline fixtures.

**Steps:**

1. Implement a pure planner taking desired inputs and the last successful
   per-service manifest. Output build, configure, migrate, deploy, and unchanged
   sets with reasons. Actual manifests are private operational artifacts.
2. Fingerprint app source, transitive workspace dependencies, pruned lockfile and
   catalog entries, generators/assets, build configuration, base-image digest,
   runtime config content, and pinned secret versions. Unknown input ownership
   fails with a reviewable diagnostic instead of silently missing a dependency.
3. Narrow Docker build/runtime inputs so an unrelated app is not implicitly copied
   into every image. Model shared Lingui/MCP generation dependencies honestly.
4. Preserve each unchanged service's source commit, immutable image digest,
   SOURCE_CODE_URL, and content-addressed config mount path. A global repository
   revision must not force every service definition to change.
5. Handle skipped commits, deleted files, removed/added dependency edges, config-only
   changes, secret-only changes, rollback bases, and independently deployed commits.
   Path-filtered CI triggers reduce noise; the planner is the actual authority [G10].

**Verify:**
~~~bash
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_release_plan.py'
~~~
Expected: no-op emits no mutations; docs-only emits none for unrelated apps;
shared changes select actual consumers; secret-only reuses the existing image.

**Out of scope:** executing deployment or moving GCP projects.

## Task 03: Remove Carbon's routine full-stack rollout coupling

**Depends on:** 02

**Files:**

- Modify: contrib/deploying/gcp-tailscale/deploy.py, host-deploy.sh, render.py
- Modify: contrib/deploying/gcp-tailscale/test_deploy.py, test_render.py
- Create: contrib/deploying/gcp-tailscale/test_service_rollout.py
- Modify: contrib/deploying/gcp-tailscale/README.md

**Steps:**

1. Make routine app releases consume the affected-set manifest. Build and update
   only selected services, with dependencies health-checked rather than restarted.
2. Separate routine app rollout from the existing quiesce/stop-Docker/snapshot
   sequence. Retain coordinated snapshots for explicit stateful maintenance.
3. Treat database migrations, GoTrue/auth hooks, private-role isolation, edge runtime,
   proxy/network changes, and base infrastructure as distinct release units.
   App releases check compatible schema versions instead of blindly migrating.
4. Serialize mutations per target and compare expected manifest generation AND
   observed service configuration before promotion. Report manual configuration
   drift instead of overwriting it silently. Failed health checks roll back only
   the changed compatible app.
   Never restore the entire shared database as automatic app rollback.
5. Preserve clean-source/public-fork release rules and exact deployed-source links.
   Save private pre/post container IDs and database uptime for staging acceptance.

**Verify:**
~~~bash
python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p 'test_*.py'
bash -n contrib/deploying/gcp-tailscale/host-deploy.sh
~~~
Expected: fake ERP-only rollout issues zero MES/database/Redis/Inngest/auth
restart commands; migration-only and maintenance releases have distinct paths.

**Out of scope:** database engine migration, changing backup retention.

## Task 04: Split Kanban builds, migrations, and deployments

**Depends on:** 02

**Files:**

- Create: ../kanban/deploy/release_plan.py, release.schema.json, test_release_plan.py
- Modify: ../kanban/deploy/cloudbuild.yaml, deploy.sh, Dockerfile.web, gcp-setup.sh
- Modify: ../kanban/Makefile
- Modify: ../kanban/frontend/unit/deployment-performance.test.mjs

**Steps:**

1. Apply the same per-service manifest semantics to web, API, and Alembic migrations.
   Use behavioral planner tests, not only configuration-string assertions.
2. Build/deploy web only for web inputs; API only for API inputs; migrate only for
   a selected compatible schema release. Keep the existing migration advisory lock
   and dedicated migration identity.
3. Remove the unnecessary build-time API-origin argument; the frontend already
   reads its API origin at runtime. Pin image digests and secret versions.
4. Split web/API runtime service accounts. After the staged migration succeeds,
   revoke the old shared runtime account's application-secret and invocation
   grants. Reject dirty-source production releases and mutable latest image/secret
   selection.
5. Stage Cloud Run revisions without traffic, probe, and promote only selected
   revisions. Preserve unaffected revision IDs; add per-service rollback [G9, G11].

**Verify:**
~~~bash
python3 -m unittest discover -s ../kanban/deploy -p 'test_release_plan.py'
make -C ../kanban test-api
make -C ../kanban test-web
bash -n ../kanban/deploy/deploy.sh
~~~
Expected: web-only release neither builds/deploys API nor runs a migration;
API-only release preserves web revision unless an actual client contract changed.

**Out of scope:** rewriting Kanban's frontend or moving its database.

## Task 05: Provision the managed workforce and service identity foundation

**Depends on:** 01, 02

**Files:**

- Create: contrib/deploying/knowledge/main.tf, variables.tf, outputs.tf
- Create: contrib/deploying/knowledge/identity.tf, networking.tf, services.tf
- Create: contrib/deploying/knowledge/storage.tf, redis.tf, releases.tf
- Create: contrib/deploying/knowledge/README.md, test_infrastructure.py
- Create: contrib/deploying/knowledge/Dockerfile.web, Dockerfile.query,
  Dockerfile.ingest, Dockerfile.parser, Dockerfile.actions, Dockerfile.schema
- Create: contrib/deploying/knowledge/cloudbuild.yaml, release.py, test_release.py
- Create: contrib/deploying/knowledge/probe/server.ts, Dockerfile.probe
- Create: .github/workflows/knowledge-check.yml
- Modify: ../kanban/deploy/gcp-setup.sh for the staged IAP integration.

**Steps:**

1. Declare the section 1.1 project layout through configurable IDs and separate
   production/nonproduction state. Reuse existing project ownership; do not migrate
   Carbon/Kanban to a new project merely to standardize names.
2. Create separate deployment, web, query, ingestion, parser, actions, and migration
   service accounts. Use attached workload identity and Secret Manager, with no
   downloaded service-account keys.
3. Configure IAP for the employee browser service, Workspace group admission, exact
   ingress, and no alternate unauthenticated origin. Internal APIs use Cloud Run
   IAM and exact caller grants; downstream APIs do not require browser cookies.
4. Define a private path to the current Supabase/source APIs. Keep raw PostgreSQL
   TLS verification, subnet restrictions, and schema-specific credentials.
5. Configure one private GCS knowledge bucket with object-generation references,
   lifecycle policy, and separate ingestion/parser/query permissions. Provision
   dedicated managed Redis and constrain Cloud Run max instances/DB connections.
6. Create image/build targets for each selected unit and a release controller
   consuming Task 02's dependency manifest. The ingest image serves its independent
   Inngest HTTP endpoint on Cloud Run; parser and schema run as finite Cloud Run
   Jobs. Declare parser/ingest import closures separately so shared source location
   does not automatically force both images to rebuild.
7. Give the release controller exclusive ownership of the complete mutable
   service/job revision spec: image, environment, secret versions, resource limits,
   concurrency, and scaling. Terraform owns foundation/IAM/network resources and
   the bootstrap shell; subsequent foundation applies must not overwrite any
   revision field owned by the controller. Drift fails before promotion.
8. Provision foundation before application services. Use the synthetic probe image
   for the IAP/network proof; it has no source credentials or business handlers.
   Create/promote real services only after their implementation tasks produce
   tested immutable images. Task 24 exercises the actual selected-unit controller.
9. Use a disposable nonproduction project/configuration for the IAP/private-route
   proof. Test custom-domain login, callback routes, run.app access, proxy paths,
   streaming, and source connectivity. Record any incompatibility without weakening
   private ingress.

**Verify:**
~~~bash
terraform -chdir=contrib/deploying/knowledge init -backend=false
terraform -chdir=contrib/deploying/knowledge validate
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_infrastructure.py'
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_release.py'
~~~
Expected: configuration validates; tests reject public data access, shared privileged
runtime identity, latest secret refs, missing IAP, and project-wide runtime admin.
Staging evidence must additionally prove an unauthorized browser and alternate
origin cannot reach protected application responses.

**Out of scope:** production apply during plan authoring; changing existing private
access policy to satisfy a failed staging check.

## Task 06: Evaluate Supabase OAuth and Identity Platform in isolation

**Depends on:** 01

**Files:**

- Create: contrib/deploying/gcp-tailscale/auth/oauth-evaluation/compose.yml
- Create: contrib/deploying/gcp-tailscale/auth/oauth-evaluation/evaluate.py
- Create: contrib/deploying/gcp-tailscale/auth/oauth-evaluation/test_evaluation.py
- Create: contrib/deploying/gcp-tailscale/auth/oauth-evaluation/RESULTS.md

**Steps:**

1. Run a synthetic isolated stack using the repository's actual pinned GoTrue and
   consumer versions. Record feature availability, beta status, claims, client-bound
   refresh behavior, and asymmetric-signing compatibility.
2. Test one read client against its intended adapter and then replay its token
   against PostgREST DML/RPC, Storage writes, Realtime writes, privileged Functions,
   and ordinary GoTrue user/factor/account/logout mutation endpoints.
3. Include missing PKCE, code replay, wrong client refresh, wrong audience,
   unsupported scopes, unknown clients, revoked grants, and disabled users.
4. Evaluate Firebase third-party compatibility with preserved Carbon UUIDs,
   issuer/project restrictions, role claims, Google account linking, session
   refresh, MFA enforcement, and origin-local session behavior.
5. Record an evidence matrix: supported, unsupported, and migration work. The
   pass condition for adopting native delegation is every direct write/replay
   denial plus existing Carbon compatibility; a partial result is a failed adoption
   gate. Do not implement a broad custom security proxy to force a pass.
6. Keep the selected IAP/workload-identity baseline regardless of this evaluation's
   outcome. Any later identity-provider replacement is a separate reviewed release.

**Verify:**
~~~bash
python3 -m unittest discover -s contrib/deploying/gcp-tailscale/auth/oauth-evaluation -p 'test_*.py'
python3 contrib/deploying/gcp-tailscale/auth/oauth-evaluation/evaluate.py --disposable --synthetic
~~~
Expected: complete machine-readable matrix and sanitized RESULTS.md; a failed
native-delegation isolation test is reported as failure, not hidden or bypassed.

**Out of scope:** enabling native OAuth or Identity Platform in production.

## Task 07: Implement trusted-caller verification and stable identity binding

**Depends on:** 01, 05, 11

**Files:**

- Create: packages/knowledge/src/identity.server.ts, identity.test.ts
- Create: packages/auth/src/services/workforce.server.ts, workforce.server.test.ts
- Modify: packages/auth/src/services/session.server.ts
- Modify: apps/erp/app/routes/_public+/login.tsx, callback.tsx
- Modify: apps/mes/app/routes/_public+/login.tsx, callback.tsx
- Create: packages/auth/src/services/workforce-session.test.ts
- Modify: packages/auth/package.json for an explicit server-only export.
- Create: ../kanban/backend/app/workforce.py, ../kanban/backend/tests/test_workforce.py
- Create: apps/knowledge/app/services/identity.server.ts
- Create: contrib/deploying/knowledge/callers.schema.json

**Steps:**

1. Implement the exact two-assertion contract in section 1.4 using Google libraries,
   explicit issuer/audience allowlists, cached rotating public keys, expiry checks,
   and immutable service-account IDs.
2. Build caller-to-source-audience-to-operation registration from private
   administrator-controlled configuration. Reject browser fields attempting to set
   actor, company memberships, application capability, or audit identity.
3. Resolve Google/IAP issuer+subject to an existing canonical user and local app ID.
   Keep legacy IDs and audit references. Where provider subjects cannot be
   proven equivalent, require authenticated account linking or administrator
   provisioning; never automatically merge solely by email.
4. Require current local user active state and company membership before returning
   a Principal. Add a local emergency revocation version.
5. Make Carbon ERP/MES sessions host-only with explicit Secure/HttpOnly settings
   and service-specific cookie names. Clearing DOMAIN alone is incorrect because
   the existing secure setting depends on it. Expire the legacy parent-domain
   cookie deliberately and establish independent app sessions through the existing
   Google/Supabase flow. Add an automatic Google redirect only for the configured
   Google-only workforce entry path, preserving state, PKCE, company selection,
   callback validation, and existing MFA gates.
6. Test the source's required assurance. Reject delegated access that would bypass
   required Carbon MFA/step-up; do not infer assurance from email/domain or IAP
   signature alone. Document managed-policy equivalence only when staging proves it.
7. Do not log assertions, persist them in jobs, or forward them beyond registered
   source APIs. Machine indexers use their own explicitly granted source access.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test identity
pnpm --filter @carbon/auth test workforce
make -C ../kanban test-api
~~~
Expected: wrong caller/source pairing, missing/forged headers, expired keys/tokens,
unknown subjects, email changes, disabled accounts, missing required assurance,
and cross-company claims fail; linked users retain IDs; ERP/MES navigation
establishes secure host-only sessions without sharing their refresh tokens.

**Out of scope:** a new token issuer, domain-wide session cookies, automatic account
or workspace creation.

## Task 08: Enforce Carbon read authorization through its canonical API

**Depends on:** 07

**Files:**

- Modify: apps/erp/app/routes/api+/v1+/lib/authenticate.server.ts
- Modify: apps/erp/app/routes/api+/v1+/lib/base.server.ts
- Modify: apps/erp/app/routes/api+/v1+/$.ts and lib/registry.server.ts
- Create: apps/erp/app/routes/api+/v1+/lib/workforce.test.ts
- Create: apps/erp/app/modules/knowledge/knowledge.models.ts
- Create: apps/erp/app/modules/knowledge/knowledge.service.ts
- Create: apps/erp/app/modules/knowledge/knowledge.server.ts, index.ts
- Create: apps/erp/app/modules/knowledge/knowledge.read.integration.test.ts
- Modify: scripts/lib/service-metadata.ts and scripts/generate-mcp.ts only for the
  module list and explicit reviewed permission/capability metadata.
- Copy from: apps/erp/app/routes/api+/v1+/lib/call.server.ts and existing inventory/item
  service functions.

**Steps:**

1. Add an explicit workforce-delegated auth kind. Apply current user permissions
   AND caller capability restrictions in the canonical oRPC middleware.
   The current middleware only applies its scope gate to API keys; do not assume
   an OAuth/session label provides the missing authorization.
2. Register a small allowlist: resolve items, list recent posted receipts, get item
   identity/revision, list applicable document references, read permitted board-like
   operational summaries, and bounded purchase status. Keep price fields separately
   permissioned. Reject arbitrary generated operation names.
3. Internally obtain the user-scoped Supabase client through existing auth helpers;
   keep signing/service-role secrets inside Carbon. Explicitly scope all reads by
   company and verify field/resource permissions.
4. Use dedicated query implementations for endpoints that need bounded aggregates.
   Do not inject privileged Kysely into a nominal read call without an explicit
   authorization and read-only transaction boundary.
5. Wire the HTTP entrypoint to the new verifier, add the module to the concrete
   service registry/generator module list, and provide explicit permission mapping.
   Exposed functions belong in .service.ts (or the supported .mcp.server.ts seam);
   arbitrary .server.ts exports are not discovered.
6. Regenerate the manifest and test real HTTP/OpenAPI and callOperation dispatch,
   including the new policy. Test HTTP, MCP, and internal paths cannot bypass it.
   Preserve ordinary API-key behavior and unrelated integrations.

**Verify:**
~~~bash
pnpm run generate:mcp
pnpm --dir apps/erp exec vitest run app/routes/api+/v1+/lib app/modules/knowledge
pnpm exec turbo run typecheck --filter=erp --filter=@carbon/auth
~~~
Expected: permitted read works with the correct user context; a permitted employee's
read-only caller still cannot invoke a write; cross-company and restricted fields fail.

**Out of scope:** flipping AGENT_DATA_TOOLS_ENABLED to expose the whole catalog.

## Task 09: Enforce Kanban user and board authorization

**Depends on:** 07

**Files:**

- Modify: ../kanban/backend/app/models.py, schemas.py, security.py, main.py
- Create: ../kanban/backend/app/authorization.py
- Create: ../kanban/backend/tests/test_authorization.py
- Create: an Alembic revision from the existing backend migration generator.
- Modify: ../kanban/frontend/app/lib/auth.ts
- Modify: ../kanban/frontend/app/kanban-api-internal/[...path]/route.ts
- Modify: ../kanban/frontend/app/auth/login/route.ts and auth/callback/route.ts

**Steps:**

1. Add stable external identity bindings, active state, board membership, and explicit
   board view/create/update capabilities. Backfill existing users through reviewed
   synthetic-tested mappings; preserve IDs and activities.
2. Remove implicit admission of an unfamiliar email to the first workspace.
   List/search/capture catalogs must contain only boards the actor may access.
3. Replace trust in arbitrary forwarded email/name with the workforce verifier for
   the managed path. Retain the current login during staged ingress compatibility;
   do not leave an insecure legacy bypass enabled after cutover.
4. Apply authorization in shared backend handlers for ordinary UI, API, and capture,
   not just the new portal. Stamp actorId on activities.
5. Generate and apply the Alembic migration only to the isolated test database for
   verification. Include existing-member and missing-board-membership cases.

**Verify:**
~~~bash
make -C ../kanban test-api
make -C ../kanban test-web
~~~
Expected: direct API/capture requests cannot access another board; current allowed
users keep existing tickets; unknown users gain no workspace implicitly.

**Out of scope:** changing board workflow states or deleting historical activities.

## Task 10: Create the knowledge schema, roles, and policy tests

**Depends on:** 01

**Files:**

- Create: packages/knowledge/src/migrations.server.ts
- Create: packages/knowledge/src/schema-contract.ts
- Create: packages/knowledge/src/schema.integration.test.ts
- Create: packages/knowledge/src/policies.integration.test.ts
- Create: packages/knowledge/migrations/ using the timestamped generator from Task 01.
- Copy from: packages/database/supabase/migrations for ID/audit/company conventions.

**Steps:**

1. Implement the private knowledge schema defined in section 4.2. It is not added
   to PostgREST's exposed schemas. Keep an independent migration ledger/owner and
   a database advisory lock so knowledge migrations do not replay Carbon migrations.
2. Use public.id prefixes, companyId, composite keys/FKs, inline user audit
   references, bare NUMERIC for domain quantities, and indexes on foreign keys
   and policy predicates. Add idempotent existence guards.
3. Create dedicated NOLOGIN policy roles and separately provisioned runtime login
   roles: knowledge_read, knowledge_ingest, knowledge_review, knowledge_actions,
   knowledge_migrate. Runtime roles are not owners, superusers, or BYPASSRLS roles.
4. Enable and force RLS. Reads require current actor/company plus source/document
   policy; intake drafts are private to owner/reviewers; published chunks inherit
   document access. Runtime request claims come only from validated server context
   and use SET LOCAL within a transaction, never pooled session-global settings.
5. Revoke direct browser/anon/authenticated access to this private schema.
   Inspect effective inherited and PUBLIC privileges, including EXECUTE on
   security-definer functions. Reject deployment if a read credential can invoke
   an out-of-scope mutation. Preserve explicit grants needed by existing apps
   when narrowing a shared PUBLIC grant.
6. Make publishing source/version/chunks/ACL epoch and outbox events transactional.
   Chunk queries never expose a version before its ACL and extraction are ready.
7. Create the migration with the package generator; retain its generated timestamp.
   The SQL must implement every named field, key, lifecycle constraint, role, and
   policy in section 4.2, with tests proving the contract before application.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge migration:new knowledge-foundation
pnpm --filter @carbon/knowledge migrate:test
pnpm --filter @carbon/knowledge test:integration schema policies
~~~
Expected: fresh and repeated application succeed in a disposable local DB;
tenant/ACL/role tests reject reads and writes outside each credential's contract;
concurrent publishing never exposes partially authorized content.

**Out of scope:** production schema changes, exposing knowledge through raw Data API,
modifying Carbon operational tables to duplicate their data.

## Task 11: Generate types and verify migration compatibility

**Depends on:** 10

**Files:**

- Create: packages/knowledge/scripts/generate-types.ts
- Generate: packages/knowledge/src/database.types.ts
- Modify: packages/knowledge/package.json
- Generate only if changed: packages/database/src/types.ts and its edge mirror.

**Steps:**

1. Generate the private schema's types from the migration-built local test schema.
   The generator refuses remote database targets and never embeds connection values.
2. Run the repository's standard type generation after schema application. Do not
   hand-edit generated types or stage unrelated generated churn.
3. Verify old/new query and ingestion versions can coexist across additive schema
   changes. Document minimum/maximum compatible migration versions in release
   manifests. Destructive contraction is a later explicit maintenance release.
4. Run Carbon dataset/backup checks against an up-to-date local schema if shared
   public grants/functions or Carbon schema were changed. Preserve all existing
   records; do not rebuild the developer database.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge generate:types
pnpm run generate:types
pnpm exec turbo run typecheck --filter=@carbon/knowledge --filter=@carbon/database
pnpm --filter @carbon/knowledge test:integration compatibility
~~~
Expected: generated types match migrations; both supported application versions
read the schema; unrelated tables/roles remain compatible.

**Out of scope:** generating types from production or a private backup.

## Task 12: Implement bounded source adapters and the motor/manual resolver

**Depends on:** 08, 09, 11

**Files:**

- Create: packages/knowledge/src/sources/carbon.server.ts, kanban.server.ts
- Create: packages/knowledge/src/sources/registry.ts, sources.test.ts
- Create: packages/knowledge/src/entities/resolve.ts, resolve.test.ts
- Create: apps/knowledge-query/src/server.ts, source-routes.ts
- Copy from: apps/erp/app/modules/inventory/inventory.service.ts and
  apps/erp/app/modules/items/items.service.ts for authoritative semantics.

**Steps:**

1. Implement searchEntities, getEntity, queryFacts, getDocumentReferences,
   checkAccess, and getChanges against the contract. Enforce projection, cursor,
   maximum rows, deadline, and source version.
2. Use parallel bounded reads, batch IDs, and aggregates instead of N+1 queries or
   sending entire tables to a model. Do not write arbitrary text-to-SQL execution.
3. Implement receipt-to-item-to-applicable-manual resolution with exact identifiers,
   quantity/reversal semantics, source revision, and business timezone.
4. Return structured ambiguity, unavailable-source, and insufficient-permission
   results without leaking hidden candidate names or counts.
5. Add authenticated deep links and freshness timestamps; a source outage must not
   be rendered as an authoritative empty result.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test sources resolve
pnpm --filter @carbon/knowledge test:integration source-contract
~~~
Expected: similar motor variants, old revisions, reversed receipts, hidden prices,
and unauthorized boards resolve correctly or require clarification.

**Out of scope:** copying all source tables into the search index.

## Task 13: Implement immutable intake and correction preservation

**Depends on:** 11, 12

**Files:**

- Create: packages/knowledge/src/intake/contracts.ts, intake.server.ts
- Create: packages/knowledge/src/intake/extraction.server.ts, reconciliation.ts
- Create: packages/knowledge/src/intake/intake.test.ts, preservation.test.ts
- Create: apps/knowledge-worker/src/ingest.ts, parser.ts, fetch-policy.ts
- Create: apps/knowledge-worker/src/fetch-policy.test.ts
- Copy from: packages/jobs/src/invoice-intake/contracts.ts, attachments.ts,
  recognition.ts, and worker.test.ts.

**Steps:**

1. Capture source, owner, ACL/classification, blob hash, object generation, MIME,
   acquisition time, and idempotency identity before extraction.
2. Accept PDF/image/URL or source references. Restrict URL fetching and parser
   privileges per section 1.9; enforce file/page/pixel/time limits.
3. Produce immutable extraction generations with page/region evidence, proposed
   manufacturer/MPN/revision, typed units, confidence calibration, and warnings.
4. Store reviewer decisions separately. Reparse uses compare-and-swap generations
   and preserves corrections made both before and during inference. New evidence
   requires acknowledgement before replacing an accepted field.
5. Detect duplicate content without merging source permissions. Keep unresolved
   identity, applicability, and attachment decisions explicit.
6. Expose ingestion states: captured, extracting, needs-review, ready, failed.
   A completed worker is not evidence that the correct manual is available.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test intake preservation
pnpm --filter knowledge-worker test
~~~
Expected: retries are idempotent; corrected fields survive reparsing; malformed,
oversized, injected, and SSRF-bearing inputs cannot reach protected resources.

**Out of scope:** posting receipts, financial approvals, supplier creation.

## Task 14: Build the intake review interface

**Depends on:** 13

**Files:**

- Create: apps/knowledge/app/routes/intake.tsx, intake.$id.tsx
- Create: apps/knowledge/app/modules/intake/intake.models.ts, intake.service.ts
- Create: apps/knowledge/app/modules/intake/ui/IntakeReview.tsx
- Create: apps/knowledge/app/modules/intake/ui/IntakeUpload.tsx
- Create: apps/knowledge/tests/intake.spec.ts
- Copy from: apps/erp/app/components/FileDropzone.tsx
- Copy from: apps/erp/app/modules/invoicing/ui/InvoiceDocuments/InvoiceDocumentReview.tsx
- Copy from: apps/erp/app/modules/invoicing/ui/InvoiceDocuments/InvoiceDocumentSourceReview.tsx

**Steps:**

1. Build drag/drop, URL, and camera/image intake with an owner/access selection.
   Reuse existing form/dropzone/document-preview patterns.
2. Show the source page beside proposed fields and existing item candidates.
   Highlight unresolved applicability and changed evidence without hiding saved
   corrections. Allow a generic document with no item association.
3. Publish only after authorization and required identity/access checks; make
   draft/review/published state clear. Show acquisition failures separately from
   extraction and review completion.
4. Use server validation, CSRF/Origin checks, accessible keyboard controls, and
   existing Lingui conventions. Do not expose parser/model configuration in the
   ordinary product flow.

**Verify:**
~~~bash
pnpm --filter knowledge test
pnpm exec turbo run typecheck --filter=knowledge
pnpm --filter knowledge test:e2e -- intake
~~~
Expected: a synthetic nameplate plus manual becomes a reviewed linked document;
ambiguous variants require a choice; unauthorized users cannot review or publish.

**Out of scope:** rebuilding Carbon's invoice review UI.

## Task 15: Implement incremental indexing and outbox delivery

**Depends on:** 11, 13

**Files:**

- Create: packages/knowledge/src/indexing/chunks.ts, indexer.server.ts
- Create: packages/knowledge/src/indexing/outbox.server.ts, indexing.test.ts
- Create: apps/knowledge-worker/src/inngest.ts, functions.ts
- Create: apps/erp/app/modules/knowledge/knowledge.events.server.ts
- Create: a Carbon migration from pnpm db:migrate:new knowledge-source-outbox.
- Create: apps/erp/app/modules/knowledge/knowledge.outbox.integration.test.ts
- Create: ../kanban/backend/migrations/versions/ using the existing revision generator
  for a knowledge-source-outbox revision.
- Modify: ../kanban/backend/app/models.py, services.py, main.py for transactional
  outbox insertion at source writes.
- Create: ../kanban/backend/app/knowledge_events.py and corresponding backend tests.

**Steps:**

1. Chunk by headings/pages/tables, retaining source offsets, units, captions,
   parent section, document revision, and applicability. Do not split a critical
   engineering table from its headers or footnotes.
2. Embed changed content once, with model/dimension/version recorded. Publish a
   new index generation atomically; do not mutate embeddings across incompatible
   models in place.
3. Use existing Inngest v3 semantics with a separate knowledge client/application
   and function registration endpoint. Do not import the entire ERP function list
   into the knowledge worker or require ERP deployment for worker-only changes.
4. Add a source-owned outbox in Carbon and Kanban. In Carbon, use reviewed
   transaction triggers on the selected source tables, or extend an existing
   transactionally enqueued event subscription with equivalent durable delivery.
   An Inngest search handler notification after commit is not a substitute.
   In Kanban, insert the outbox record in the same SQLAlchemy transaction as the
   business change. Record source/entity/version/event-kind references and a
   dedupe identity; claim pending records with leases and acknowledge after
   delivery. Do not assume a pre-commit sequence number orders transaction commits.
   Regenerate affected schema types immediately after applying each migration.
5. Deliver at least
   once with stable source+entity+version IDs. Workers acknowledge only after
   successful commit; reconcile periodically to recover missed notifications.
6. Prioritize ACL revocations and deletion tombstones over bulk reindexing.
   Handle out-of-order events, reconnect cursors, and duplicate deliveries.
7. Keep document bodies out of queue payloads and durable step outputs; pass
   immutable object/version references. Apply per-source/company concurrency and
   provider throttling without dropping required indexing events.

**Verify:**
~~~bash
pnpm db:migrate
pnpm run generate:types
pnpm --dir apps/erp exec vitest run app/modules/knowledge/knowledge.outbox.integration.test.ts
pnpm --filter @carbon/knowledge test indexing
pnpm --filter knowledge-worker test
make -C ../kanban test-api
~~~
Expected: replay and reordered events converge; deleted/revoked sources disappear;
unchanged blobs are not embedded again; worker release does not rebuild ERP.

**Out of scope:** replacing Carbon's existing event system.

## Task 16: Implement authorized hybrid retrieval and evidence assembly

**Depends on:** 11, 12, 15

**Files:**

- Create: packages/knowledge/src/retrieval/lexical.server.ts, vector.server.ts
- Create: packages/knowledge/src/retrieval/fusion.ts, evidence.ts
- Create: packages/knowledge/src/retrieval/retrieval.integration.test.ts
- Create: packages/knowledge/src/retrieval/recall.test.ts
- Create: a generated knowledge migration for query indexes and search functions.

**Steps:**

1. Add exact normalized identifier indexes, full-text GIN, and pgvector indexes
   matching the chosen embedding profile. Record installed extension version.
2. Apply company/document/source ACLs before returning candidates. Any external
   reranker receives only authorized, provider-eligible text.
3. Fuse lexical/vector ranks and expand only selected parent sections. Cap source
   fan-out and evidence tokens. Fetch current operational facts through adapters.
4. Test restrictive ACL selectivity against exact search. Tune iterative scans,
   partitioning, or exact fallback to preserve recall without exposing disallowed
   candidates. Run EXPLAIN ANALYZE on representative synthetic data.
5. Emit immutable evidence IDs with source URI, version, page/section, retrieval
   timestamp, effective permission version, and source freshness.
6. Apply the migration to the disposable schema and immediately regenerate types.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge migrate:test
pnpm --filter @carbon/knowledge generate:types
pnpm run generate:types
pnpm --filter @carbon/knowledge test:integration retrieval
pnpm --filter @carbon/knowledge evaluate -- suite=recall
~~~
Expected: A07–A09 pass; hidden documents cannot affect visible counts or snippets;
filtered ANN recall is measured against the authorized exact baseline.

**Out of scope:** a separate vector/graph database.

## Task 17: Implement versioned caching, invalidation, and revocation

**Depends on:** 15, 16

**Files:**

- Create: packages/knowledge/src/cache/keys.ts, cache.server.ts, epochs.server.ts
- Create: packages/knowledge/src/cache/cache.test.ts, revocation.integration.test.ts
- Create: apps/knowledge-query/src/cache.server.ts
- Create: apps/knowledge-worker/src/invalidation.ts

**Steps:**

1. Implement the layered keys and freshness rules from section 1.8, including
   current policy validation before cached response delivery.
2. Include query-family epochs so new matches invalidate earlier result sets.
   Update outbox handling for deletes, corrections, group/board changes, and
   model/index versions. Prevent stale generation writes after invalidation.
3. Coalesce identical in-flight reads within the same access scope. Use TTL
   jitter and bounded locks to avoid cache stampedes; locks are not authz truth.
4. Implement safe degraded behavior: Redis loss causes authoritative reads;
   policy-store loss denies sensitive data and commands. Stale document content
   may be reused only with current authorization and a visible freshness label.
5. Clear company/user client state on company changes/logout. Reauthorize evidence
   references before restoring a conversation.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test cache
pnpm --filter @carbon/knowledge test:integration revocation
~~~
Expected: warm-cache revocation, new matching receipt/ticket, reordered invalidation,
Redis loss, policy loss, and cross-user cache attacks satisfy A09–A11.

**Out of scope:** enabling semantic final-answer caching.

## Task 18: Implement bounded routing, synthesis, and the portal interface

**Depends on:** 07, 12, 16, 17

**Files:**

- Create: packages/knowledge/src/query/router.ts, budgets.ts, answer.server.ts
- Create: packages/knowledge/src/query/query.test.ts, grounding.test.ts
- Modify: apps/knowledge/app/root.tsx
- Create: apps/knowledge/app/routes/_index.tsx, routes/api.query.ts
- Create: apps/knowledge/app/modules/portal/ui/QueryInput.tsx, EvidenceCard.tsx
- Create: apps/knowledge/tests/query.spec.ts
- Copy from: apps/starter/app/root.tsx
- Copy from: apps/erp/app/modules/agent/ui/AgentInput.tsx, AgentMessage.tsx
- Copy from: packages/react/src/Command.tsx

**Steps:**

1. Implement deterministic locate/structured routing before bounded model inference.
   Register a compact capability description, typed inputs, deadlines, and
   projection limits. Source text cannot modify the registry.
2. Return a direct result/link for locate requests. For synthesis, provide only
   bounded authorized evidence and enforce source-cited answers/abstention.
3. Stream meaningful evidence or answer tokens, with honest progress states for
   unavailable sources. Do not manufacture instant “thinking” text as a latency metric.
4. Build one input with document/entity result cards, citations opening exact source
   locations, ambiguity choices, and compact follow-up context. Keep results useful
   without requiring generated prose.
5. Implement token accounting and hard budgets. Store short structured conversation
   state and evidence references rather than replaying the existing agent's entire
   25k-token history and 20-step loop.
   Send user text in POST bodies, not logged URL query strings.
6. Integrate Carbon navigation through a small explicit link or adapter only after
   the standalone read portal passes its source authorization tests.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test query grounding
pnpm exec turbo run typecheck --filter=knowledge --filter=knowledge-query
pnpm --filter knowledge test:e2e -- query
pnpm --filter @carbon/knowledge evaluate -- suite=interactive
~~~
Expected: locate uses no answer inference; normal synthesis stays within budgets;
manual queries cite the applicable version; unsupported answers abstain.

**Out of scope:** unrestricted SQL, unrestricted web browsing, autonomous tool loops.

## Task 19: Implement the Google Drive connector

**Depends on:** 13, 15, 16, 17

**Files:**

- Create: packages/knowledge/src/sources/drive.server.ts, drive.test.ts
- Create: apps/knowledge-worker/src/drive-sync.ts, drive-permissions.ts
- Create: apps/knowledge/app/routes/settings.sources.tsx
- Create: apps/knowledge/tests/drive-source.spec.ts
- Copy from: apps/knowledge/app/modules/intake/ui/IntakeReview.tsx

**Steps:**

1. Enroll explicitly selected company Shared Drives/folders. Start with read-only
   connector access. Store OAuth refresh credentials only in Secret Manager;
   signing into the portal does not itself authorize Drive access [D1].
2. Do not enable broad domain-wide delegation by default. Record connector scope,
   source owner, admitted corpora, and processing-provider eligibility.
3. Implement user/shared-drive change cursors, pagination, native-document export,
   shortcuts, deletion, moves, permission changes, and periodic full reconciliation.
   Push notifications are hints; retain cursor-based recovery [D2–D4].
4. Preserve effective ACLs including inheritance and groups. A connector's broad
   access is not every employee's access. Where the ACL cannot be faithfully
   evaluated, exclude the document or perform a live user-authorized access check.
5. Before sending restricted Drive text to an external reranker/answer model OR
   delivering it to a user/cache consumer, require current source authorization.
   For user-delegated live checks, enroll the minimum applicable read scope
   explicitly. Cache permissions only within the documented revocation budget.
6. Test parent-folder/shared-drive permission changes invalidating all affected
   descendants, including previously cached answers and model candidate batches.
7. Test the important edge case: the same PDF appears in two drives with different
   permissions. Blob reuse must not transfer access or reveal the hidden source.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test drive
pnpm --filter knowledge-worker test
pnpm --filter knowledge test:e2e -- drive-source
~~~
Expected: revoked/moved/deleted and inaccessible shortcuts disappear; failed sync
does not silently broaden access; initial/recovery syncs converge without duplicates.

**Out of scope:** connecting a real company Drive during implementation tests.

## Task 20: Implement explicit typed and voice ticket commands

**Depends on:** 09, 18

**Files:**

- Create: packages/knowledge/src/commands/ticket.ts, command.test.ts
- Create: apps/knowledge-actions/src/server.ts, authorization.ts, ticket.ts
- Modify: ../kanban/backend/app/capture.py, main.py, schemas.py
- Create: ../kanban/backend/app/commands.py
- Create: ../kanban/backend/tests/test_commands.py
- Modify: ../kanban/backend/app/models.py for the source-local command receipt.
- Create: a generated Kanban Alembic revision for command receipts and idempotency.
- Create: apps/knowledge/app/routes/api.transcribe.ts, api.commands.ts
- Create: apps/knowledge/tests/ticket-command.spec.ts
- Copy from: apps/erp/app/modules/agent/ui/AgentInput.tsx for input affordances.

**Steps:**

1. Route an explicit command request to the action service. Query-tool output and
   retrieved document content can never trigger this route by themselves.
2. Transcribe audio using a configured supported STT provider, then parse the same
   versioned command schema as typed input. Keep raw audio out of ordinary logs.
3. Resolve board/column only from the actor's allowed catalog. Replace capture's
   unknown-board/first-column fallbacks and hardcoded confidence with validation
   and measurable ambiguity handling.
4. Add a source-local command receipt table with a unique workspace/actor/action/
   idempotency key and payload hash. Apply its Alembic migration in isolated tests;
   do not try to include the central knowledge command row in a distributed transaction.
5. Authorize create on the exact board immediately before commit. Enforce the
   configured initial column, canonical due date/timezone, actor, and idempotency.
   Commit ticket + activity + Kanban-local receipt + outbox in one DB transaction.
   A lost response is recovered by querying the same source idempotency receipt;
   the central command state reconciles from that authoritative result.
6. Return the created ticket link and effective fields. Ask only for unresolved
   intent/entity/date details; clear authorized ticket creation is executable.
7. Limit stream duration and reauthorize each command. Read-only query identities
   lack invocation rights to this command API.

**Verify:**
~~~bash
make -C ../kanban test-api
pnpm --filter @carbon/knowledge test command
pnpm --filter knowledge-actions test
pnpm --filter knowledge test:e2e -- ticket-command
~~~
Expected: correct board/PENDING/actor/date; unauthorized board and ambiguous identity
fail; simultaneous retries create one ticket; reused key with changed payload fails.

**Out of scope:** arbitrary board administration or purchasing execution.

## Task 21: Add scheduled procurement proposals through Carbon

**Depends on:** 08, 20

**Files:**

- Create: packages/knowledge/src/commands/procurement.ts, procurement.test.ts
- Create: apps/knowledge-actions/src/procurement.ts, scheduled.ts
- Create: apps/erp/app/modules/knowledge/knowledge.commands.server.ts
- Create: apps/erp/app/modules/knowledge/knowledge.commands.test.ts
- Modify: apps/erp/app/modules/purchasing/purchasing.service.ts,
  purchasing.models.ts, and index.ts for createProcurementDraft.
- Create: apps/erp/app/modules/purchasing/procurement-draft.integration.test.ts
- Create: a Carbon migration from pnpm db:migrate:new knowledge-command-receipts.
- Copy from: apps/erp/app/modules/purchasing/purchasing.models.ts,
  purchasing.service.ts, and existing purchase-order review UI.

**Steps:**

1. Add a Carbon-local command receipt with actor/company/action/idempotency key,
   payload hash, and resulting purchase-order ID; uniqueness is enforced in SQL.
   Generate its migration, apply locally, and regenerate types before writing
   dependent typed code.
2. Parse item identity/dimensions separately from quantity and purchase units.
   Separate requestedArrivalDate, proposedOrderByDate, and executeAt. Resolve
   relative dates in the company's timezone and clarify ambiguous date intent.
3. Keep incomplete data in a versioned knowledge proposal. Execution requires
   purchasing-create permission, supplierId, receiving locationId, exact permitted
   item revision, positive quantity, validated purchase/inventory UoM, and a valid
   positive conversion factor. Reuse the unreleased-ECO guard currently in
   apps/erp/app/routes/x+/purchase-order+/$orderId.new.tsx.
4. Implement one canonical createProcurementDraft(db, authorizedContext, input)
   service creating status Draft header, delivery/payment defaults, validated
   lines, source command receipt, and outbox in one real Kysely transaction.
   Factor/reuse the business calculations and validations from insertPurchaseOrder
   and upsertPurchaseOrderLine; those current Supabase helpers cannot simply be
   wrapped and called a transaction. Do not create raw purchase rows in the portal
   or bypass existing sequence, tax/precision, conversion, and revision rules.
5. Expose that operation through the canonical API registry with exact workforce
   capability and current user checks. A lost response is reconciled through the
   Carbon-local idempotency receipt.
6. Persist scheduling as a durable command reference and actor, not a long-lived
   bearer token. At execution recheck user, permission, item revision, approval,
   idempotency, and payload version. Revoked or changed proposals stop.
7. Preserve the boundary between a Draft PO and issuing a purchase commitment.
   Supplier communication remains a separately authorized existing operation.

**Verify:**
~~~bash
pnpm db:migrate
pnpm run generate:types
pnpm run generate:mcp
pnpm --filter @carbon/knowledge test procurement
pnpm --filter knowledge-actions test
pnpm --dir apps/erp exec vitest run app/modules/knowledge/knowledge.commands.test.ts
pnpm --dir apps/erp exec vitest run app/modules/purchasing/procurement-draft.integration.test.ts
~~~
Expected: missing supplier/location or ambiguous size/quantity/date requires
clarification; scheduled execution creates exactly one Draft PO; fault injection
rolls back header/lines/receipt/outbox; revoked permission and unreleased item
revision prevent execution.

**Out of scope:** new MRP logic, payment automation, automatic supplier emails.

## Task 22: Add generic engineering/CRM adapters and optional MCP transport

**Depends on:** 12, 18, 20

**Files:**

- Create: packages/knowledge/src/sources/conformance.ts, conformance.test.ts
- Create: packages/knowledge/src/sources/engineering.example.ts, crm.example.ts
- Create: apps/knowledge-query/src/mcp.ts
- Create: apps/knowledge-actions/src/mcp.ts
- Create: packages/knowledge/src/mcp-parity.test.ts

**Steps:**

1. Add synthetic adapter examples for versioned machine/PCB designs and CRM records.
   Cover immutable design revisions, approved status, units, attachments, customer
   access boundaries, source deletion, and authoritative deep links.
2. Make adapter registration declarative: capabilities, schema version, auth policy,
   supported filters/projections, freshness, pagination, rate limits, and events.
3. Add a reusable conformance suite. Future source apps keep business ownership
   and publish APIs/events; adding an adapter must not require a router rewrite.
4. Expose only reviewed query/command handlers through MCP, with the same identity,
   resource/caller authorization, budgets, and idempotency as HTTP. Keep machine
   authentication compatible with the actual MCP client; browser IAP cookies are
   not an assumed MCP auth protocol.
5. Disable MCP deployment until an intended client passes authentication and
   HTTP/MCP permission parity tests. HTTP remains the primary integration surface.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test conformance mcp-parity
pnpm --filter knowledge-query test
pnpm --filter knowledge-actions test
~~~
Expected: synthetic adapters pass without router code changes; MCP cannot expose
more data or operations than HTTP for the same actor and caller.

**Out of scope:** implementing the future CAD, PCB, or CRM applications themselves.

## Task 23: Add observability, abuse budgets, retention, and recovery

**Depends on:** 15, 17, 18, 20

**Files:**

- Create: packages/knowledge/src/telemetry.ts, redaction.test.ts
- Create: packages/knowledge/src/budgets.server.ts, retention.server.ts
- Create: apps/knowledge-worker/src/retention.ts, recovery.ts
- Create: contrib/deploying/knowledge/monitoring.tf, recovery.md
- Create: contrib/deploying/knowledge/verify_recovery.py

**Steps:**

1. Trace authentication/policy/cache/router/retrieval/source/model stages with
   request IDs. Log decisions and source IDs; redact tokens, raw prompts,
   documents, audio, and PII by default.
2. Add per-user/company/endpoint rate limits, provider concurrency limits, and
   daily token/spend budgets. Use a durable reservation/accounting ledger for
   billable work; cache failure cannot silently allow unbounded inference.
3. Alert on auth failures, index/ACL lag, source outages, model errors, queue age,
   cache leakage test failures, latency, and database connection saturation.
4. Apply retention to conversations, raw intake, derivatives, and audit metadata;
   honor tombstones during index rebuild. Source deletion must not resurrect
   content from an older extraction or delayed event.
5. Back up canonical knowledge records, ACLs, source bindings, and object references.
   Rebuild embeddings from permitted originals. Restore into an isolated environment,
   then prove denied documents remain denied.
6. Document shared-Postgres recovery blast radius and per-app release rollback.
   Never call a shared database restore an isolated app rollback.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test redaction budgets retention
pnpm --filter knowledge-worker test
python3 contrib/deploying/knowledge/verify_recovery.py --synthetic --disposable
~~~
Expected: no secrets/content in standard logs; spend caps survive cache loss;
restoration preserves ACLs/tombstones and yields a rebuildable index.

**Out of scope:** claiming a compliance certification from these controls.

## Task 24: Run acceptance and stage the rollout

**Depends on:** 03–05, 07–23; Task 06 results recorded independently

**Files:**

- Create: packages/knowledge/evaluations/questions.jsonl, attacks.jsonl
- Create: packages/knowledge/scripts/evaluate.ts, verify-security.ts
- Create: packages/knowledge/scripts/verify-deployment.ts
- Create: apps/knowledge/tests/workforce-sso.spec.ts, authorization.spec.ts
- Create: contrib/deploying/knowledge/ROLLOUT.md
- Modify: this plan's progress checklist only when evidence exists.

**Steps:**

1. Run the full synthetic acceptance matrix A01–A15. Measure p50/p95/p99 with
   representative ACLs, cold starts, source failures, concurrency, and data scale.
2. Test prompt injection, forged identities, service-token audience confusion,
   user-evidence replay, CSRF, SSRF, query exhaustion, hidden-result counting,
   cache poisoning, revoked memberships, and inaccessible citations.
3. Verify browser flows using the repository's auth/test workflow where applicable,
   plus the new standalone portal/identity tests. Synthetic staging identities
   must be distinct from real company users.
4. Prove no-op and isolated deployments by comparing pre/post Cloud Run revisions,
   VM container IDs, migration ledgers, and DB uptime. Confirm untouched services
   are not restarted solely because a repo commit changed.
5. Pilot read-only with a small explicitly enrolled source set. Enable intake
   publishing, then Drive, then ticket commands, then procurement drafts only
   after their respective denial/idempotency/freshness gates pass.
6. Keep kill switches per connector, model profile, query path, and command type.
   A command incident disables actions without disabling ordinary source apps.
7. Save real deployment evidence privately. Publish only synthetic results and
   generic implementation documentation; update closest AGENTS/rules after the
   implementation has established durable facts.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge evaluate -- suite=all
pnpm --filter @carbon/knowledge verify:security
pnpm --filter @carbon/knowledge verify:deployment
pnpm --filter knowledge test:e2e
make -C ../kanban test-api
make -C ../kanban test-web
git diff --check
~~~
Expected: all applicable acceptance gates pass with saved evidence; no unsupported
latency, revocation, or security claim is presented as measured success.

**Out of scope:** automatic production publication from a documentation change.

## 4. Implementation contracts

### 4.1 Typed API contracts

All wire schemas reject unknown security-sensitive fields and enforce size limits.
User-provided company selection is validated against current membership; it is
never an authorization claim. IDs are source-qualified, opaque strings.

~~~ts
type HumanPrincipal = {
  kind: "human";
  actorId: string;                  // canonical existing user
  companyId: string;
  callerId: string;                 // verified workload, never request body
  sourceIdentity: { issuer: string; subject: string };
  policyVersion: string;
  capabilities: string[];           // server-derived intersection
};

type MachinePrincipal = {
  kind: "machine";
  callerId: string;                 // verified workload identity
  companyId: string;
  sourceIds: string[];              // administrator-owned machine grants
  policyVersion: string;
  capabilities: ("source.changes.read" | "source.index.read")[];
};

type Principal = HumanPrincipal | MachinePrincipal;

type QueryRequest = {
  requestId: string;
  text: string;
  mode: "locate" | "read" | "auto";
  context?: { source?: string; entityId?: string; conversationId?: string };
  locale: string;
};

type Evidence = {
  id: string;
  sourceId: string;
  entityId?: string;
  documentVersionId?: string;
  sourceRevision: string;
  title: string;
  excerpt?: string;
  page?: number;
  section?: string;
  sourceUri: string;                // resolved through authorization
  observedAt: string;
  effectiveAt?: string;
  policyVersion: string;
  freshness: "current" | "cached" | "partial" | "unavailable";
};

type CommandProposal = {
  id: string;
  version: number;
  action: "kanban.ticket.create" | "carbon.procurement.draft";
  target: { sourceId: string; resourceId: string };
  payload: Record<string, unknown>; // validated action-specific schema
  payloadHash: string;
  idempotencyKey: string;
  executeAt?: string;
  clarification?: { field: string; choices: string[] };
};
~~~

Source methods take a verified Principal and bounded typed arguments:
searchEntities, getEntity, queryFacts, getDocumentReferences, checkAccess,
getChanges. Page responses include items, nextCursor, observedAt, sourceRevision,
and any incomplete-source status. Machine indexing never invents a human actor:
it uses a registered machine grant, records callerId as the audit principal, and
stamps createdBy with an explicitly provisioned automation user only where an
existing database FK requires it. That automation user grants no employee session
or business-command authority. Interactive query and command endpoints require
HumanPrincipal. A count is returned only if the caller may see
the underlying population.

Action payloads are concrete:

- kanban.ticket.create: boardId, initialColumnId, title, description, dueDate,
  businessTimezone, optional authorized assigneeId.
- carbon.procurement.draft: itemId, itemRevision, quantity, purchaseUnitOfMeasureCode,
  supplierId, locationId, requestedArrivalDate, optional proposedOrderByDate,
  and optional executeAt for when draft creation should run. Missing supplier,
  location, or quantity remains a proposal requiring clarification; it is not
  executable. Dates have distinct meanings and cannot substitute for each other.

Actor, company/workspace, approval state, command permissions, and audit fields
are stamped by the server. Business date calculations use @internationalized/date
and existing Carbon timezone helpers, not JavaScript Date arithmetic.

### 4.2 Knowledge schema contract

The SQL implementation lives in independently generated migrations in
packages/knowledge/migrations/. Use the private knowledge schema, not the
committed agent/kb directory. Each table has:

~~~sql
"id" text NOT NULL DEFAULT public.id('k'),
"companyId" text NOT NULL REFERENCES public."company"("id"),
"createdBy" text NOT NULL REFERENCES public."user"("id"),
"createdAt" timestamptz NOT NULL DEFAULT now(),
"updatedBy" text REFERENCES public."user"("id"),
"updatedAt" timestamptz,
PRIMARY KEY ("id", "companyId")
~~~

Use a distinct prefix per table below. Every intra-schema reference is a composite
foreign key with companyId; every FK has an index. All mutable records have a
monotonic bigint version for compare-and-swap. Immutable version/extraction/chunk
records are append-only for ordinary runtime roles. Avoid cascading deletion of
audit or source history; use explicit retention and tombstones.

| Table / prefix | Required additional fields and constraints |
|---|---|
| source / ksrc | kind text constrained to carbon, kanban, drive, upload, engineering, crm; externalId text; displayName text; ownerId text FK user; classification text; providerPolicy jsonb; status active/paused/revoked; contentEpoch bigint; aclEpoch bigint; cursor jsonb; UNIQUE(companyId, kind, externalId) |
| identityBinding / kidn | issuer text; subject text; canonicalUserId text FK user; active boolean; revocationVersion bigint; UNIQUE(companyId, issuer, subject) |
| sourceUserBinding / ksub | sourceId composite FK source; canonicalUserId text FK user; sourceUserId text; active boolean; bindingEvidence jsonb sanitized; UNIQUE(companyId, sourceId, canonicalUserId); UNIQUE(companyId, sourceId, sourceUserId) |
| document / kdoc | sourceId composite FK; sourceItemId text; title text; ownerId FK user; kind manual/procedure/note/specification/design/other; status draft/review/published/withdrawn; classification text; aclVersion bigint; currentVersionId nullable composite FK documentVersion; deletedAt timestamptz; UNIQUE(companyId, sourceId, sourceItemId) |
| documentVersion / kver | documentId composite FK; sourceRevision text; contentHash text; objectKey text; objectGeneration text; MIME text; byteCount bigint nonnegative; extractedTextKey nullable text; observedAt timestamptz; effectiveAt nullable timestamptz; parserVersion text; extractionStatus pending/ready/failed; UNIQUE(companyId, documentId, sourceRevision) |
| chunk / kchk | documentId and documentVersionId composite FKs; ordinal integer nonnegative; text text; heading nullable text; page nullable integer positive; bounds nullable jsonb; parentOrdinal nullable integer; tokenCount integer nonnegative; fts tsvector; embedding vector(768); embeddingProfile text; indexGeneration bigint; UNIQUE(companyId, documentVersionId, ordinal, embeddingProfile) |
| entity / kent | sourceId composite FK; sourceEntityId text; entityType text; sourceRevision text; displayName text; exactIdentifiers jsonb; metadata jsonb limited to approved projection; observedAt timestamptz; deletedAt nullable timestamptz; UNIQUE(companyId, sourceId, entityType, sourceEntityId) |
| entityLink / klnk | entityId composite FK; documentId composite FK; documentVersionId nullable composite FK; relation manual-for/specification-for/used-by/derived-from/related; applicability jsonb with revision/variant/serial/lot constraints; verifiedBy nullable FK user; verifiedAt nullable timestamptz; provenance jsonb; no automatic transitive permission inheritance |
| grant / kgrt | sourceId composite FK; documentId nullable composite FK; entityId nullable composite FK; at most one document/entity target (neither means source scope); subjectKind user/group; subjectId text; capability read/review/publish/admin; origin local/source; sourcePermissionId nullable text; policyVersion bigint; validUntil nullable timestamptz; revokedAt nullable timestamptz; indexed(companyId, subjectKind, subjectId, capability) |
| groupMembership / kgmem | sourceId nullable composite FK for source groups; groupId text with issuer namespace; memberUserId FK user; origin local/source; observedAt timestamptz; validUntil timestamptz; revokedAt nullable timestamptz; policyVersion bigint; UNIQUE(companyId, groupId, memberUserId); indexed(companyId, memberUserId, groupId) |
| intake / kin | sourceId composite FK; ownerId FK user; state captured/extracting/needs-review/ready/failed; inputRefs jsonb; generation bigint; extraction jsonb immutable per generation through extraction records; reviewDecisions jsonb versioned; unresolved jsonb; idempotencyKey text; UNIQUE(companyId, ownerId, idempotencyKey) |
| extraction / kext | intakeId composite FK; generation bigint; providerProfile text; sourceVersions jsonb; output jsonb with field provenance; status complete/failed; UNIQUE(companyId, intakeId, generation); append-only |
| outbox / kout | sourceId composite FK; entityType text; entityId text; sourceVersion text; eventType upsert/delete/acl-change; payload jsonb references only; availableAt timestamptz; deliveredAt nullable timestamptz; attempts integer; UNIQUE(companyId, sourceId, entityType, entityId, sourceVersion, eventType) |
| command / kcmd | actorId FK user; action text constrained to registered commands; targetSourceId composite FK; targetResourceId text; payload jsonb; payloadHash text; proposalVersion bigint; idempotencyKey text; status proposed/needs-clarification/ready/running/succeeded/failed/cancelled; executeAt nullable timestamptz; resultRef nullable jsonb; UNIQUE(companyId, actorId, action, idempotencyKey) |
| conversation / kconv | ownerId FK user; compactState jsonb references only; expiresAt timestamptz; no shared conversation access by default |
| audit / kaud | actorId nullable FK user; callerId text; requestId text; action text; targetRefs jsonb; decision allow/deny/error; policyVersion text; metadata jsonb sanitized; append-only; retention-controlled deletion |

The document/currentVersion cycle is added after both tables exist. Composite
constraints must also ensure a currentVersion belongs to its document, and chunks
belong to the same document as their referenced version. A document-version
reference cannot be retargeted to an unrelated document in the same company.

The initial embedding profile must support 768 dimensions through its documented
API/model configuration. Validate vector length and finite components at admission;
do not silently pad or truncate arbitrary model outputs. A future dimension change
uses a separate index generation/schema migration with dual-read validation.

Schema indexes additionally cover source+sourceItem, exact normalized identifiers,
document status/current version, chunk FTS/vector, source epochs, pending outbox
availableAt, pending commands executeAt, and retention expiresAt. Large JSON
payloads are bounded; file bytes and raw OCR output belong in object storage.

RLS is default-deny. Named SELECT/INSERT/UPDATE/DELETE policies are explicit for
each role/table. knowledge_read has SELECT only on published permitted document
and entity projections; it has no writes, no source secrets, and no command-table
mutation. knowledge_ingest can update source-derived records for its configured
sources but cannot execute business commands. knowledge_review requires a verified
review/publish grant and cannot edit connector credentials. knowledge_actions can
persist command state and audit only. Only knowledge_migrate owns schema/DDL.

Effective access to imported records is the intersection of source permission and
local restrictions; a local grant cannot broaden the source ACL. Entity projections
have the same source-resource checks as documents. Group membership comes from
explicit local administration or verified source-directory synchronization, never
an assumed groups claim in a Google ID token. Unknown/expired group membership
denies access. Parent/shared-drive ACL changes invalidate affected descendants.

Policy helpers use fixed search paths, current verified actor/company, and indexed
membership predicates. Security-definer helpers are narrowly reviewed and not
generally executable. Do not use owner/BYPASSRLS connections in tests purporting
to prove user isolation. Include pooled-connection actor-switch tests.

### 4.3 Release manifest contract

Every deployed unit records unitId, repository, sourceCommit, inputFingerprint,
imageDigest, configContentHash, secretVersionRefs, migrationCompatibility,
deployedRevision, previousHealthyRevision, manifestGeneration, and selectionReason.
Real values live privately. The planner compares against the last successful
manifest, not simply HEAD~1. A no-op does not rebuild, migrate, redeploy, restart,
or advance the manifest's service revision.

Changing a shared package legitimately selects its consumers. “Independent
deployment” means unchanged inputs stay running; it does not mean hiding a real
shared dependency. Frontend and API contracts use additive versioning and
expand/contract migrations so both prior and candidate services can coexist.

## 5. Source grounding and research

Repository facts were read from current source on the date above. Some older
plans/rules describe superseded implementations; re-check source before editing.
No live GCP, Workspace, Supabase, or Drive configuration was inspected.

### Repository references

- R1: apps/erp/app/modules/agent/agent.config.ts and agent.service.ts — existing
  assistant is docs-only, with a 20-step and roughly 25k-token history allowance.
- R2: apps/erp/app/routes/api+/v1+/lib/base.server.ts, authenticate.server.ts,
  call.server.ts — canonical oRPC machinery exists; current HTTP accepts API keys
  and middleware does not universally gate every auth kind by operation.
- R3: contrib/deploying/gcp-tailscale/README.md, deploy.py, host-deploy.sh, render.py
  — private hosting, raw Postgres path, and current full-stack deployment coupling.
- R4: packages/auth/src/services/auth.server.ts, session.server.ts,
  lib/supabase/client.server.ts — existing Supabase UUIDs, cookie/refresh behavior,
  and internally minted user-scoped clients.
- R5: contrib/deploying/gcp-tailscale/auth/google-domain-hook.sql and auth/README.md
  — trusted Google identity/domain checks and local offboarding constraints.
- R6: ../kanban/backend/app/security.py, main.py, capture.py, models.py and
  ../kanban/frontend/app/lib/auth.ts — forwarded identity, account/board gaps,
  capture behavior, and independent browser sessions.
- R7: ../kanban/deploy/cloudbuild.yaml, deploy.sh, Dockerfile.web, api-entrypoint.sh
  — coupled releases, runtime API origin, and existing separate migration job.
- R8: packages/jobs/src/invoice-intake/ and apps/erp/app/modules/invoicing/ui/InvoiceDocuments/
  — reusable extraction, provenance, correction-preservation, and review precedents.
- R9: .ai/plans/2026-09-07-orpc-completion.md,
  .ai/plans/2026-09-06-private-gcp-self-host.md,
  .ai/plans/2026-09-06-shared-private-postgres.md — related work; do not duplicate
  or regress completed changes.

### Primary external sources

- G1: [Choose a Google Cloud resource hierarchy](https://docs.cloud.google.com/architecture/landing-zones/decide-resource-hierarchy)
- G2: [IAM resource hierarchy and inheritance](https://docs.cloud.google.com/iam/docs/resource-hierarchy-access-control)
- G3: [IAP directly on Cloud Run](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run)
- G4: [Google identity product comparison](https://docs.cloud.google.com/docs/authentication/identity-products)
- G5: [Validate signed IAP assertions](https://docs.cloud.google.com/iap/docs/signed-headers-howto)
- G6: [Cloud Run service-to-service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
- G7: [IAP sessions and revocation behavior](https://docs.cloud.google.com/iap/docs/sessions-howto)
- G8: [IAP custom OAuth/programmatic clients](https://docs.cloud.google.com/iap/docs/custom-oauth-configuration)
- G9: [Cloud Run deployments and revisions](https://docs.cloud.google.com/run/docs/deploying)
- G10: [Cloud Build trigger file filters](https://docs.cloud.google.com/build/docs/automating-builds/create-manage-triggers)
- G11: [Cloud Run secret configuration](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- G12: [Google OpenID Connect identity claims](https://developers.google.com/identity/openid-connect/openid-connect)
- G13: [Firebase browser persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- G14: [Firebase user import](https://firebase.google.com/docs/auth/admin/import-users)
- G15: [Firebase session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions)
- S1: [Supabase native OAuth server](https://supabase.com/docs/guides/auth/oauth-server)
- S2: [Supabase OAuth setup and beta status](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- S3: [Supabase OAuth scope/token rules](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- S4: [Pinned GoTrue API implementation](https://github.com/supabase/auth/blob/v2.189.0/internal/api/api.go)
- S5: [Postgres hybrid search](https://supabase.com/docs/guides/ai/hybrid-search)
- S6: [RAG with permissions](https://supabase.com/docs/guides/ai/rag-with-permissions)
- S7: [pgvector filtering and iterative scans](https://github.com/pgvector/pgvector)
- S8: [Additional databases and Supabase services](https://supabase.com/docs/guides/troubleshooting/manually-created-databases-are-not-visible-in-the-supabase-dashboard-4415aa)
- S9: [Supabase Firebase integration](https://supabase.com/docs/guides/auth/third-party/firebase-auth)
- S10: [Pinned GoTrue token signing and refresh](https://github.com/supabase/auth/blob/v2.189.0/internal/tokens/service.go)
- S11: [Pinned GoTrue authentication middleware](https://github.com/supabase/auth/blob/v2.189.0/internal/api/auth.go)
- S12: [Pinned GoTrue user handlers](https://github.com/supabase/auth/blob/v2.189.0/internal/api/user.go)
- S13: [PostgREST JWT audience validation](https://docs.postgrest.org/en/v13/references/auth.html)
- S14: [Supabase OAuth flows and supported scopes](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)
- D1: [Drive authorization scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- D2: [Drive change tracking](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- D3: [Drive sharing and permissions](https://developers.google.com/workspace/drive/api/guides/manage-sharing)
- D4: [Shared Drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)

## 6. Plan completion record

Planning includes source inspection and current primary-documentation research.
Implementation tests, benchmarks, cloud applies, and deployment checks listed above
are future work and have not been run as evidence of system readiness.

Before executing a task, read its closest AGENTS.md and applicable repository rules.
Use the plan's dependency ordering, scoped tests, generated types after migrations,
and per-service release checks. If a pinned API or source assumption proves false,
stop the dependent task and report the concrete mismatch; do not weaken
authorization, change a private ingress boundary, or substitute a broad credential.
