# Knowledge manual-v1 rollout

How the `manual-v1` knowledge workload is admitted to real use: what a pilot must
prove, which switches turn a capability off without touching the others, how a
release is rolled back, and which evidence is kept. Everything on this page runs
against synthetic fixtures except the section marked **needs the live cloud**.
The acceptance criteria are A01–A15 in the platform plan
(`.fork/plans/2026-09-07-company-knowledge-platform.md` §2).

## 1. Gates and where each one runs

| Gate | Command | Runs locally | Evidence |
|---|---|---|---|
| Acceptance matrix A01–A15 | `pnpm --filter @carbon/knowledge evaluate -- suite=recall` and `-- suite=interactive` | yes; database-backed cases need the labelled disposable PostgreSQL (`KNOWLEDGE_TEST_DATABASE_URL` + `KNOWLEDGE_TEST_DATABASE_DISPOSABLE=1`) and are reported `SKIPPED-NEEDS-DISPOSABLE-DATABASE` without it | JSON report (`--output=`), per-case `PASS`/`FAIL`/`SKIPPED-*` |
| Performance fixture (500 questions, 10 users, 100k logical chunks) | `pnpm --filter @carbon/knowledge evaluate -- suite=performance` (or `suite=all`) | yes; requires the disposable database | p50/p95/p99, errors, Recall@10 per cold/warm path |
| Security attack fixture (19 attacks, 18 classes) | `pnpm --filter @carbon/knowledge verify:security` | yes; `S06`–`S09` and `S17` need the disposable database and `KNOWLEDGE_TEST_CONTAINER` | pass/fail per attack id |
| Deployment no-op and isolation | `pnpm --filter @carbon/knowledge verify:deployment` (self-test), `-- --local --dry-run` (Docker stack), `-- --expected <manifest> --observed <observed> [--previous <observed> --deploy <units>]` | yes | drift per unit, untouched/disturbed per neighbour, ledger head, database start time |
| Browser workflow, sign-in boundary, authorization | `contrib/deploying/knowledge/local-stack.sh test` (runs `manual-workflow`, `workforce-sso` and `authorization` specs) | yes; Docker Compose stack with real parser, PostgreSQL, Redis and Inngest | Playwright report and traces on failure |
| Lifecycle and recovery | `verify-local-lifecycle.sh`, `verify-local-recovery.py --synthetic --disposable` | yes | container ids, object generations, restore comparison |
| Live cloud boundaries | see §5 | **no** | private decision record |

The acceptance cases that cannot run without live systems are reported, never
passed: `A01-google-credential-sign-in`, `A05-document-answer-latency` and
`A06-iap-boundary-overhead` are `SKIPPED-NEEDS-CLOUD`; `A13-ticket-creation-on-kanban`
is `SKIPPED-NEEDS-KANBAN` (the Kanban service lives in its own repository and is
verified by `make -C ../kanban test-api`). Every other criterion has at least one
runnable case.

## 2. Pilot criteria

Admit real documents and a second user only when all of the following hold:

1. The three local gates (`evaluate`, `verify:security`, `local-stack.sh test`)
   pass on the exact commit in the release plan, and `verify:deployment
   --self-test` passes.
2. The live checks in §5 are recorded as proven for the initial tester, with
   synthetic documents only.
3. The pilot source set is explicit: one `upload` source for one company, the
   users enrolled through the README's enrollment transaction, and a bounded
   `knowledge_metering."requestPolicy"` row. There is no default allowance;
   a missing row returns 429.
4. Retention and recovery have run once against the deployed configuration
   (`recovery.md`), and the pre-rollout observation from `verify:deployment` is
   saved privately.
5. Nobody outside the pilot group holds an active `identityBinding`.

Pilot order after read-only manuals: intake publishing, then Drive, then ticket
commands, then procurement drafts — each only after its own denial, idempotency
and freshness gates pass. Today only the manual library is implemented and
released; `release.py` refuses the deferred units and their configuration.

## 3. Kill switches

Every switch below is a **configuration-absence fence** that exists in code
today, or a database row. Turning a capability off never requires a redeploy of
the other units.

### Per feature (portal and services return 503 when unconfigured)

