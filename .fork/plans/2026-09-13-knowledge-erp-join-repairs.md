# Connecting the knowledge platform to Carbon: six repairs

The knowledge platform and Carbon were connected for the first time on
2026-09-13, against a disposable Carbon database seeded with demo data. The
authorization model held: thirteen adversarial cases were refused correctly,
real ERP rows crossed the boundary, and revocation propagated. Six defects stop
the connection being made by configuration on a shipped build. Four are the
connection itself; two are the reasons nobody saw them earlier.

Evidence and the full finding list are in
`.fork/decisions/2026-09-13-knowledge-erp-join.md`.

No task here changes an authorization rule. Where a task touches a posting path
or a release profile, it says so and stops for a decision.

## Task 01: Grant the identifier helpers to the enrollment role

**Depends on:** none

**Files:**

- Modify: a new migration under `packages/knowledge/migrations/`
- Read for precedent: `packages/knowledge/migrations/20260908030917_runtime-id-helper-boundary.sql`

**Steps:**

1. `knowledge."identityBinding"` defaults its primary key to Carbon's shared
   `public.id(text)`, whose body calls `public.uuid_to_base58` and
   `extensions.uuid_generate_v4()`. The boundary migration granted that closure
   to the four roles that existed then. `knowledge_enrollment_owner`, the
   table's only writer, was added later and never granted it, so every
   enrollment fails with `permission denied for schema extensions`.
2. Grant the same closure to that role and to no other, matching the boundary
   migration's shape rather than widening it.
3. Add an assertion that every role able to insert into a knowledge table can
   execute the identifier helpers its defaults reach, so a future role cannot
   repeat this.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge identity:enroll -- --help
pnpm --filter @carbon/knowledge test:integration enrollment policies
~~~
Expected: enrollment succeeds against a database carrying the real
`public.id`, not only against the substituted test one.

**Out of scope:** widening any other role's privileges.

## Task 02: Make the test database use Carbon's real identifier function

**Depends on:** 01

**Files:**

- Modify: `packages/knowledge/scripts/bootstrap-test.sql`
- Modify: `packages/knowledge/scripts/setup-disposable.py`

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
pnpm --filter @carbon/knowledge test:integration
python3 packages/knowledge/scripts/test_schema.py
~~~
Expected: the suites still pass with Task 01 applied and fail without it.

**Out of scope:** changing what any test asserts.

## Task 03: Read the source registry from configuration

**Depends on:** none

**Files:**

- Modify: `apps/knowledge-query/src/index.ts`
- Modify: `contrib/deploying/knowledge/release.py`, `README.md`
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
pnpm --filter knowledge-query test
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_*.py'
~~~
Expected: a service configured with a registry reaches a source; a malformed
registry refuses to start; the release planner accepts the key only for the
query unit.

**Out of scope:** deciding which sources a deployment registers.

## Task 04: Decide whether the released profile may reach Carbon

**Depends on:** 03

**Files:**

- Modify: `apps/knowledge-query/src/query.server.ts`
- Modify: `contrib/deploying/knowledge/README.md`

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
pnpm --filter knowledge-query test
pnpm --filter @carbon/knowledge test query
~~~
Expected: the enabled combination is explicit and covered; the disabled one
refuses in a way that names the profile rather than reporting an outage.

**Out of scope:** enabling any deferred feature.

## Task 05: Give supplier pricing a transport path, and pin the gap class

**Depends on:** 03

**Files:**

- Modify: `packages/knowledge/src/sources/http.server.ts`
- Modify: `packages/knowledge/src/sources/carbon.server.ts`
- Create: a conformance test beside `packages/knowledge/src/sources/conformance.test.ts`

**Steps:**

1. The transport keeps an allowlist of seven permitted Carbon endpoints so that
   retrieved content cannot induce an unexpected call. `getItemSupplierPricing`
   is not among them, and nothing in the platform references it, so the
   capability added for it has no consumer and no route. Calling it returns an
   unregistered-operation refusal.
2. Register the operation and expose it through the Carbon adapter behind its
   existing capability, so a caller holding `knowledge.read.pricing` and the
   purchasing permission can reach it and one holding neither cannot.
3. Add a test that every knowledge operation Carbon publishes is either
   registered in the transport or listed as deliberately excluded with a
   reason. That is the durable fix: the allowlist and the published set drifted
   apart silently, and will again.

**Verify:**
~~~bash
pnpm --filter @carbon/knowledge test sources conformance
pnpm --dir apps/erp exec vitest run app/modules/knowledge
~~~
Expected: pricing is reachable for an authorized caller, refused for an
unauthorized one, and the drift test fails if a published operation is neither
registered nor excluded.

**Out of scope:** changing which operations Carbon publishes.

## Task 06: Make received items resolvable from a real receipt

**Depends on:** none

**Files:**

- Investigate: `apps/erp/app/modules/knowledge/knowledge.service.ts`
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
pnpm --dir apps/erp exec vitest run app/modules/knowledge app/modules/inventory
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
