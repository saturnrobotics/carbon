# Carbon's read contract for HQ's feed canvas

Base: `saturn/main` at `7886e86c74`. Independent of draft PR #84 (the authz
projection): this change reads no `carbon_private` object and needs nothing #84
adds; both only call HQ's `authz.*` functions.

Specification: HQ plan 0012 Step 5 (revised for HQ plan 0014: one shared
Postgres, no copies) and HQ plan 0017. HQ shows each person counts of Carbon's
open sales orders, open purchase orders and active jobs, read live by HQ's API
role `hq_api` through HQ's `security_invoker` views, so Carbon's own tables decide
what `hq_api` sees. HQ's `deploy/data/tenants.sql` (section 8) carries the same
SQL for databases where HQ's roles or `authz` appear after this migration ran.

## Design

- **One guarded, idempotent block** (migration `20261019070224_saturn-hq-feeds.sql`).
  It does nothing unless HQ's roles `hq_api` and `hq_owner`, HQ's functions
  `authz.current_subject()`, `authz.scope(text, text, text)` and
  `authz.covers(text[], text)`, and the six tables exist. Carbon's own local and
  CI stacks have none of HQ's objects and migrate exactly as before.
- **Columns.** `hq_api` may SELECT exactly 21 money-free columns of
  `salesOrder`, `salesOrderLine`, `purchaseOrder`, `purchaseOrderLine`, `job`
  and `company` (`REVOKE ALL` then column grants, so the set is exact). The block
  raises if `hq_api` could read any column in `public` named like money
  (price, cost, rate, total, currency, tax, amount).
- **Rows.** Two FOR SELECT policies TO `hq_api` per table with the same test:
  `view` on `carbon:module.<module>:<companyId>` for the person HQ names in
  `authz.subject`, with Carbon's own module rule (orders: sales, inventory or
  invoicing; purchase orders: purchasing, inventory or invoicing; lines: sales or
  purchasing only; companies: any of the five) and production for jobs (stricter
  than Carbon, which shows jobs to every employee). The permissive policy admits
  those rows; the restrictive one admits nothing else, because Carbon's own
  SELECT policies apply TO PUBLIC and read `request.jwt.claims`, which any
  session can set.
- **Helpers.** Postgres evaluates Carbon's TO PUBLIC policies for `hq_api` too,
  and Carbon's helpers grant PUBLIC no EXECUTE, so every `hq_api` read failed
  until `hq_api` could EXECUTE `get_companies_with_employee_permission(text)`,
  `get_companies_with_employee_role()` and `get_company_groups_for_employee()`.
  They return no company for `hq_api` (no JWT), and the restrictive policy makes
  their answer irrelevant.
- **HQ's view owner.** `hq_owner` gets USAGE on `public`, needed to create the
  views; no table grant.
- Nothing changes for `anon`, `authenticated`, `service_role` or `postgres`.

## Steps

- [x] Migration; it applied as a no-op on a fresh local stack (no HQ roles).
- [x] Regression test `packages/database/supabase/tests/saturn-hq-feeds.test.sql`
      with stand-ins for HQ's roles and `authz` (B4's signatures; the real
      `authz.covers` expression): the guard, idempotence, rows per person and
      module, forged JWT claims, money and write refusals, Carbon's roles
      unchanged. Mutations (restrictive made permissive, a money column, jobs
      widened to sales, the guard removed, an INSERT grant) each fail it.
- [x] `pnpm db:types` with the pinned CLI (2.89.0) leaves the generated types
      unchanged: nothing is added to `public`'s shape.
- [ ] Draft PR into `saturn/main`; operator review (RBAC-adjacent: new grants
      and policies on Carbon tables, for HQ's role only).
- [ ] HQ: the same block in `deploy/data/tenants.sql`, the views (HQ migration
      `0004_feed_views`) and the routes (HQ plan 0012 Step 5).

## Follow-up: USAGE on `public` for `hq_api` (2026-10-19)

On a database where PUBLIC holds no USAGE on `public` (only named roles do), HQ's
invoker functions failed as `hq_api` with "permission denied for schema public":
Postgres checks schema USAGE before any column grant or row policy, and the block
above granted USAGE to `hq_owner` only. Carbon's local stack still grants PUBLIC
USAGE on `public`, so the regression test passed anyway.

- [x] Migration `20261020030112_saturn-hq-feeds-usage.sql`: the same guard, then
      `GRANT USAGE ON SCHEMA public TO hq_api`. The applied migration is unchanged.
- [x] The test revokes PUBLIC's USAGE on `public` in its transaction, shows the
      first migration alone leaving every `hq_api` read denied, and shows the
      follow-up's reads filtered by the policies; `hq_api` holds exactly USAGE
      (no CREATE). Mutations (no grant, guard removed, CREATE added) each fail it.
- [x] Generated types unchanged.
- [x] HQ: the same line in `deploy/data/tenants.sql` section 8 (HQ branch
      `fix/feed-public-usage`), reported by `tenants-check.sql` when missing.

Impact: USAGE lets `hq_api` name objects in `public`; tables stay limited to the
21 columns and the row policies. It also lets `hq_api` run the functions in
`public` that grant EXECUTE to PUBLIC (35 on a fresh stack, 3 SECURITY DEFINER),
the surface `anon` already has through the API; `hq_api` sends no JWT claims.

## Not in this change

Any Carbon UI, API or permission change; kanban's feed (HQ plan 0012 Step 6);
running the block in production (HQ's `make deploy-setup STEP=36-tenants` or
Carbon's next deploy, each on the operator's instruction).
