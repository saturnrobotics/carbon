# Carbon's customers for HQ's CRM

Base: `saturn/main` at `7f9a9dc01e`. Specification: HQ plan 0022 §9.3, step A6
(approved 2026-11-10). HQ's CRM links each of its accounts to Carbon's customer
once the buyer exists in the ERP, and its account form lists Carbon's customers
as a picker. HQ's API role `hq_api` reads them live, in this database, through
HQ's own SECURITY INVOKER function `hq.carbon_customers()` (HQ migration
`0007_crm_carbon`), so Carbon's own table decides what `hq_api` sees. HQ never
copies a row and never writes to Carbon.

## Design

The same shape as `2026-10-19-saturn-hq-feeds.md`, for one more table:

- **One guarded, idempotent block** (migration
  `20261111100000_saturn-hq-crm-customers.sql`). It does nothing unless HQ's roles
  `hq_api` and `hq_owner`, HQ's `authz.current_subject()`, `authz.scope(text,
  text, text)` and `authz.covers(text[], text)`, and `public.customer` exist.
  Carbon's own local and CI stacks migrate exactly as before.
- **Columns.** `hq_api` may SELECT exactly `customer.id`, `customer."companyId"`
  and `customer.name` (`REVOKE ALL`, then column grants). `"taxId"` and every
  other column stay unreadable. The block raises if `hq_api` could read any column
  in `public` named like money.
- **Rows.** Two FOR SELECT policies TO `hq_api` with one test: `view` on
  `carbon:module.sales:<companyId>` for the person HQ names in `authz.subject`,
  the same rule as Carbon's own SELECT policy for employees (`sales_view`). The
  permissive one (`hq_api_feed`) admits those rows, the restrictive one
  (`hq_api_feed_only`) nothing else, because Carbon's own policy applies TO
  PUBLIC and reads `request.jwt.claims`, which any session can set.
- **Helpers.** Carbon's SELECT policy on `customer` calls
  `get_companies_with_employee_permission(text)` (already granted by
  `20261019070224`) and `get_customer_ids_with_customer_permission(text)`, so
  `hq_api` gets EXECUTE on the second too. Both are read-only SECURITY DEFINER
  functions answering for `request.jwt.claims`; `hq_api` sends none.
- **Schema.** `hq_owner` and `hq_api` keep the USAGE on `public` the feed
  migrations grant (re-granting is a no-op).
- Nothing changes for `anon`, `authenticated`, `service_role` or `postgres`, and
  nothing is added to `public`'s shape: generated types are unchanged.

## Steps

- [x] Migration. HQ's `deploy/data/tenants.sql` section 10 carries the DO block
      byte for byte (checked when both were written), for databases where HQ's
      roles or `authz` appear after this migration ran.
- [x] Tests (in HQ, where the shared database's shape lives). HQ's CI runs this
      block against `supabase/postgres:15.19.0.006` over HQ's Carbon stand-in
      (`backend/tests/fixtures/carbon/standin.sql`, now with `customer`, its TO
      PUBLIC policy and both helpers):
      - `tests/test_crm_carbon.py`: the owner sees the companies Carbon lets them
        see, a member without HQ's grant sees none, no subject sees none,
        `"taxId"` is refused, and a renamed column answers `feed_schema_drift`;
      - `tests/test_feeds.py`: policies TO `hq_api` only, a second apply changes
        nothing, `tenants-check.sql` reports no deviation, no money column.

      A pgTAP twin of `saturn-hq-feeds.test.sql` must run on a database without
      HQ's roles and was not run here, so none is added.
- [ ] Operator review (RBAC-adjacent: new grants and policies on a Carbon table,
      for HQ's role only), then merge into `saturn/main`.
- [ ] HQ: deploy order `36-tenants` (section 10), then `make deploy` (HQ
      migration 0007 refuses to run until the policies exist).
