# Carbon side of HQ's central authz service (projection receiver and lock)

Base: `feat/saturn-hq-sign-in` at `113171c7e6` (draft PR #82), because the
token hook it changes (`auth/google-domain-hook.sql`) is that branch's version.
Merge after #82.

RBAC change approved by the operator on 2026-10-18: "Central authz replaces it",
"make it happen", "use the repo rules for code contribution". Specification: HQ
plan 0006B (B7 projection and locks, B8 the token claim) and plan 0017 step 7.

HQ's `hq-authz` becomes the source of truth for Carbon's permissions. Carbon's
readers (`get_claims` and its Redis cache, the RLS helpers, edge functions)
keep reading `userPermission`; only the writers change. Everything is off until
the operator sets `carbon_private.authz_projection.enabled` after HQ's seed
gate passes.

## Design

- **Receiver** (migration `20261018214537_saturn-authz-projection.sql`, schema
  `carbon_private`, never exposed to PostgREST). `authz_projection_sync()` sets
  every workforce user's row (a `google` or `keycloak` identity) to
  `authz.carbon_permissions(authz.subject_of_auth_user(<user>))`, validated
  against Carbon's module catalog (explicit company ids, no `"0"`), sorted and
  de-duplicated, writing only rows that differ. Unknown or disabled people get
  `{}`; customers, suppliers and console operators are never projected. No
  payload crosses a wire.
- **Readers for authz.** `authz_modules()`, `authz_memberships()`,
  `authz_user_permissions()` and `authz_employee_type_permissions()` (the last
  two return Carbon's tables exactly as stored, for authz's seed and C3 gate),
  so authz needs no SELECT grant on `public`. `authz_api` gets only the
  membership and status readers.
- **Owners.** The migration runs as the session's superuser
  (`supabase_admin`): the Supabase CLI applies migrations under
  `SET SESSION ROLE postgres`, which can neither create objects in the
  administrator's existing `carbon_private` nor should own the lock's state.
  It switches back at the end. The three functions that call `authz.*` belong to
  the NOLOGIN, memberless role `carbon_authz_applier`, so authz code never runs
  with the administrator's privileges. The only writer of `userPermission`
  while the lock is on, `authz_write_permissions`, is executable by that role
  alone.
- **Lock.** Guard triggers on `userPermission`, `employeeType` and
  `employeeTypePermission` refuse every other change with SQLSTATE 42501. The
  projection path's flag is a row keyed on the transaction id in a table only
  the writer function can insert into: a session GUC would be forgeable by any
  connection. Deletes pass (they never grant access and cascade from deleting
  users and companies); a new `userPermission` row is written as the projection;
  an upsert that leaves a row unchanged passes.
- **Cache.** Every projection write queues the user; the Inngest job
  `saturn-authz-projection` (every minute) runs the sync, deletes
  `permissions:<uid>` for queued users, as `updatePermissions` does, and
  acknowledges entries only after Redis confirms, by sequence number.
- **Screens and API.** The employee, bulk-edit and employee-type routes render
  the current permissions read-only with a link to `<HQ origin>/admin/access`
  and refuse their actions; the API gate refuses the four `users_*EmployeeType*`
  operations for MCP, the agent and `/api/v1`. All read the flag from the
  database.
- **Token hook.** A top-level `authz_api` claim from
  `authz.capabilities(subject, 'api')`; no token for an unknown or disabled
  subject; an incoming `authz_api` is always dropped.

## Steps

- [x] Migration, guards and EXECUTE matrix; regression test on a migrated local
      database, with mutation checks that each guard, grant and rule is load-bearing.
- [x] Inngest job with Redis invalidation and its tests.
- [x] ERP module, five route hooks, API gate hook; route, gate and view tests.
- [x] Token hook claim; hook suite fails on the old hook and passes on the new one.
- [x] Stored-permission readers for authz's seed and gate; verified in the
      deployment's order (HQ roles, then the hook SQL, then the pinned CLI).
- [ ] Draft PR into `saturn/main` after #82; operator review.
- [ ] HQ: `authz` schema, the grants in the migration header (also in HQ's
      tenant provisioning), seed and C3 gate (HQ plan 0006B steps 1-3).
- [ ] Before enabling: make company creation, the seed's identity layer,
      employee deactivation, console mode, company restore and SSO provisioning
      write membership only (each fails with the guard's error while enabled).
- [ ] Enable, then verify on the tailnet: a grant at HQ reaches `get_claims`
      within a minute and a revoke removes it (HQ plan 0006B step 6).

## Follow-up: an identities reader for authz (2026-10-20)

HQ's seed read `auth.identities` through a column grant to `authz_owner`, and
`authz.subject_of_auth_user` did the same. GoTrue's `auth.identities` has row
level security on and no policy, so both read zero rows without an error: on HQ's
shared database the seed skipped every Carbon user (each has a `google`
identity), and once enabled `authz_projection_for` would have given every person
`{}`.

- [x] Migration `20261020154924_saturn-authz-identities.sql`:
      `carbon_private.authz_identities() -> (user_id, provider, provider_id)`, the
      `google` and `keycloak` identities only, ordered; SECURITY DEFINER, STABLE,
      `search_path=''`, owned by the administrator (section 0 as above), no PUBLIC
      EXECUTE. A guarded block grants EXECUTE (and USAGE on `carbon_private`) to
      `authz_owner` alone; HQ's `deploy/data/tenants.sql` carries it verbatim.
      Idempotent; the applied migrations are unchanged.
- [x] Regression test `packages/database/supabase/tests/saturn-authz-identities.test.sql`:
      the exact signature and shape; only the owner holds EXECUTE without HQ's
      roles; with stand-ins, the re-run grants `authz_owner` (and its member
      `authz_migrator`) and refuses `authz_api`, `anon`, `authenticated`,
      `service_role`, `postgres`, `supabase_auth_admin` and the applier; under
      forced row level security a column grant reads nothing while the reader
      returns the rows. Mutations (invoker, no provider filter, no revoke,
      `authz_api` granted, guard removed, no `search_path`, an extra column,
      unordered) each fail it. The #84 test counts 19 functions and lists the
      reader in its matrices.
- [x] Generated types unchanged.
- [x] HQ: the seed reads identities only through the reader (a `google` or
      `keycloak` identity, which must agree when both exist), authz migration
      `0002` makes `authz.subject_of_auth_user` call it, and `tenants.sql` revokes
      the retired column grant (HQ branch `fix/authz-identities-reader`).

## Not in this change

Kong's per-route claim check and `GOTRUE_JWT_EXP` (HQ plan 0006B step 7);
adding the locked tools to the static MCP blocklist (they refuse at call time
instead, so behaviour is unchanged until enabled); `authz.changes_since`
(the sync re-applies everyone each minute, which also catches a grant made
before the person's identity was linked).