| Capability | Switch | Enforced by |
|---|---|---|
| Manual search | remove `KNOWLEDGE_QUERY_URL`, `KNOWLEDGE_QUERY_AUDIENCE` or `KNOWLEDGE_COMPANY_ID` from the web unit | `apps/knowledge/app/routes/api.query.ts` → `503 query_not_configured`; `apps/knowledge/app/routes/health.ts` reports `not-configured` |
| Query service | remove any of `KNOWLEDGE_BUSINESS_TIMEZONE`, `KNOWLEDGE_PORTAL_ORIGIN`, `KNOWLEDGE_READ_DATABASE_URL`, `KNOWLEDGE_REDIS_URL`, `KNOWLEDGE_TRUSTED_CALLERS_JSON`, `KNOWLEDGE_MANUAL_SOURCE_JSON` | `apps/knowledge-query/src/index.ts` `isQueryReady` → `503 query_not_configured` on every route and `/health` |
| Intake, review, publish, removal, download | remove `KNOWLEDGE_WORKER_URL` or `KNOWLEDGE_WORKER_AUDIENCE` from the web unit | `apps/knowledge/app/modules/intake/intake.service.ts` throws "Knowledge intake is not configured" before any forward |
| Worker (ingestion) | remove any of the review/read/ingest database URLs, `KNOWLEDGE_OBJECT_BUCKET`, `KNOWLEDGE_TRUSTED_CALLERS_JSON`, `KNOWLEDGE_MACHINE_CALLERS_JSON`, `KNOWLEDGE_IDENTITY_URL`, `KNOWLEDGE_IDENTITY_AUDIENCE`, `KNOWLEDGE_AUTOMATION_USER_ID` | `apps/knowledge-worker/src/server.ts` `configuredWorkerDependencies` returns `null` → `503 worker_not_configured` |
| Background extraction | remove `INNGEST_SIGNING_KEY` or the `KNOWLEDGE_PARSER_*` values | `apps/knowledge-worker/src/index.ts` registers no Inngest functions and reports `not-configured` |
| Ticket commands | leave `KNOWLEDGE_ACTIONS_URL` / `KNOWLEDGE_ACTIONS_AUDIENCE` unset (the manual-v1 plan rejects them) | `apps/knowledge/app/routes/api.commands.ts` → `503 ticket_commands_not_configured`; `apps/knowledge-query/src/query.server.ts` → `403 manual_library_is_read_only` for command intents under `manualSourceId` |
| Command proposals and voice | leave query configuration unset for the web unit | `apps/knowledge/app/routes/api.propose-command.ts` → `503 command_proposal_not_configured`; `api.transcribe.ts` follows the same pattern |
| Model synthesis / embeddings | leave `model` / `embedding` configuration absent (manual-v1 never sets them) | `createReadHandler` runs lexical `locate` only; `modelVersion` is `locate-no-model` |
| Drive connector | leave `KNOWLEDGE_DRIVE_TOKEN_BROKER_URL` / `_AUDIENCE` unset | `configuredWorkerDependencies` resolves every Drive token to `null` |
| Any deferred unit or variable | keep it out of the release plan | `release.py` `validate_plan` rejects units outside `UNITS` and any variable outside `REQUIRED_ENVIRONMENT` / `REQUIRED_SECRETS` |
| Wrong release profile | `KNOWLEDGE_RELEASE_PROFILE` other than `manual-v1` | `packages/knowledge/src/release-profile.ts` throws on read |

### Per data scope (rows, no deploy)

| Scope | Switch | Effect |
|---|---|---|
| One user | `UPDATE knowledge."identityBinding" SET active=false` or deactivate the Carbon user / membership | every verified request fails `resolveHuman`; cache hits are re-authorized on delivery (`packages/knowledge/src/cache/cache.server.ts`) |
| One library | `UPDATE knowledge.source SET status='inactive'` | source excluded from retrieval, cache policy snapshot denies (`cache/epochs.server.ts`) |
| One grant | set `"revokedAt"` on the `knowledge."grant"` row | the source ACL epoch advances and warmed results stop (`authorization.spec.ts` proves this in the browser) |
| One document | tombstone through the portal, or `status='withdrawn', "deletedAt"=now()` | removed from search; exact-version download denied |
| One company's traffic | delete or lower its `knowledge_metering."requestPolicy"` row | 429 with `retry-after`, durable without Redis (`scripts/test_request_limits.py`) |

