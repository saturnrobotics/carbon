# Knowledge Google Drive connector

**Date:** 2026-09-11
**Scope:** Task 19 of the company knowledge platform plan (§1.6, §1.8, §1.9, D1–D4).
**Base revision:** `feat/knowledge-17-cache-revocation` with `feat/knowledge-16-retrieval-gaps`,
`feat/knowledge-15-carbon-outbox` and `feat/knowledge-13-typed-extraction` merged.
Drive stays deferred from `manual-v1`: nothing here activates under that profile.

## What was found (gap table)

| Plan step | Before | Now |
| --- | --- | --- |
| 1. Explicit enrollment, read-only connector, Secret Manager reference | Missing: a `drive` source row was the whole record; no scope, no credential reference, no live-check scope | `knowledge."driveEnrollment"` (migration `20260911230000_drive-connector.sql`): corpus, shared-drive id, root folders, `oauthScope` CHECK-constrained to `drive.readonly`, `credentialSecretRef` CHECK-constrained to a Secret Manager version path, reader live-check scope, `domainWideDelegation` default false (the worker refuses `true`), notification channel id + token hash, reconciliation cadence, last sync outcome. Runtime roles cannot insert it; the ingest role may update sync outcome columns only |
| 2. No domain-wide delegation; record scope, owner, corpora, eligibility | Partial: owner/eligibility on `source`, nothing else | Recorded on the enrollment; `/v1/drive/sources` and the portal page `/settings/sources` (now registered in `routes.ts`; it was unreachable) show scope, owner, corpora, connector access, live-check scope, eligibility and sync state, never the credential reference |
| 3. Cursors, pagination, native export, shortcuts, deletion, moves, permission changes, periodic full reconciliation, push as hints | Partial: page-token CAS persistence and a raw `changes.list` client existed; no listing, no shortcuts, no moves, no reconciliation, no sync function, no ledger | `knowledge."driveItem"` ledger; `runDriveSync` (initial listing behind a start token, incremental pages, descendant re-evaluation, reconciliation diff when due); `knowledge-drive-sync` Inngest function (event + 5-minute cron, page budget with follow-up event); batched `files.get`/`permissions.list` through the Drive batch endpoint; shortcuts resolved to their target with an intersected ACL; moves recomputed as scope flips in one recursive statement; `/v1/drive/:source/notifications` accepts a channel-verified hint and only schedules the cursor sync |
| 4. Effective ACLs incl. inheritance and groups; exclude or live-check when not evaluable | Partial: a file's own permissions only; unevaluable ACLs were silently empty | Effective permissions come from `permissions.list` (inherited entries included); group principals become group grants that stay unreadable until a membership sync exists (fail closed); `domain`/`anyone` are dropped; an unreadable ACL marks the item `aclEvaluated=false` and it receives no grant |
| 5. Live authorization before reranker/answer/cache delivery | Partial: the query service already called `/v1/drive/…/access`, but the worker had no such route | `handleDriveRoute`: reader's own row policy, the ledger entry, then `files.get` with the reader's delegated token for the file and, for a shortcut, its target; 204 or 403 with no body. Without a delegated token nothing is delivered |
| 6. Parent-folder / shared-drive change invalidates descendants, cached answers, candidate batches | Missing | `listDriveDescendants` (recursive, shortcuts included) feeds a batched re-read; grants are revoked and re-inserted per page; `acl-change` outbox events re-arm delivered identities; proven against real row policies, the real epoch trigger, `AuthorizedCache` and the candidate re-read |
| 7. Same PDF in two drives with different ACLs | Unit-tested on a pure helper only | Integration-tested: two sources, one content hash, two documents, two ACLs, a reader of one never sees the other and cannot list the hidden source |
| Verify: `apps/knowledge/tests/drive-source.spec.ts` | Missing | Written against a new loopback fixture `apps/knowledge-worker/src/test/local-drive.ts`; see "Not run" |

## Decisions

- **Connector output is file-level only.** A source-scoped `origin='source'` grant
  is "read everything in the source" under `has_grant`, so the connector never writes
  one. Shared-drive membership is an administrator statement at enrollment (README
  template); it is also what lets a reader see the source at all.
- **Revocation is a two-layer contract.** The synchronized ACL decides what local
  retrieval can surface; the reader-delegated live check decides what is delivered,
  cached or disclosed. Between a Drive change and the next sync the live check is the
  only gate, which is why it runs with the reader's token and fails closed without one.
- **Recovery state is the cursor alone.** An interrupted first load restarts from the
  listing (upserts are idempotent), descendant re-evaluations commit under the current
  cursor before the page that caused them, and a reconciliation listing never moves
  the cursor. Persisting a page whose cursor no longer matches writes nothing.
- **Revival is an upsert.** A withdrawn document that comes back into scope with the
  same revision returns to `published` (its version and chunks were kept) and its
  delivered upsert event is re-armed by the dedupe key rather than duplicated.
- **A loopback harness seam, not a bypass.** `createDriveAccessChecker` takes an
  optional `forwardingHeaders`; production keeps `createWorkforceForwardingHeaders`.

## Verification (local, synthetic containers `knowledge-t19-test` / `knowledge-t19-cache`, no dev stack)

