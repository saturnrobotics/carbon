# Connecting the portal platform to Carbon: six repairs

**Status (2026-09-13):** All six repair implementations and the denial-status
addendum are merged in [PR #56](https://github.com/saturnrobotics/carbon/pull/56),
`7e03ef5e2d`. The original diagnosis and task instructions below are historical;
do not implement them again. Deployment and representative Carbon-connected
acceptance remain separate gates.

| Task | Integrated change | Recorded evidence and limit |
| --- | --- | --- |
| 01–02 | PR #50 grants the enrollment role's identifier-helper closure and installs Carbon's real helper in the disposable fixture. | #56 records enrollment/integration suites and three cold browser runs using that helper. Live deployment enrollment is not proven. |
| 03–04 | PR #53 reads and validates the source registry and explicitly permits configured Carbon structured reads alongside manual search. | Configuration/profile tests and browser checks in #56; the [source-registry decision](../decisions/2026-09-13-portal-query-source-registry.md) records the release choice and empty-company-source limitation. |
| 05 | PR #52 adds supplier-pricing transport and published-operation drift tests. | See [pricing transport decision](../decisions/2026-09-13-portal-pricing-transport.md) and #56's combined suites. |
| 06 | PR #54 resolves items directly from posted receipt lines, without changing receipt posting or ledger history. | #56 records module tests, dataset/backup checks and regeneration; exercise the full receipt-to-manual path against representative Carbon receipts separately. |
| Denial addendum | PR #49 and #55 classify query, gateway and item-search refusals. | #56's merged suite caught and repaired a source-registry test mock hiding the newly imported error class. |

PR #56 reports 15 successful checks and 24 browser tests passing on each of three
cold runs. These are prior integration results, not a fresh execution by this
status reconciliation. Some broader ERP/actions suites in that PR had skipped
tests; they must not be described as complete behavioral acceptance.

The portal platform and Carbon were connected for the first time on
2026-09-13, against a disposable Carbon database seeded with demo data. The
authorization model held: thirteen adversarial cases were refused correctly,
real ERP rows crossed the boundary, and revocation propagated. Six defects stop
the connection being made by configuration on a shipped build. Four are the
connection itself; two are the reasons nobody saw them earlier.

The originally cited `2026-09-13-portal-erp-join.md` decision file is absent
from this revision. The available integrated repair evidence is in PR #56 and
the owning decision records linked above; do not treat a missing record as
independent proof of the original exercise.

No task here changes an authorization rule. Where a task touches a posting path
or a release profile, it says so and stops for a decision.

## Task 01: Grant the identifier helpers to the enrollment role

**Depends on:** none

**Files:**

- Modify: a new migration under `packages/portal/migrations/`
- Read for precedent: `packages/portal/migrations/20260908030917_runtime-id-helper-boundary.sql`

**Steps:**

1. `portal."identityBinding"` defaults its primary key to Carbon's shared
   `public.id(text)`, whose body calls `public.uuid_to_base58` and
   `extensions.uuid_generate_v4()`. The boundary migration granted that closure
   to the four roles that existed then. `portal_enrollment_owner`, the
   table's only writer, was added later and never granted it, so every
   enrollment fails with `permission denied for schema extensions`.
2. Grant the same closure to that role and to no other, matching the boundary
   migration's shape rather than widening it.
3. Add an assertion that every role able to insert into a portal table can
   execute the identifier helpers its defaults reach, so a future role cannot
   repeat this.

**Verify:**
~~~bash
pnpm --filter @carbon/portal identity:enroll -- --help
pnpm --filter @carbon/portal test:integration enrollment policies
~~~
Expected: enrollment succeeds against a database carrying the real
`public.id`, not only against the substituted test one.

**Out of scope:** widening any other role's privileges.

## Task 02: Make the test database use Carbon's real identifier function

**Depends on:** 01

**Files:**

- Modify: `packages/portal/scripts/bootstrap-test.sql`
- Modify: `packages/portal/scripts/setup-disposable.py`

**Steps:**

1. The bootstrap replaces `public.id` with a `gen_random_uuid()` stand-in that
   needs no grants. That substitution is why Task 01's defect passed every
   suite. Install the real function and its dependencies instead, so the tests
   exercise the privilege boundary they claim to.
2. If installing the real closure is genuinely impractical in a bare test
   database, keep the stand-in but make it require the same grants, so the
   privilege shape is preserved even when the implementation is not.
3. Re-run the enrollment suites with Task 01 reverted and confirm they now fail.

**Verify:**
~~~bash
pnpm --filter @carbon/portal test:integration
python3 packages/portal/scripts/test_schema.py
~~~
Expected: the suites still pass with Task 01 applied and fail without it.

**Out of scope:** changing what any test asserts.

## Task 03: Read the source registry from configuration

**Depends on:** none

**Files:**

- Modify: `apps/portal-query/src/index.ts`
- Modify: `contrib/deploying/portal/release.py`, `README.md`
- Create: a configuration test beside the service's existing ones

**Steps:**

1. `createItemSearchHandler` and `createReadHandler` are both constructed
   without `sources`, and no configuration value maps to a source registry, so
   a deployed service cannot be told that a Carbon ERP exists. Only test code
   supplies one.
2. Add one configuration input carrying the registry, following the two
   registries the service already reads this way, and validate it with the
   existing schema at start-up. Refuse to boot on a malformed registry rather
   than starting without sources, which would look like an empty corpus.
3. Require HTTPS origins and reject credentials embedded in an origin, matching
   the fetch policy already applied to acquired URLs.
4. Admit the new key in the release planner, which refuses unknown environment
   keys on a revision, and document it.

**Verify:**
~~~bash
pnpm --filter portal-query test
python3 -m unittest discover -s contrib/deploying/portal -p 'test_*.py'
~~~
Expected: a service configured with a registry reaches a source; a malformed
registry refuses to start; the release planner accepts the key only for the
query unit.

**Out of scope:** deciding which sources a deployment registers.

## Task 04: Decide whether the released profile may reach Carbon

**Depends on:** 03

**Files:**

- Modify: `apps/portal-query/src/query.server.ts`
- Modify: `contrib/deploying/portal/README.md`

**Steps:**

1. `createReadHandler` enables the structured source path only when a registry
   is present and no manual source is configured. The manual source is required
   configuration, so on the released profile the structured path is
   unreachable and item search is the only route to Carbon.
2. This is a release decision, not a defect. Either the profile keeps the
   structured path off, in which case say so in the documentation and stop
   treating the Carbon read path as available, or the two coexist with the
   manual path still primary.
3. Whichever is chosen, make the condition state its intent directly rather
   than deriving it from the presence of another setting, so a future reader
   cannot mistake a coincidence for a rule.

**Verify:**
~~~bash
pnpm --filter portal-query test
pnpm --filter @carbon/portal test query
~~~
Expected: the enabled combination is explicit and covered; the disabled one
refuses in a way that names the profile rather than reporting an outage.

**Out of scope:** enabling any deferred feature.

## Task 05: Give supplier pricing a transport path, and pin the gap class

**Depends on:** 03

**Files:**

- Modify: `packages/portal/src/sources/http.server.ts`
- Modify: `packages/portal/src/sources/carbon.server.ts`
- Create: a conformance test beside `packages/portal/src/sources/conformance.test.ts`

**Steps:**

1. The transport keeps an allowlist of seven permitted Carbon endpoints so that
   retrieved content cannot induce an unexpected call. `getItemSupplierPricing`
   is not among them, and nothing in the platform references it, so the
   capability added for it has no consumer and no route. Calling it returns an
   unregistered-operation refusal.
2. Register the operation and expose it through the Carbon adapter behind its
   existing capability, so a caller holding `portal.read.pricing` and the
   purchasing permission can reach it and one holding neither cannot.
3. Add a test that every portal operation Carbon publishes is either
   registered in the transport or listed as deliberately excluded with a
   reason. That is the durable fix: the allowlist and the published set drifted
   apart silently, and will again.

**Verify:**
~~~bash
pnpm --filter @carbon/portal test sources conformance
pnpm --dir apps/erp exec vitest run app/modules/portal
~~~
Expected: pricing is reachable for an authorized caller, refused for an
unauthorized one, and the drift test fails if a published operation is neither
registered nor excluded.

**Out of scope:** changing which operations Carbon publishes.

## Task 06: Make received items resolvable from a real receipt

**Depends on:** none

**Files:**

- Investigate: `apps/erp/app/modules/portal/portal.service.ts`
- Investigate: `packages/database/supabase/functions/post-receipt/index.ts`
- Read for contrast: `packages/database/supabase/functions/issue/index.ts`

**Steps:**

1. `getRecentReceiptItems` finds the items behind recent receipt lines by
   reading inventory ledger entries keyed on the receipt line they came from.
   Receipt posting never records that key; only issuing does. So for a
   genuinely posted receipt the lookup is empty, the operation reports itself
   incomplete, and the manual resolver refuses. This is the plan's flagship
   scenario and it cannot complete today.
2. **Establish first whether the ledger hop is necessary.** A receipt line
   already names its item, and the receipts read is already restricted to
   posted receipts. If the ledger adds nothing the caller needs, read the lines
   and delete the hop: no posting path changes and no historical data is
   affected. Prefer this.
3. If the ledger genuinely carries something required, such as the quantity
   that actually landed or a tracked entity, then record the line key during
   receipt posting, matching how issuing already does it, and treat historical
   rows explicitly: either backfill them or make the reader tolerate their
   absence rather than reporting incomplete.
4. Changing a posting path is a change to core ERP behaviour. Do not make it
   without stating the blast radius and stopping for a decision.

**Verify:**
~~~bash
pnpm --dir apps/erp exec vitest run app/modules/portal app/modules/inventory
pnpm db:check:datasets
pnpm db:check:backups
~~~
Expected: a receipt posted through Carbon's own path resolves to its items, and
a receipt posted before any change still resolves or degrades honestly.

**Out of scope:** new inventory behaviour; anything that rewrites existing
ledger history without a stated migration.

## Sequencing

Tasks 01 and 02 come first: until enrollment works and the tests exercise the
real privilege boundary, nothing else can be verified in the arrangement a
deployment uses. Task 03 unblocks 04 and 05. Task 06 is independent and is the
one that decides whether the product's headline scenario works at all, so start
its investigation early even though its fix may land last.

A seventh, smaller item is recorded here rather than given a task: the item
search path reports authorization failures as a service outage, the same defect
already corrected in the query path and the portal gateway. It belongs as an
addendum to that change.
