# Emergency revocation and deactivation propagation

Task 02 of `.fork/plans/2026-09-11-knowledge-authorization.md`. Base: branch
`feat/knowledge-authz-01-enrollment` at `9869cb58c1`. All identifiers below are
synthetic.

Context: `knowledge."identityBinding"."revocationVersion"` is folded into every
principal's `policyVersion` and into the answer-cache policy snapshot, but after
Task 01 only `knowledge.unbind_workforce_identity` advanced it. Deactivating a
Carbon user or removing a company membership was refused by the resolver checks
on the next request, yet left the binding active with its version unchanged,
and there was no operator command for an emergency.

Decision:

- Carbon migration `20260911211525_knowledge-identity-revocation.sql` installs
  `public.knowledge_propagate_identity_revocation()` (SECURITY DEFINER, owned by
  `knowledge_enrollment_owner`, no PUBLIC or runtime-role EXECUTE) and two
  triggers: `AFTER UPDATE OF active ON public."user"` guarded by
  `WHEN (COALESCE(OLD.active,false) AND NOT COALESCE(NEW.active,false))`, and
  `AFTER DELETE ON public."userToCompany"`. Each sets `active=false` and
  advances `revocationVersion` (and `version`, for `knowledge.check_version`)
  on every binding of the user -- all companies on deactivation, one company on
  membership removal -- even when the binding was already inactive, matching the
  unbind rule. Re-activating the user never re-enables a binding.
- The guard is at fire time, not install time. The documented order applies
  Carbon migrations before the private knowledge migrations, so an install-time
  `IF EXISTS` on the knowledge schema would silently skip the triggers on every
  fresh install. The function returns before touching anything while
  `knowledge."identityBinding"` does not exist; the owner role is created here
  when absent (same NOLOGIN/NOBYPASSRLS shape as Task 01), and its grants and
  RLS policies still come only from the knowledge enrollment migration. A
  binding table without those grants makes the trigger raise `42501` with a
  message naming the missing migration rather than skip.
- Supabase applies migrations as a non-superuser, so the ownership hand-over
  uses a temporary membership in the owner role plus a temporary `CREATE` on
  `public`, both removed at the end; the Python proof asserts no member of the
  owner role and no CREATE privilege survive.
- `app.sync_in_progress` is deliberately not honoured: any session can set that
  GUC, and a revocation must not be suppressible. Backup restore, template
  revert and the dataset wipe never delete `userToCompany` rows, so the trigger
  does not fire in those flows.
- No bump on `userPermission` edits: `permissionsVersion` already changes on
  every write (proved by `test_permission_edit_changes_permissions_version_but_not_revocation`).
- `packages/knowledge/scripts/revoke-identity.ts` (`identity:revoke`) revokes
  one subject in one company, or every binding of one user (`--user-id` or
  `--user-email`, optional `--company`), through `unbind_workforce_identity`.
  Listing a user's bindings runs under `SET ROLE knowledge_migrate` because the
  binding SELECT policy keys on `current_user`; a login that cannot set that
  role is told to pass `--iap-subject`. It prints one `revocationVersion=<n>`
  line per binding and nothing else identifying. Remote URLs need
  `--allow-remote` plus the interactive `revoke` confirmation. Shared helpers
  (`resolveUserId`, `describeError`, `promptConfirmation`, `createConnection`)
  are exported from `enroll-identity.ts` rather than duplicated.
- The disposable fixture (`scripts/setup-disposable.py`) applies the Carbon
  migration after the knowledge migrations and grants the vitest login
  EXECUTE on the fixture mutator so the real deactivation trigger can be driven
  from a non-superuser connection inside one rolled-back transaction.

Verification (private disposable container `knowledge-authz02-test`, label
`knowledge.disposable=true`, loopback port 59970; the worktree's own
`crbn up --no-apps --minimal --no-portless` stack for the Carbon checks):

- `python3 packages/knowledge/scripts/test_revocation.py` -> 8 passed: owner,
  SECURITY DEFINER, no grantee, no owner-role member; deactivation revokes all
  bindings in every company and reactivation does not restore them; the
  `authenticated` role fires the trigger through the fixture mutator with no
  EXECUTE grant; membership removal revokes one company only; unrelated user
  updates leave bindings untouched; permission edits change
  `permissionsVersion` only; unbind and the triggers both empty the reader's
  policy snapshot (the exact `cache/epochs.server.ts` predicate under
  `knowledge_read`); the migration re-applies idempotently.
- `pnpm --filter @carbon/knowledge test:integration revocation policies enrollment`
  -> 35 passed, including the disposable-PostgreSQL case that warms an
  `AuthorizedCache`, admits a valid assertion through `verifyWorkforceRequest`
  with the real resolver, then shows the unbind path refusing the subject and
  recomputing under a new policy version, and the deactivation trigger refusing
  delivery on the policy read alone (`revocationVersion` 3, no recompute).
- `pnpm --filter @carbon/knowledge test enrollment enroll-identity revoke-identity revocation`
  -> 67 passed (`revocation.test.ts` drives `currentPolicySnapshot`,
  `AuthorizedCache` and `verifyWorkforceRequest` with doubles for all three
  revocation paths).
- `pnpm --filter @carbon/knowledge migrate:test` -> `unchanged: true`.
- `pnpm db:migrate` against the live stack -> applied (the first attempt found
  the non-superuser ownership transfer, fixed as above). `pnpm run generate:types`
  and `pnpm generate:swagger` -> no diff. `pnpm db:check:datasets` -> 4 datasets
  apply; `pnpm db:check:backups` -> restorable, manifest unchanged.
- `pnpm --dir apps/erp exec vitest run app/modules/knowledge/knowledge.read.integration.test.ts`
  -> 2 passed (left unchanged: the revoked-principal cases already live in
  `identity.test.ts` and the new `revocation.test.ts`).
- `pnpm exec turbo run typecheck --filter=@carbon/knowledge --filter=@carbon/database`
  -> clean. Biome checks the `src/` files and `package.json`;
  `packages/knowledge/scripts/**` is outside Biome's configured includes
  (pre-existing, Task 01's CLI too), so the three scripts were formatted
  through Biome's stdin path and diff-verified instead.

Not done: a knowledge-side migration cannot install these triggers (the schema
login has no TRIGGER privilege on Carbon tables), so the fire-time guard is the
only way both apply orders end up working. The standalone `crbn migrate`
postgres-only path cannot apply Carbon's early `storage.buckets` migration on a
fresh volume (the storage service creates that schema); the services boot was
used instead.