| Command | Result |
| --- | --- |
| `pnpm --filter @carbon/knowledge test drive` | 2 files, 10 passed |
| `pnpm --filter @carbon/knowledge test:integration drive` | 3 files, 17 passed (`drive.integration.test.ts` is 7 of them: enrollment read, scoped listing + no-op reconciliation, publication visibility, same PDF in two drives, parent-folder revocation of descendants + warm cache + candidate batch, delete/move/inaccessible shortcut + outbox re-arm, failed page changes nothing) |
| `pnpm --filter knowledge-worker test` | 15 files, 47 passed |
| `pnpm --filter knowledge-query test` | 11 files, 33 passed |
| `pnpm --filter knowledge test` | 11 files, 31 passed |
| `pnpm --filter @carbon/knowledge test` (whole package) | 29 files, 163 passed |
| `pnpm --filter @carbon/knowledge test:integration` (whole package) | 39 files, 191 passed |
| `python3 packages/knowledge/scripts/test_schema.py` | 20 passed (forced RLS and audit columns on the two new tables) |
| `pnpm --filter knowledge exec playwright test --list drive-source` | 3 tests listed in 1 file |
| `pnpm exec biome check --error-on-warnings <24 changed files>` | clean |
| `pnpm exec turbo run typecheck --filter=@carbon/knowledge --filter=knowledge-worker --filter=knowledge-query --filter=knowledge` | clean |
| `pnpm --filter @carbon/knowledge migrate:test` + `generate:types` | applied `20260911230000_drive-connector.sql`; 19 tables generated, `database.types.ts` gained the two tables only |
| `pnpm --filter knowledge test:e2e -- drive-source` | not run (see below) |

## Not run

- `pnpm --filter knowledge test:e2e -- drive-source`: the harness binds the fixed
  loopback origins `https://localhost:4200`, `http://127.0.0.1:4301`,
  `http://127.0.0.1:4302` and the database port `59910`, all of which were held by
  another agent's running `knowledge-manual-local-*` stack during this task and must
  not be stopped. The spec is discoverable (`playwright test --list`) and its fixture
  typechecks; running it needs those ports free and
  `corepack pnpm --filter knowledge-worker exec tsx src/test/local-drive.ts` started
  with `KNOWLEDGE_E2E_SYNTHETIC_FIXTURES=1` and `KNOWLEDGE_E2E_DATABASE_URL`.
- Group membership synchronization (Google Directory) and shared-drive membership
  synchronization: documents shared only with a group stay unreadable locally.
- Push channel registration (`changes.watch`) is an operator step; the endpoint
  verifies the enrolled channel and token hash and treats the hint as a hint.

## Follow-up: the settings route had to stay out of the release fence (2026-09-12)

Registering `routes/settings.sources.tsx` in `apps/knowledge/app/routes.ts`
contradicted the fence that the same profile decision is enforced by:
`test_production_web_route_manifest_excludes_deferred_routes` in
`contrib/deploying/knowledge/test_images.py` lists `settings.sources` among the
surfaces `manual-v1` defers, so the branch registered a route its own release
fence declares deferred.

Enabling Drive in the shipped profile is a release decision, so the fence was
kept and the surface made unreachable instead. `routes.ts` is now the production
manifest and names no deferred module; `routes.deferred.ts` holds the entry and
contributes it only when `isDriveSurfaceEnabled`
(`packages/knowledge/src/sources/drive-deployment.ts`) reads
`KNOWLEDGE_DRIVE_ENABLED=true`. Route config is a BUILD-time artifact, so a
release image — built with the variable absent — ships no Drive route in its
bundle at all, which no runtime environment can re-open. `release.py` already
rejects the variable on a revision (any key outside `REQUIRED_ENVIRONMENT` is
deferred configuration) and already pins `knowledge-web` to `manual-v1`; a new
case in `test_images.py` pins both of those so the indirection cannot quietly
become the only thing holding the fence.

Task 22's companion "profile past `manual-v1`" condition is deliberately absent
here. MCP lives in a service that never reads the manual source configuration;
the web app does, and `readManualSourceConfiguration` refuses any other profile,
so four of its routes throw under one. For this surface that condition would
mean "unreachable in every configuration that boots", including the loopback
harness — so the three locks above carry the boundary instead, and the harnesses
(`playwright.config.ts`, `compose.local.yaml`) set the variable so
`drive-source.spec.ts` stays exercisable.

Two findings worth carrying forward:

- `pnpm --filter knowledge build` was already FAILING on this branch, and the
  registered route was why: `DriveSourceList.tsx` is a client component that
  imports `describeProviderEligibility` from `sources.service.ts`, which imports
  `forwardIntakeRequest` from `intake.service.ts`, which imports
  `services/identity.server` — so React Router's `dot-server` plugin refused the
  client graph. Deferring the route makes the default build green, but a build
  with `KNOWLEDGE_DRIVE_ENABLED=true` still fails. The fix is to move the
  client-safe schema and label helper out of `sources.service.ts`; that belongs
  with the page, not with the fence, and is not done here.
- The fence test reads `routes.ts` as TEXT. That makes it cheap and readable, but
  it cannot see a route added through an import, which is why the gate needed its
  own assertions rather than relying on the literal's absence.
