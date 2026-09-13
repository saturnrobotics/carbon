# Knowledge platform Tasks 01, 11 and 23: foundation polish

Context: `.fork/plans/2026-09-07-company-knowledge-platform.md` Task 01 step 5,
Task 11 step 3 and Task 23 step 3 plus its Verify command. Implemented on
`feat/knowledge-foundation-polish`, branched from
`feat/knowledge-authz-09-cloud-foundation` (`0460ebd936`), offline. All
identifiers in tracked files are synthetic.

## Decisions

- **Base image pins**: `contrib/deploying/knowledge/base-images.json` is the one
  record (`node:22-alpine` by index digest). Each `Dockerfile.*` carries the same
  value as its `ARG NODE_IMAGE` default so a plain `docker build` works, and
  `test_base_image_pins.py` (`base_images.py`) fails on a floating tag, an
  unreviewed `FROM`, or a default that drifts from the record. The build
  scripts pass no override.
- **License boundary**: `verify-license-boundary.py` models the two closures a
  Dockerfile really has. `@carbon/ee` is refused anywhere in the build closure
  (every workspace edge, as turbo prune keeps them); `.ee.` files are checked in
  the production closure only (`dependencies`/`optionalDependencies`, what
  `pnpm deploy --prod` ships). The distinction matters: `@carbon/utils` carries
  `@carbon/database` as a devDependency, whose
  `supabase/functions/lib/sandbox.ee.ts` reaches the builder stage of the query
  and ingest e2e images but not any runtime image. `--image` inspects a built
  image through `docker export` without running it. Shipped stages must copy
  `LICENSE` (and `NOTICE` when one exists) so the license accompanies the code;
  none of the runtime images did before this change.
- **Migration window**: every database unit's plan entry declares
  `migrations.minimum`/`maximum` as bare knowledge migration names, which
  compare as strings because the files are timestamp-prefixed. `release.py`
  refuses a unit whose window excludes the deployed ledger head, requires
  `--schema-ledger` whenever such a unit is selected, admits an empty ledger
  only for `knowledge-schema`, and records the window in the manifest. The
  controller does not read the private listener; the operator exports the
  ledger verbatim and the controller strips the `.sql` suffix the runner writes
  (checked against the local stack's real ledger).
- **Alerts**: three new policies on content-free log metrics. The worker emits
  `lagSeconds` (oldest undelivered outbox row) and `queueSeconds` (oldest
  claimable but unclaimed row) after each company's delivery pass via
  `outboxBacklog` and `createBacklogObserver`; the telemetry allowlist gains
  those two keys and a `security` stage. The cache-leakage policy needs an
  emitter, so the query service runs `verifyCacheIsolation` at start and every
  five minutes: a leak is a `security` error, an isolated store a `security`
  success, an unreachable store a `cache` error, so an outage cannot fire the
  security policy. The latency metric's extractor was corrected from
  `jsonPayload.metrics.durationMs` to the flat `jsonPayload.durationMs` the
  records actually carry.
- **Budgets vitest**: `budgets.server.ts` exposes its pure guards
  (`assertBillableCeiling`, `assertProviderUsage`, `requireBillableSource`) and
  `budgets.test.ts` covers them plus refusal on an unacquired reservation and
  read admission, with the ledger transaction mocked. The ledger arithmetic
  itself stays in `scripts/test_budgets.py` against real PostgreSQL.

## Verified

Offline: `python3 -m unittest discover -s contrib/deploying/knowledge -p
'test_*.py'` (64 tests), `terraform validate`, `ruff check contrib/deploying`,
actionlint on `knowledge-check.yml`, `pnpm --filter @carbon/knowledge test`
(126 tests), `pnpm --filter knowledge-worker test`, the query probe tests,
biome on every changed TypeScript file, and the scoped typecheck. The probe
image was built and passed `--image`; the pre-change query image was refused
for lacking `LICENSE`. Not run: the CI image build of all six production
targets and a cloud apply.
