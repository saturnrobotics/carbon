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

## Follow-up: the client boundary (2026-09-12)

The first finding above is closed. `apps/knowledge/app/modules/sources/sources.models.ts`
now holds `driveSourceSchema`, `driveSourceListSchema`, `DriveSource` and
`describeProviderEligibility`; the page and the service each import it directly and
the service re-exports none of it, so no barrel hop re-creates the chain. The
service keeps only `listDriveSources` / `requestDriveSourceSync`, the two functions
that legitimately reach `services/identity.server`. A graph walk over
`apps/knowledge/app/modules/**` found no other component reaching a `.server`
module — the three routes that import a service do so from loaders and actions,
which React Router strips from the client build.

Two guards, both of which reproduce the failure and clear on the fix:
`sources.models.test.tsx` reads its own module as text and asserts `zod` is the
only import, and `knowledge-check.yml`'s build step now runs
`KNOWLEDGE_DRIVE_ENABLED=true pnpm --filter knowledge build` ahead of the turbo
build. That second command deliberately bypasses turbo — the `build` task declares
no `env`, so a turbo invocation would hash identically to the flag-off run and
serve its artifact from cache, proving nothing.

`apps/knowledge` is not in `@carbon/checks`'s `TYPESCRIPT_ROOTS`, and adding it
would not have caught this: `no-db-client-in-service` is a per-file text scan for
connection-construction primitives, and nothing here constructs one. The boundary
guard already existed in React Router's `dot-server` plugin; what was missing was a
build that exercised it.

Also worth recording: `compose.local.yaml` sets `KNOWLEDGE_DRIVE_ENABLED` as a
container RUNTIME variable, but `Dockerfile.web` builds with it absent. Route
config is a build-time artifact, so the docker harness's web image contains no
Drive route regardless — `drive-source.spec.ts` is exercisable only through the
Playwright `webServer` path, which sets the variable before `react-router dev`.

## Follow-up: the spec has now been run (2026-09-12)

`drive-source.spec.ts` is green in the containerised harness — 3 passed, twice in
a row against the same stack. Four things stood between it and a first run, and
only the first is the one the previous follow-up predicted.

**The build-time gate.** The harness's web image now takes the surface as a build
argument: `Dockerfile.web`'s `e2e` stage declares `ARG KNOWLEDGE_DRIVE_ENABLED`
and rebuilds the app with it, and `build-images.sh e2e` passes `true` for the
`web` unit only. The argument is declared in that stage and nowhere else, so the
release `runtime` stage — which descends from `builder` — cannot receive it:
building the release target WITH `--build-arg KNOWLEDGE_DRIVE_ENABLED=true` still
produces a bundle with no Drive route, which is a stronger fence than "no release
path passes it". `test_images.py` pins that structurally by parsing the
Dockerfile into stages rather than searching its text, and the new case also
asserts `cloudbuild.yaml` passes no build argument and selects no target (so it
builds `runtime`), and that `build-images.sh`'s release loop passes none.

The runtime variable in `compose.local.yaml` is kept, and is no longer the only
thing holding the surface open: the `e2e` image serves through `react-router dev`,
which re-reads the manifest at boot, so the two now agree instead of the image
silently lacking what its environment claims.

**The fixture was not in the image.** `Dockerfile.ingest`'s `e2e-builder` bundled
`local-ingest.ts` and `local-query.ts` only, so `local-drive.js` did not exist in
any container.

**Two fixtures, one database, one portal.** The manual library's query fixture is
constructed with `manualSourceId`, which filters sources to `kind='upload'` — it
can never return Drive evidence — and its gateway's caller configuration admits
no `knowledge.read` operation, so it answers no Drive route either. The Drive
fixture therefore runs as its own `drive` Compose service on its own two ports,
and the manual gateway forwards `/v1/drive/*` to it (`KNOWLEDGE_E2E_DRIVE_FIXTURE_URL`,
absent by default) so the portal keeps ONE worker URL, as production has.
The two coexist in one database because every row the Drive fixture writes is
scoped to its own `sourceId` — with one exception: `knowledge."identityBinding"`
is unique per `(companyId, issuer, subject)` and the stack fixture already binds
the same reader with a superset of these capabilities, so the Drive seed is now
`ON CONFLICT DO NOTHING`. Claiming that row instead would have downgraded the
manual workflow's reader.

