# Membership-only writers for HQ's permission lock

Base: `saturn/main` at `b8497b5cae` (after #84, the projection and lock).
Specification: HQ plan 0006B B7 ("company creation, the seed and SSO
provisioning write membership only"; membership stays Carbon's, Q4) and the
"Before enabling" list in `2026-10-19-saturn-authz-projection.md`.

While `carbon_private.authz_projection.enabled` is true, #84's guards refuse
every write to `userPermission`, `employeeType` and `employeeTypePermission`
except the projection's. Five flows still wrote them and failed with the guard's
error. Each now writes membership only while the lock is on, reports that
permissions are managed in HQ, and behaves exactly as upstream while it is off.

## Design

- **One narrow writer** (migration `20261020190000_saturn-authz-membership-only.sql`).
  `employee."employeeTypeId"` is NOT NULL, so membership needs a type, and the
  lock refuses every `employeeType` insert. `carbon_private.authz_ensure_system_employee_type(company, 'Admin' | 'Console Operator')`
  returns the company's system type, creating it if missing: protected, named for
  its system type, with no template rows. It raises the projection path's flag
  only around its one INSERT, refuses if anything gave the new type template rows
  in the same statement, and never touches `userPermission`. SECURITY DEFINER,
  owned by the administrator (same section 0 as #84), `search_path=''`, EXECUTE
  for `postgres` only. A type grants nothing: while HQ manages permissions
  `userPermission` holds only HQ's projection.
- **Seams, one per runtime.** `packages/database/supabase/functions/lib/saturn-authz.ts`
  (edge functions; reads the lock in the caller's transaction),
  `packages/auth/src/saturn/authz.server.ts` (Node; the apps' `postgres`
  connection; a failed read falls back to upstream behaviour, and the guard still
  refuses), and `apps/erp/app/modules/saturn/` (#84's module).
- **Company creation and onboarding's restore** (`seed-company`): the Admin type
  through the writer, no template, no `userPermission` grant for the creator;
  `userToCompany`, groups, `employee` and reference data as upstream. The
  response adds `permissions: "managed-in-hq"` and the message.
- **Employee deactivation** (`packages/auth`, all three `deactivate*`): the
  `userPermission` strip is skipped; `userToCompany`, the account row and group
  membership go as upstream; the audit records unchanged permissions; the result
  message points to HQ.
- **Console mode**: Settings → People and the API/MCP gate (after the caller's
  authorization) create the Console Operator type through the writer before
  upstream's `updateConsoleSetting` runs, so it finds the type and inserts
  neither the type nor its template.
- **Company restore**: no change. The in-place restore and the reseed import
  never wipe or load `employeeType`/`employeeTypePermission`, and `userPermission`
  has no company scope; pinned by a test because both load with triggers off.
- **SSO provisioning** (`migrateUserToSso`): the invite's permission merge is
  skipped; the user row, account activation, `userToCompany` and the invite's
  acceptance as upstream; a log line points to HQ.

## Steps

- [x] Migration and the #84 SQL test extended (EXECUTE matrix, owner, section 14);
      six mutations of the writer each fail it.
- [x] Seams and hooks for the five flows; tests per flow, lock on and off
      (`saturn.console.test.ts`, `saturn.gate.test.ts`,
      `packages/auth/src/saturn/authz.server.test.ts`,
      `packages/ee/src/saturn/sso-provisioning.test.ts`,
      `packages/jobs/src/saturn-authz/restore.test.ts`, the Deno test of the edge seam).
- [x] Local stack: seed-company through Kong and the edge runtime (off: Admin
      type with 17 template rows and 68 keys; on and identity-only: type, no
      template, no keys, membership written; upstream's file with the lock on:
      500 and nothing written); `deactivateEmployee` against PostgREST (off:
      company stripped; on: membership removed, permissions untouched).
- [ ] PR into `saturn/main`; operator review.

## Still before enabling (not in this change)

- Invite acceptance (`acceptInvite` → `setUserPermissions`, ERP users module)
  upserts the invite's permissions. The guard turns a synced row into a no-op, so
  it passes silently, but it fails and rolls the invite back when the row is not
  yet the projection (within a sync interval of an HQ change). Done in
  `2026-10-20-saturn-authz-invite-accept.md`: membership only while managed.
- Customers, suppliers and SAML SSO users have no `google`/`keycloak` identity,
  so they are never projected: under the lock their permissions cannot change.
- Deactivation leaves HQ's grant in `userPermission` until HQ revokes it. The
  main RLS helper intersects with `userToCompany`, but `is_claims_admin`,
  `has_any_company_permission` (the `"user"` policy), `get_companies_with_permission`
  and `get_permission_companies` do not; offboarding is HQ's revoke, which the
  result message points to.
