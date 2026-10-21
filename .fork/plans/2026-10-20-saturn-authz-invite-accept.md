# Invite acceptance writes membership only while HQ manages permissions

Base: `saturn/main` at `91249d344e` (after #89, the membership-only writers).
Specification: HQ plan 0006B (a prerequisite for C3) and the first item of
"Still before enabling" in `2026-10-20-saturn-authz-membership-only.md`.

`acceptInvite` (ERP users module) runs `setUserPermissions` in a `Promise.all`
with the membership writes. `setUserPermissions` selects the invitee's
`userPermission` row, merges in the invite's permissions and upserts the result.
`acceptInvite` rolls the invite back if any of the three writes fails. While
`carbon_private.authz_projection.enabled` is true, the guard rewrites the upsert's
INSERT to the invitee's projection. The ON CONFLICT UPDATE is then a no-op when
the stored row already equals the projection, and is refused (42501) when it
does not yet, within a sync interval of an HQ change. The refusal rolled the
invite back, so the invitee could not join.

## Design

- **`acceptInvite`** (`apps/erp/app/modules/users/users.server.ts`): one read of
  `getPermissionsManagement()` (#89's Node seam, `packages/auth/src/saturn/authz.server.ts`)
  before the `Promise.all`, then `skippedPermissionWrite(authz) ?? setUserPermissions(...)`.
  - While HQ manages permissions, no `userPermission` request is sent (no
    select, no upsert, no claims-cache delete). Activation, `userToCompany`, the
    rollback when a membership write fails and the invite's acceptance are
    upstream's. Permissions arrive with the next projection sync, about a minute
    later.
  - The seam treats `enabled` as managed even before HQ's access URL is set,
    which is right for a write decision. A failed read falls back to upstream,
    and the guard still refuses.
  - While the lock is off, the Supabase requests are upstream's, in the same
    order. The only addition is the status read on the apps' `postgres`
    connection.
- **The notice** (`apps/erp/app/routes/_public+/invite.$code.tsx`). The action's
  success path redirects with the session cookie from `updateCompanySession`, so
  a `flash()` there would write a second `Set-Cookie` for the same cookie and one
  would be lost. The invite page says it before the invitee joins instead:
  - the loader's success return gains `authzManaged`;
  - the page renders `AuthzInviteNotice` (`apps/erp/app/modules/saturn/ui/`),
    styled like the ITAR note: "Your access in Carbon is managed in HQ. After you
    join, it may take a minute to appear.";
  - the page is public, so it never shows HQ's access URL;
  - one message is added to the 13 ERP catalogs.

## Steps

- [x] The hook in `acceptInvite`, the loader field and render line in the invite
      route, `AuthzInviteNotice` in the module barrel, and the catalogs.
- [x] `apps/erp/app/modules/saturn/saturn.invite.test.ts`: the real `acceptInvite`
      and the real invite route (loader and page) against a recording Supabase
      client and a stubbed status read.
      - Lock off: upstream's requests in order, with the merged permissions, and
        the rollback when the upsert fails.
      - Lock on: membership only for each role, with no `userPermission`
        request. This includes a row the guard would refuse (42501) and a lock
        with no access URL yet.
      - A failed read falls back to upstream.
      - The page shows the notice only while managed, and never the access URL.
      - With upstream's `users.server.ts`, 7 of the 13 tests fail; with
        upstream's route, 3 fail.
- [ ] PR into `saturn/main`; operator review.

## Still before enabling (not in this change)

- **Users who are never projected** (customers, suppliers and SAML SSO users;
  see the membership-only plan). Their invites now join, but no permissions
  arrive with the sync, although the notice says access may take a minute.
- **Revocation**: unchanged (see the membership-only plan).