A command incident is contained by the ticket-command fence alone; ordinary
manual search and intake keep their own configuration and keep running.

## 4. Rollback

Rolling back a knowledge unit changes only that Cloud Run revision; it never
rolls back PostgreSQL or Cloud Storage (`recovery.md`).

1. `release.py --apply` stages every service without traffic, probes `/health`
   with an identity token and promotes only a `Ready` revision; a failed probe
   restores the prior revision of that service only.
2. To roll back after promotion, re-run the controller with the previous plan
   (previous immutable image digests and pinned secret versions) and only that
   unit in `deploy`. `select_mutations` refuses a stale `expected_generation`
   and any manually drifted revision, so re-plan first.
3. Prove the rollback was isolated: observe the target before and after and run
   `verify:deployment -- --expected <manifest> --observed <after> --previous
   <before> --deploy <unit>`. Every other unit must report `untouched`, the
   migration ledger head must be unchanged unless `knowledge-schema` was
   selected, and the database start time must be identical.
4. Schema is forward-only: the ledger (`knowledge_migrations.ledger`) refuses a
   changed migration and there is no down path. A rollback that needs schema
   changes is a restore drill, not a redeploy.
5. Locally the same proof is `verify-local-lifecycle.sh`, which updates only the
   portal image and checks that every other container id is unchanged.

## 5. What needs the live cloud

These cannot be proven by any local fixture and are the scope of the
authorization program's restricted production verification task
(`.fork/plans/2026-09-11-knowledge-authorization.md`, Task 11). Local passes do
not stand in for them, and they do not replace the local suites.

- A01: a real Google credential reaching the portal through IAP, first-use
  consent and policy reauthentication reported separately.
- A02 at the edge: an unauthenticated browser, an alternate origin and a
  service-account token with the wrong audience denied by IAP and Cloud Run IAM,
  not only by the application code the local fixture exercises.
- A03 on Cloud Run: same-input `release.py --apply` producing no new revision;
  an ERP-only or web-only change leaving the other revisions, the schema job
  generation and the database uptime untouched (`verify:deployment` with real
  observations).
- A04–A06 end to end: IAP and network latency measured from an employee browser
  and inside the region; the local numbers exclude them by definition.
- A05 document answers: the managed model provider is not configured in
  manual-v1; first-token and completion latency are unmeasured.
- A10/A11 propagation: Google/Drive revocation and IAP session propagation
  timing; local revocation is measured on the PostgreSQL read path only.
- A13: exactly one ticket created on the correct board and column — the Kanban
  service and its audit metadata.
- Parser execution as a Cloud Run job, real GCS generations and permissions,
  private network routes and health-gated promotion.

Record the outcome of each item as proven or unproven in a private decision
record with synthetic identifiers only; that record authorizes admitting company
documents and more users.

## 6. Evidence checklist

Keep real deployment evidence private. Publish only synthetic results.

- [ ] Commit hash of the release plan and the `build_receipt` for each selected image
- [ ] `evaluate -- suite=all` report (`--output=`) with the acceptance summary,
      including the `SKIPPED-*` list, and the performance phases
- [ ] `verify:security` output: 19 attacks passed, `KNOWLEDGE_TEST_CONTAINER` named
- [ ] `local-stack.sh test` Playwright result for the three specs
- [ ] `verify:deployment` self-test, plus `--local --dry-run` observation
- [ ] Pre- and post-rollout observations and the `verify:deployment` isolation
      verdict for the deployed unit(s)
- [ ] Lifecycle and recovery proof outputs (`verify-local-lifecycle.sh`,
      `verify-local-recovery.py`)
- [ ] Enrollment transaction reviewed and applied by a human administrator; the
      `requestPolicy` values chosen
- [ ] §5 decision record: each live boundary marked proven or unproven
- [ ] Kill-switch rehearsal: one feature fence and one row-level switch exercised
      on the target and restored, with the health responses captured
