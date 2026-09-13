# Workforce identity enrollment and account linking

Task 01 of `.fork/plans/2026-09-11-knowledge-authorization.md`. Base revision:
`saturn/main` at `7464d10347`. All identifiers below are synthetic.

Context: `knowledge."identityBinding"` had `FORCE ROW LEVEL SECURITY` with
`INSERT`/`UPDATE`/`DELETE` policies of `false` for every role, so the only ways to
create a binding were the local e2e fixture's raw INSERT and a hand-run SQL block
in the deployment README. Nothing enforced the IAP subject shape, nothing stopped
an email from being used as a subject, nothing advanced `revocationVersion`.

Decision:

- A dedicated NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT function-owner role
  `knowledge_enrollment_owner` holds `SELECT, INSERT, UPDATE` on the table plus
  its own three permissive policies keyed on `current_user`. The runtime roles'
  `false` policies are untouched, and every runtime role still gets `42501` on a
  direct write.
- `knowledge.enroll_workforce_identity(issuer, subject, company, user, capabilities)`
  and `knowledge.unbind_workforce_identity(issuer, subject, company)` are
  `SECURITY DEFINER`, owned by that role, executable only by `knowledge_migrate`
  and `service_role`; `PUBLIC EXECUTE` is revoked after the ownership transfer.
- Eligibility (existing active user, current membership, active company) is
  read through `public.knowledge_resolve_workforce_identity`, the same
  source-owned resolver the runtime trusts. The direct read is impossible for a
  NOLOGIN owner because `public."user"` RLS is `auth.uid()`-scoped; this mirrors
  `knowledge.actor_active`. The write is made first and the call raises (rolling
  it back) if the resolver does not report a fully active identity.
- Subjects must match `^accounts\.google\.com:[0-9]+$` and may never contain
  `@`. One `(issuer, subject)` may point at one user only, in any company.
  Identical re-enrollment is a no-op; a changed capability set updates the row
  and bumps `version`; `revocationVersion` is `1` on insert and only advances
  through unbind.
- The owner role needs `EXECUTE` on `knowledge.actor_id()` and
  `knowledge.actor_active(text)`: PostgreSQL checks helper execution for the
  runtime `SELECT` policy's OR branch even when the owner's own policy grants the
  row. Found by exercising the real role, exactly as the RLS-helper lesson warns.
- `packages/knowledge/src/enrollment.server.ts` wraps both functions;
  `packages/knowledge/scripts/enroll-identity.ts` (`identity:enroll`) is the
  operator command. It resolves `--user-email` to an id and prints the id it
  binds, accepts `--user-id` when the connection cannot read users, refuses a
  non-local `KNOWLEDGE_MIGRATION_DATABASE_URL` without `--allow-remote` plus an
  interactive confirmation, and prints the subject once, on the confirmation line.
- The local Docker fixture and the worker e2e gateway now enroll through the
  function with IAP-shaped synthetic subjects; the raw INSERTs are gone.

Verification (disposable container `knowledge.disposable=true` on a loopback
port; no developer database touched):

- `pnpm --filter @carbon/knowledge migrate:test` → applied, then `unchanged: true`.
- `python3 packages/knowledge/scripts/test_enrollment.py` → 11 passed through
  real roles (`knowledge_read`/`ingest`/`review`/`actions`/`maintenance`, `anon`,
  `authenticated` denied with 42501; `knowledge_migrate` enrolls, re-enrolls as a
  no-op, updates capabilities, unbinds and re-enrolls; email-shaped and non-IAP
  subjects, empty or malformed capabilities, inactive user, missing membership,
  unknown user, and cross-user subject reuse all refused with the documented
  SQLSTATEs; owner is NOLOGIN, no PUBLIC grantee on either function).
- `pnpm --filter @carbon/knowledge test:integration policies enrollment` → 28 passed.
- `pnpm --filter @carbon/knowledge test enrollment enroll-identity` → 46 passed.
- `contrib/deploying/knowledge/local-stack-fixture.sql` applied twice: same
  binding ids, `version` stays 1, `knowledge_read` resolves the bob subject.
- `identity:enroll` run for real against the disposable database: enrol,
  identical rerun, membership refusal, email-shaped refusal, missing email
  column, and remote-URL refusal behaved as documented.
- `pnpm exec turbo run typecheck --filter=@carbon/knowledge --filter=knowledge-worker`.

Not run: the full Docker browser workflow (`local-stack.sh test`); the running
`knowledge-manual-local` stack belongs to someone else and was not touched. The
fixture SQL it applies was proven on the disposable database instead.