**The seed was one-shot.** The spec's `afterAll` deletes the enrollment, which
only process start recreated — so the suite passed once and then found no
enrollment on every later run. There is now a `POST /__e2e/drive/reset` control
(re-seed plus an in-memory Drive `restore()`, since the spec revokes a folder and
a repeat run must start granted and uncursored) and the spec calls it in
`beforeAll`.

Two spec corrections, neither weakening what it proves:

- `evidenceTitles("alice")` asserted a 200. The loopback stack deliberately binds
  no company-b identity for alice — `manual-workflow.spec.ts` depends on that for
  its cross-tenant assertions — so the read handler refuses her outright and the
  status is 503, not 200. The assertion is now "not 200, and no evidence", with
  the grant-layer twin left where it works: alice reaches `/settings/sources` and
  sees the empty state, which is a real ACL result rather than an identity error.
- The "Reconcile now" refusal asserted `getByRole("status")` count 0 immediately
  after the click, which passes before the submission lands. It now waits for the
  POST response first, so the absent confirmation is a refusal.

## Follow-up: harness ports are parameterised (2026-09-12)

The harness pinned whole origins by string equality, which made "loopback only"
and "port 4200" the same decision and left a second stack no way to move a port
without dropping the guarantee. `apps/knowledge/tests/loopback.ts` now owns that
check — loopback host, expected scheme, no credentials, no path/query/fragment —
and the port is free. `compose.local.yaml`, `local-stack.sh` and
`build-images.sh` take the project name, image prefix, image tag and every
published port from environment variables that default to the historical values,
so an unparameterised invocation resolves byte-for-byte as before (verified with
`docker compose config`). `vite.e2e.config.ts` reads its port and origin from
`KNOWLEDGE_E2E_PORT` / `KNOWLEDGE_WEB_ORIGIN`; a published port that differed
from the container's would otherwise have made Vite advertise assets on the
wrong origin.

`playwright.config.ts` also sets `workers: 1`. Spec FILES ran in parallel by
default, and `manual-workflow.spec.ts` deactivates the shared reader mid-run
(`/__e2e/revoke/bob`) — a database-wide mutation that no other spec can survive
concurrently.

## Follow-up: `manual-workflow.spec.ts` is red for its own reasons (2026-09-12)

Running the suite surfaced two defects in the OTHER spec, both predating this
work and both invisible while the suite was never run. The first is fixed here
because nothing else could run past it; the second is diagnosed and left.

1. **Fixed.** `getByLabel("Source evidence")` matched two elements. `getByLabel`
   is a case-insensitive SUBSTRING match, and `7da6001bf2` (typed intake
   proposals) added "Confirm this field against the source evidence." inside
   every unresolved field's own `<label>` — after `7482e0ce19` wrote the spec.
   Unresolved fields are the review page's normal first state (the spec fills
   them), so this was ambiguous on every run. The three call sites now address
   the panel by role: `getByRole("complementary", { name: "Source evidence" })`.
2. **Not fixed — hand-off.** The browser download of a just-published manual
   answers `{"error":"document_not_found"}`, from
   `apps/knowledge-worker/src/server.ts:394`, i.e. `getAuthorizedDocumentVersion`
   returns null. The row data satisfies that query's WHERE clause — verified in
   the live fixture: `status='published'`, `currentVersionId` set,
   `extractionStatus='ready'`, `kind='upload'`, not deleted — so the row is being
   removed by the read role's ACL. The published document has NO document-scoped
   grant; the only grant covering it is the fixture's source-scoped `admin`
   (`documentId IS NULL`), which the retrieval path accepts (the spec's search
   and cache assertions pass) and this one apparently does not. So either publish
   should write a document grant or the two paths disagree about a source-scoped
   grant. The spec then hangs on `waitForEvent("download")` for a download that
   can never arrive, so a wrong answer costs the full 180 s test timeout rather
   than failing on the response status. Reproduced identically with
   `drive-source.spec.ts` excluded from the run, on a freshly wiped database.
