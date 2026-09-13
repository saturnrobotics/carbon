# Verify knowledge reads against an isolated Carbon runtime

This procedure complements the containerized manual-library browser tests. Those
cover intake and downloads; this procedure proves that the real Carbon receiver,
current employee permissions, receipt posting and the query resolver work together.
Use synthetic company data and documents. Keep credentials, process output and
screenshots in ignored `.fork/local/`.

## Own the environment

Read `.fork/agent-policy.md`. Pin the source revision and appoint one Git writer.
Use a new Compose project, fresh volumes, loopback-only unused ports and a unique
`CARBON_WORKTREE`. Never borrow another task's database, Redis or port assignment.
`crbn up` also manages shared Redis and the host's port registry: when these are
outside the task's ownership, construct an isolated Compose file using the pinned
services in `packages/dev/docker/docker-compose.dev.yml` instead.

The required local services are Carbon Postgres, GoTrue, PostgREST, storage, Redis
and ERP. A test-only HTTP path proxy can provide `/auth/v1`, `/rest/v1` and
`/storage/v1` to the unmodified Supabase clients. PostgREST still verifies each
user JWT and enforces RLS. Mint new synthetic local Supabase keys; disable Resend
and provide a synthetic constructor key, because a missing key prevents ERP's
route graph from loading even when sending is disabled.

Apply the complete Carbon migration history to the owned empty database. Use the
installed pinned Supabase CLI, for example through
`pnpm --filter @carbon/database exec supabase migration up --include-all` with an
explicit owned database URL. Local PostgreSQL may require `sslmode=disable`.
Initialize GoTrue and storage before the Carbon migrations that depend on their
schemas. Seed the new database with `pnpm --filter @carbon/database exec tsx
src/seed-dev.ts --email operator@example.com --dataset robotics --skip-wipe`.
The parent process must provide only the owned database and synthetic service URLs.

Co-locate the current knowledge schema with Carbon for this exercise:
`KNOWLEDGE_MIGRATION_DATABASE_URL=<owned-url> pnpm --filter @carbon/knowledge exec
tsx scripts/migrate.ts`. Do not apply `bootstrap-test.sql` over Carbon's real
tables or replace `public.id`. Create a separate inheriting login with only
`knowledge_read` for the query runtime. Enroll the synthetic IAP subject through
`knowledge.enroll_workforce_identity`, using the migration connection; prove the
runtime reader cannot read arbitrary Carbon tables.

## Exercise the real receiver

ERP's deployed `authorizeCarbonWorkforceRequest` uses Google's certificate
endpoints and has no local signing configuration. A loopback experiment may use
an **ignored launcher only** that supplies freshly generated RSA public keys at
`OAuth2Client.getFederatedSignonCertsAsync` and `getIapPublicKeysAsync`. Leave
`verifyIdToken`, `verifySignedJwtWithCertsAsync`, workforce verification, identity
resolution, permissions and route dispatch unchanged. Never ship this launcher,
its signing keys, or an environment option that enables it in a deployed build.

Register the synthetic query caller with the exact ERP audience, IAP audience,
allowed operations, capabilities and required access level. Start the actual ERP
Vite server under that launcher. Send signed requests to the real
`/api/v1/knowledge/*` HTTP routes. Capture statuses and assert bodies; successful
server startup alone is not evidence.

Verify these thirteen attacks against an otherwise successful request:

1. Wrong service audience.
2. Wrong service issuer.
3. Expired service token.
4. Unregistered service subject.
5. Rogue-key service signature claiming the trusted key identifier.
6. Wrong IAP audience.
7. Wrong IAP issuer.
8. Expired IAP assertion.
9. Future IAP assertion.
10. Rogue-key IAP signature claiming the trusted key identifier.
11. Missing required access level.
12. Wrong company.
13. Missing IAP evidence with spoofed user identity headers.

All must return the same ERP `401 Unauthorized`, without hidden identifiers.
Remove the enrolled employee's live `inventory_view` permission: the receipt read
must return 403 immediately. Restore it and require success without clearing a
permission cache. These are separate checks from the token attack matrix.

## Join a real receipt to a reviewed manual

A seeded draft receipt is not posting evidence. Set a received quantity and, for
a tracked line, call Carbon's `update_receipt_line_batch_tracking` with a synthetic
lot. Invoke the unchanged `post-receipt/index.ts` function with `type: "post"`
against the owned stack and verify `Posted` status and the resulting rows. A
Deno import-map wrapper may bind `serve` to the task's unused loopback port; it
must not replace the posting handler or database calls.

Configure both the upload library and a Carbon source. Provision the source's
active `sourceUserBinding` and both local/source grants. A configuration registry
alone does not grant access. Create a reviewed, version-pinned manual-for link
with the exact item id, revision, MPN, manufacturer and lot. Use a current
published document version with a ready chunk and appropriate local read grant.
For the complete upload/extraction/publication/download proof, run the manual
browser workflow; directly seeded reviewed rows establish only the join behavior.

Run the actual `createReadHandler`, with the restricted reader pool and real
Redis, asking for the manual for the recently received synthetic item. In an
ignored local harness, service-token minting can sign with the test service key
and outbound `https://erp.example.com` requests can be routed to the owned ERP
listener. Keep source path allowlisting, JWT verification, real HTTP responses,
request deadlines and runtime query code intact. Assert that the two Carbon
calls occurred and the response names the exact immutable document version.
This is not a mock source adapter.

Require these negative controls in the same integration:

- Other company and unenrolled subject: query 403, no source calls.
- Revoked document grant: no evidence; restoring it restores the result.
- Mismatched item revision and reviewed link: abstention.
- Receipt outside the recent business-calendar window: abstention.
- Canonical user deactivation: query 403 and ERP 401 immediately.
- Reactivation alone: still denied; explicit reenrollment restores access.
- Void through the actual posting function: the receipt no longer selects a manual.

The receipt reader joins `receiptLine.itemId` to its referenced item's revision;
it does not record a separate historical revision snapshot. Carbon's normal
`createRevision` creates a new item id. Mutating the referenced row's revision is
a useful mismatch control, not a simulation of that normal revision workflow.
Do not infer that it silently selects the newest revision of the readable part.

## Recorded proof and limits

At `7e03ef5e2d65577dda5cd3b2463649f46cb12ee0`, an isolated experiment applied
1,016 Carbon migrations and all 38 knowledge migrations, successfully enrolled
against the real identifier helpers, posted and voided actual receipts, and
passed the thirteen receiver attacks plus live permission removal/restoration.
The full query handler passed twelve positive/negative cases, including exact
version evidence, document revocation, business-date filtering and sticky identity
revocation. The query used a separate `knowledge_read` login, actual Redis and
real ERP HTTP calls. No production source or authentication code was changed.

Google certificate delivery, service-account minting, actual IAP/Workspace
assurance, cloud ingress and production rollout were not exercised. The manual
was a seeded synthetic reviewed document, so this experiment does not establish
real corpus relevance, parser quality or its original-file download. Use the
browser workflow for file lifecycle proof and a separately authorized cloud
acceptance exercise for deployment identity. Local RSA verification is not Google
sign-in evidence. Source outbox triggers remain deliberately disabled.

Stop only the owned launcher/proxy/function processes, remove only the owned
Compose project and volumes, and verify the ports and project resources are gone.
Keep concise outcomes public; keep runtime artifacts ignored.
