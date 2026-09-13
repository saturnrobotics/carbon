# Knowledge platform authorization program

**Date:** 2026-09-11
**Status (2026-09-13):** Carbon Tasks 01–07, 09 and 10 have merged implementations
and recorded local verification. Task 08 belongs to the separate Kanban
repository; its deployed cutover is unproven here. Task 11 remains unexecuted.
See §4 for evidence and remaining acceptance boundaries.
**Base revision:** `saturn/main` at `7464d10347` (after PR #7 and PR #8).
**Refines:** Tasks 05, 07, 08, 09 and the provider-eligibility invariant (§1.9.1)
of `2026-09-07-company-knowledge-platform.md`. That plan's §1.2 (managed Google
first), §1.4 (trusted-forwarder contract) and §1.9 (security invariants) remain
the design; this document replaces the four tasks' step lists with what is
actually left to do, based on a code audit of `saturn/main` on 2026-09-11.
**Repositories:** Carbon at the repository root; Kanban at `../kanban`.

Every read feature of the knowledge platform beyond manual-v1 depends on this
program: structured reads of ERP and Kanban data (platform plan Task 12), the
receipt-to-manual resolver, vector search and synthesis (Tasks 16–18) and the
Drive connector (Task 19) all take a verified `Principal` and a provider policy
as inputs. Nothing here changes what manual-v1 already does; every task keeps
the local Docker workflow green.

All examples are synthetic. Real project IDs, audiences, subjects, group names
and credentials belong in `contrib/deploying/knowledge/.local/`,
`contrib/deploying/gcp-tailscale/.local/`, `../kanban/.env` and the deployment
secret stores, never in tracked files. Evidence goes to `.fork/decisions/`.

## 1. Historical audit at the original base revision

The audit is the reason this plan is shorter than the original four tasks. Cited
lines and missing-code findings are as of the base revision, not current trunk.
They are preserved as the rationale for the tasks; §4 supersedes their status.

| Area | Present and tested | Missing or unverified |
|---|---|---|
| Two-assertion contract (§1.4) | `packages/knowledge/src/identity.server.ts:258-363` verifies the service ID token against the receiver audience and the IAP assertion against the caller's registered `sourceIapAudience`, using `google-auth-library` with key caching and single-flight refresh (`:184-249`). Spoofable identity headers are rejected (`:19-24`). Unit suite `identity.test.ts` covers wrong audience, unregistered subject, expiry, future-dated, overlong lifetime, missing access level, forged headers, fresh-header construction. | No test drives `GoogleWorkforceTokenVerifier` against a real signature; every assertion-level test injects a stub. `contrib/deploying/knowledge/callers.schema.json` is validated by nothing. A failed workforce auth in ERP throws `Error`, surfaced as HTTP 500 rather than 401 (`apps/erp/app/routes/api+/v1+/lib/authenticate.server.ts:75-106`). |
| Canonical user resolution | `knowledge_resolve_workforce_identity` (`packages/database/supabase/migrations/20260908005300_…sql:35-88`) keys on `(issuer, subject, companyId)`; no email column is read. Unknown subject ⇒ unauthorized. Store implementations in `packages/auth/src/services/workforce.server.ts:67-88`, `packages/knowledge/src/identity-store.server.ts`, and a remote store that re-checks issuer/subject/company (`identity.server.ts:486-546`). | **No way to create a binding.** `knowledge."identityBinding"` has `FORCE ROW LEVEL SECURITY` with INSERT/UPDATE/DELETE `false` for every role (`packages/knowledge/migrations/20260908000245_knowledge-foundation.sql:397-408`); the only writers are the local e2e fixture and the README's hand-run SQL. |
| Active state, membership, revocation | Binding, user, membership and company active flags are all required (`identity.server.ts:330-338`; resolver `:55-56`). `revocationVersion` exists (foundation `:47`), is folded into `policyVersion` (`identity.server.ts:351`) and the cache epoch (`packages/knowledge/src/cache/epochs.server.ts:14,32`). | **Nothing increments `revocationVersion`.** No route, job, RPC or runbook step; it is a constant `1`. No trigger ties Carbon user deactivation or membership removal to it. |
| Sessions | Per-request host-only cookies named `carbon-erp` / `carbon-mes`, no `domain`, `secure` decoupled from `DOMAIN`; `expireLegacyAuthCookie` emitted from both callbacks (`packages/auth/src/services/session.server.ts`, +86/−18 vs upstream; `workforce-session.test.ts`). | A host that matches neither `ERP_URL` nor `MES_URL` silently falls back to the shared `carbon` cookie name. |
| Auto-Google entry path | `?workforce=google` triggers `signInWithOAuth` only when Google is the sole provider; PKCE, callback validation, company selection and the MFA gate are upstream's, untouched (`apps/erp/app/routes/_public+/login.tsx`, `apps/mes/…/login.tsx`). | No test of the trigger, the single-provider precondition, `redirectTo` preservation, or that `/mfa` still gates the route. |
| Required assurance (MFA) | — | **Absent.** The delegated path never consults `userHasVerifiedTotpFactor`, `companySettings.requireMfa` or `mfaVerified`; assurance is inferred from the IAP signature plus `google.access_levels`, which §1.2 forbids. |
| Logging | `identity.server.ts` has no log calls; telemetry is a positive allowlist (`packages/knowledge/src/telemetry.ts:41-80`); forwarded headers are rebuilt from scratch (`identity.server.ts:418-450`). | — |
| Carbon canonical read API | `workforce` auth kind (`authenticate.server.ts:75-106`); `assertWorkforceAuthorization` applies caller `allowedOperations` ∩ capabilities AND the user's fresh permissions containing `companyId` (`base.server.ts:70-98`); knowledge module operations are reachable only on the workforce kind (`base.server.ts:106-109`). Six reads plus one write in `apps/erp/app/modules/knowledge/knowledge.service.ts`; every read is user-scoped and `.eq("companyId", …)` from context; validators are `.strict()`. Registry, generator module list, permission overrides and manifest (1562 tools, 16 modules) are wired. | `KNOWLEDGE_READ_OPERATIONS` (`knowledge.server.ts:1-8`) is an unreferenced duplicate of `WORKFORCE_CAPABILITIES` (`base.server.ts:60-68`). Price fields are excluded by a string constant with no separate permission and no test. No test that api-key, oauth or session callers get `NOT_FOUND`; no `callOperation` (MCP path) test for a knowledge op; no cross-company middleware test; no restricted-field assertion. Knowledge tools are disclosed in MCP `search_tools` and the public OpenAPI document. ERP has no deployment wiring for `KNOWLEDGE_TRUSTED_CALLERS_JSON` (`packages/auth/src/services/workforce.server.ts:90-105` throws without it; only `contrib/deploying/knowledge/release.py:19-21` sets it, for the knowledge services). No `AGENTS.md` for the module. |
| Kanban authorization | Code-complete: workforce path with two assertions and a caller registry (`../kanban/backend/app/security.py:49-68`, `workforce.py:67-100`); no implicit admission — unbound subjects get 403 (`authorization.py:37-80`); schema for `external_identity_bindings`, `users.is_active`, `board_memberships` with view/create/update, `command_receipts` (`migrations/versions/64c6e3f658e1_…py`); board filtering in every list, ticket, column, capture, knowledge, product and command handler; `actor_id` stamped on activities (`services.py:190-211`); `tests/test_authorization.py` and `test_workforce.py`. | **Not deployed.** No deploy artifact sets `KANBAN_WORKFORCE_REQUIRED`, `KANBAN_SERVICE_AUDIENCE`, `KANBAN_SOURCE_IAP_AUDIENCE`, `KANBAN_WORKFORCE_CALLERS`; `deploy/gcp-setup.sh` has no IAP integration. The legacy `KANBAN_API_TOKEN` + forwarded-email path is the default mode. The migration backfills board memberships but deliberately creates no identity bindings, so after cutover nobody can sign in until bindings are provisioned, and there is no provisioning path. `authorization.py:74-75` still selects a hard-coded demo user when no binding and no authenticated email exist (test mode only). `POST /api/users` creates principals without bindings. `product.py:513,853` take `author_id`/`uploader_id` from the payload rather than the principal. |
| Cloud identity foundation | Terraform declares seven service accounts with no keys, a conditioned release-controller role, secret containers with a per-identity access matrix, least-privilege invokers for parser and retention jobs, a private bucket, dedicated Redis, monitoring, and IAP on the synthetic probe with a Workspace-group binding (`contrib/deploying/knowledge/identity.tf`, `services.tf`, `storage.tf`, `redis.tf`, `monitoring.tf`). `test_infrastructure.py` is static substring assertion. | No backend/state configuration. IAP exists only on the probe; no IAP client/brand resource; per-service audiences exist only as release-controller env vars. No Cloud Run IAM invoker grants for web→query, web→actions, ingest→query. `var.private_source_cidrs` is declared and unused: no firewall, NAT or peering toward the Carbon VM. No cloud environment has ever been provisioned (`contrib/deploying/knowledge/README.md:174`). |
| Provider eligibility (§1.9.1) | The decision record reports "provider policy checks" implemented in the query path. | Not audited in this pass; Task 10 below verifies it before vector search or synthesis can be enabled. |
| OAuth alternative | `contrib/deploying/gcp-tailscale/auth/oauth-evaluation/RESULTS.md`: native Supabase OAuth delegation **failed** its isolation gate (read tokens reach RPC, privileged function and GoTrue mutation surfaces; HS256 only). | Closed question. Do not reopen; the IAP + trusted-forwarder baseline stands. |

## 2. Invariants every task must keep

1. Email is an attribute, never identity. Bindings key on `(issuer, subject, companyId)`.
2. An IAP signature proves admission, not assurance. Carbon MFA requirements are enforced or explicitly mapped; never inferred.
3. Read credentials cannot write. `knowledge_read` stays `NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`; new functions name their callers (`20260908012959_knowledge-function-execution-boundary.sql` revoked `PUBLIC EXECUTE` by default).
4. Forced RLS applies to table owners and `SECURITY DEFINER` functions alike (`.fork/lessons/2026-09-08-imported-security-definer-does-not-bypass-forced-row-security-for-a-table-owner.md`). Administrative writes need a dedicated function-owner role with explicit grants and their own policies, tested through the real caller role.
5. Exercise every runtime role against every helper referenced by an applicable policy (`…-exercise-each-runtime-role-against-every-helper-in-an-applicable-rls-policy.md`); mocked processors do not count.
6. Assertions never reach logs, durable queues or third hops. Forwarding headers are always rebuilt.
7. Fail closed: unconfigured receivers refuse; policy-store loss denies.
8. No task resets a developer database. Schema work runs in disposable databases (`packages/knowledge/scripts/setup-disposable.py`, `pnpm --filter @carbon/knowledge migrate:test`).
9. Local integration proof and managed-cloud proof are separate (`…-separate-local-integration-proof-from-managed-cloud-configuration-proof.md`). Each task states which one it delivers.

## 3. Progress and order

These checkboxes represent full task acceptance. Implementation progress and
recorded local checks are tracked separately in §4; an unchecked task must not
be interpreted as absent code or an instruction to reimplement it.

- [ ] Task 01: Workforce identity enrollment and account linking (Carbon).
- [ ] Task 02: Emergency revocation and deactivation propagation.
- [ ] Task 03: Required assurance for delegated access.
- [ ] Task 04: Prove the verifier against real signatures; validate the caller registry.
- [ ] Task 05: Carbon receiver deployment wiring and error semantics.
- [ ] Task 06: Session and entry-path verification.
- [ ] Task 07: Complete the Carbon canonical read gate.
- [ ] Task 08: Kanban workforce cutover.
- [ ] Task 09: Cloud identity foundation completion.
- [ ] Task 10: Provider-eligibility policy verification.
- [ ] Task 11: Restricted production verification (the platform plan's open gate).

Dependency graph: 01 → 02 → 03; 04 is independent; 05 needs 01 (there is
nothing to enroll otherwise); 06 is independent; 07 needs 03 and 05; 08 needs 01's
Kanban half (its own enrollment) and 09's IAP output; 09 is independent until its
last step; 10 is independent; 11 needs everything else. Tasks 01, 04, 06, 09 and
10 can start in parallel.

Each task is one reviewable PR into `saturn/main` through the normal gates. Fork
records for a task go in `.fork/decisions/{date}-{slug}.md`; raw evidence in
ignored `.fork/local/`.

---

## Task 01: Workforce identity enrollment and account linking (Carbon)

**Depends on:** none

**Files:**

- Create: `packages/knowledge/migrations/<generated>_workforce-identity-enrollment.sql` via `pnpm --filter @carbon/knowledge migration:new workforce-identity-enrollment`
- Create: `packages/knowledge/scripts/enroll-identity.ts`, `enroll-identity.test.ts`
- Create: `packages/knowledge/src/enrollment.server.ts`, `enrollment.test.ts`
- Modify: `packages/knowledge/src/policies.integration.test.ts` — enrollment role cases
- Modify: `packages/knowledge/package.json` — script `identity:enroll`
- Modify: `contrib/deploying/knowledge/README.md` §"Database and library enrollment" — replace the hand-run SQL with the script
- Modify: `contrib/deploying/knowledge/local-stack-fixture.sql` — call the function instead of raw INSERT
- Copy from (precedent): `20260908005300_knowledge-workforce-identity-resolver.sql` for role checks and grant style; `.fork/lessons/…security-definer…` for the owner-role pattern

**Steps:**

1. Add a NOLOGIN, NOBYPASSRLS function-owner role `knowledge_enrollment_owner`
   with explicit `INSERT, UPDATE` on `knowledge."identityBinding"` and its own
   RLS policies scoped to that role. Do not widen the existing `false` policies for
   runtime roles.
2. Create `knowledge.enroll_workforce_identity(p_issuer text, p_subject text,
   p_company_id text, p_user_id text, p_capabilities text[])` as `SECURITY
   DEFINER` owned by that role, `SET search_path = pg_catalog, public, knowledge`.
   It must: require an existing active `public."user"` with an active
   `userToCompany` row for `p_company_id`; reject `p_subject` that contains `@`
   or does not match the IAP subject shape (`^accounts.google.com:\d+$`) — email
   is never a subject; reject a subject already bound to a different user in the
   same issuer (linking is explicit, never a merge); be idempotent for an identical
   `(issuer, subject, companyId, userId)`; and set `revocationVersion` to 1 only on
   first insert. Return the binding row as jsonb. `REVOKE EXECUTE FROM PUBLIC`;
   grant only `knowledge_migrate` and `service_role`.
3. Create `knowledge.unbind_workforce_identity(p_issuer, p_subject, p_company_id)`
   with the same ownership, setting `bindingActive = false` and incrementing
   `revocationVersion` (Task 02 reuses this).
4. Write `enrollment.server.ts` with typed wrappers over the two functions using
   the `knowledge_migrate` connection, and `scripts/enroll-identity.ts`, a CLI that
   takes `--company`, `--user-email` (a lookup hint only; it resolves to the user
   id and prints the id it will bind), `--iap-subject`, `--capabilities`, refuses
   non-local database URLs unless `--allow-remote` with a confirmation prompt, and
   never prints the subject back in logs beyond the confirmation line.
5. Policy tests through real roles: `knowledge_read` cannot execute either
   function; `knowledge_migrate` can; an inactive user or missing membership is
   rejected; duplicate subject across users is rejected; email-shaped subject is
   rejected; re-running with identical input is a no-op.
6. Update the README: enrollment is the script, the raw SQL block is deleted, and
   the "never auto-enroll an assertion observed at runtime" rule stays.

**Verify:**
```bash
pnpm --filter @carbon/knowledge migrate:test
pnpm --filter @carbon/knowledge test:integration policies enrollment
pnpm --filter @carbon/knowledge test enrollment enroll-identity
# Expected: restricted-role executes fail with permission denied; the migrate role
# enrolls, re-enrolls idempotently, and cannot bind an email-shaped subject.
```

**Out of scope:** a settings UI in Carbon for enrollment; automatic provisioning
from Workspace group membership; touching `public."user"` or `userToCompany`.

## Task 02: Emergency revocation and deactivation propagation

**Depends on:** 01

**Files:**

- Create: `packages/database/supabase/migrations/<generated>_knowledge-identity-revocation.sql` via `pnpm db:migrate:new knowledge-identity-revocation`
- Create: `packages/knowledge/scripts/revoke-identity.ts`, `revoke-identity.test.ts`
- Modify: `packages/knowledge/src/cache/revocation.integration.test.ts` — trigger cases
- Modify: `apps/erp/app/modules/knowledge/knowledge.read.integration.test.ts` — revoked principal cases
- Modify: `contrib/deploying/knowledge/README.md` — "Emergency disablement" section
- Copy from (precedent): the `unbind_workforce_identity` function from Task 01

**Steps:**

1. In the Carbon migration, add `AFTER UPDATE OF active ON public."user"` and
   `AFTER DELETE ON public."userToCompany"` triggers that call a
   `SECURITY DEFINER` function owned by the Task 01 owner role which increments
   `revocationVersion` and sets `bindingActive = false` on every
   `knowledge."identityBinding"` for that user (and company, for the membership
   case). Guard with `IF EXISTS` on the knowledge schema so the migration applies on
   installs without the knowledge platform.
2. Bump `revocationVersion` also on `UPDATE OF permissions ON public."userPermission"`?
   No: `permissionsVersion` already changes (`md5(permissions)` in the resolver),
   so permission edits invalidate cached principals without this task. Document
   that in the migration comment; do not add a second mechanism.
3. `scripts/revoke-identity.ts`: operator command for emergency disablement of one
   subject or all bindings of one user, calling `unbind_workforce_identity`. It
   prints the resulting `revocationVersion` and nothing else identifying.
4. Verify the cache contract end to end: with a warmed answer cache and a valid IAP
   assertion, revoking the binding makes the next request fail before delivery
   (`cache/epochs.server.ts` reads the new version; `identity.server.ts:330-338`
   rejects the inactive binding). Add the deactivation-trigger path to
   `revocation.integration.test.ts`.
5. Record the propagation budget in the README: local revocation is immediate on
   the next request; Workspace suspension and IAP propagation are separate and not
   promised (platform plan §1.8).

**Verify:**
```bash
pnpm db:migrate && pnpm run generate:types
pnpm --filter @carbon/knowledge test:integration revocation
pnpm --dir apps/erp exec vitest run app/modules/knowledge/knowledge.read.integration.test.ts
pnpm db:check:datasets && pnpm db:check:backups
# Expected: deactivating the user or deleting the membership bumps the version and
# the warmed request is denied; datasets and backup baseline still apply.
```

**Out of scope:** instantaneous global logout claims; changing Carbon's own session
revocation.

## Task 03: Required assurance for delegated access

**Depends on:** 01

**Files:**

- Modify: `packages/knowledge/src/identity.server.ts` — `Principal.assurance`, caller `assurance` config
- Modify: `contrib/deploying/knowledge/callers.schema.json` — `assurance` object
- Modify: `packages/auth/src/services/workforce.server.ts` — MFA check after actor resolution
- Modify: `packages/auth/src/services/workforce.server.test.ts`, `packages/knowledge/src/identity.test.ts`
- Modify: `apps/erp/app/routes/api+/v1+/lib/base.server.ts` — deny with a structured step-up error
- Modify: `apps/erp/app/routes/api+/v1+/lib/workforce.test.ts`
- Modify: `apps/knowledge/app/routes/unavailable.tsx` or a new `step-up.tsx` — user-facing message
- Copy from (precedent): `packages/auth/src/services/auth.server.ts` `requireAuthSession` MFA branch; `userHasVerifiedTotpFactor` in `packages/auth/src/services/mfa.server.ts`

**Steps:**

1. Extend the caller registry with `assurance: { mode: "carbon-mfa" | "workspace-equivalent", accessLevel?: string }`.
   `carbon-mfa` (default) means: if the resolved company requires MFA
   (`companySettings.requireMfa`) the actor must have a verified TOTP factor AND the
   request must carry evidence of a recent Carbon MFA session; otherwise deny.
   `workspace-equivalent` means the operator has documented (in the decision
   record for Task 11) that Workspace 2-step verification plus the named IAP access
   level is accepted as equivalent; the verifier then requires that access level in
   `google.access_levels`. There is no third mode and no inference from email or
   domain.
2. In `authorizeWorkforceRequest`, after `resolveHuman`, load the company's MFA
   requirement and the user's factor state through the existing service helpers.
   Attach `assurance: { required, satisfied, method }` to the principal. Never set
   `mfaVerified` on any Carbon session from this path.
3. In `assertWorkforceAuthorization`, deny when `assurance.required && !satisfied`
   with an error the browser backend can render as "this request needs Carbon
   sign-in with two-factor" plus a link to the ERP login; the knowledge-web route
   shows that page instead of a generic 401.
4. Tests: company without MFA requirement passes; company requiring MFA with a
   user lacking a factor is denied; `workspace-equivalent` without the access level
   is denied; `workspace-equivalent` with it passes; the ERP gate denies before any
   service function runs.

**Verify:**
```bash
pnpm --filter @carbon/knowledge test identity
pnpm --filter @carbon/auth test workforce
pnpm --dir apps/erp exec vitest run app/routes/api+/v1+/lib
# Expected: the four assurance cases above; no test path stamps mfaVerified.
```

**Out of scope:** implementing a step-up flow inside the portal; changing Carbon's
MFA enrollment.

## Task 04: Prove the verifier against real signatures; validate the caller registry

**Depends on:** none

**Files:**

- Create: `packages/knowledge/src/identity.signature.test.ts`
- Create: `packages/knowledge/scripts/validate-callers.ts`
- Modify: `packages/knowledge/package.json` — script `callers:validate`
- Modify: `.github/workflows/fork-checks.yml` — run the validator against `contrib/deploying/knowledge/callers.example.json`
- Create: `contrib/deploying/knowledge/callers.example.json` (synthetic)
- Modify: `contrib/deploying/knowledge/README.md:103-112`

**Steps:**

1. In the signature test, generate an RSA key pair in-process, serve a JWKS and an
   IAP-style certs document from a loopback HTTP server, and point
   `GoogleWorkforceTokenVerifier` at them through its existing constructor
   options (add options for the certs and JWKS URLs if it has none; default to
   Google's). Sign a service ID token and an IAP assertion locally and assert:
   valid pair passes; tampered payload fails; token signed with a second key not in
   the JWKS fails; JWKS rotation (old key removed) fails after the forced refresh;
   wrong service issuer fails; `verifyIdToken` audience mismatch fails.
2. `validate-callers.ts`: parse a JSON file with the same zod schema
   `identity.server.ts:27-57` uses (export it), print each caller's subject,
   operation and audiences, and exit non-zero on any mismatch with
   `callers.schema.json`. Assert in a test that the zod schema and the JSON schema
   accept and reject the same fixtures, so they cannot drift.
3. Add the validator to `fork-checks.yml` and to the README's release checklist.

**Verify:**
```bash
pnpm --filter @carbon/knowledge test identity.signature validate-callers
pnpm --filter @carbon/knowledge callers:validate contrib/deploying/knowledge/callers.example.json
# Expected: real-signature cases as listed; the example registry validates; a
# registry with a duplicate subject or a non-HTTPS audience is rejected.
```

**Out of scope:** calling Google's live endpoints in tests.

## Task 05: Carbon receiver deployment wiring and error semantics

**Depends on:** 01

**Files:**

- Modify: `contrib/deploying/gcp-tailscale/config.example.json`, `secrets.example.json` — `KNOWLEDGE_TRUSTED_CALLERS_JSON` (secret), `KNOWLEDGE_RECEIVER_AUDIENCE`
- Modify: `contrib/deploying/gcp-tailscale/prepare_release.py`, `render.py`, `runtime_inputs.py` — pass the two values to the ERP runtime environment
- Modify: `contrib/deploying/gcp-tailscale/test_prepare_release.py`, `test_render.py`, `test_release_inputs.py`
- Modify: `apps/erp/app/routes/api+/v1+/lib/authenticate.server.ts` — 401 `Response` on workforce failure, 503 when unconfigured
- Modify: `apps/erp/app/routes/api+/v1+/lib/knowledge.http.test.ts`
- Modify: `contrib/deploying/gcp-tailscale/README.md` — knowledge receiver section

**Steps:**

1. Add the two inputs to the deployment's private configuration contract with
   synthetic examples; the callers JSON is a secret (it names service-account
   subjects and audiences). Render them only into the ERP service environment.
2. In `authenticate.server.ts`, catch the workforce path's `Error` and return the
   same shape the API-key branch returns for failures: 401 with a generic body when
   verification fails, 503 with "workforce authentication is not configured" when
   `KNOWLEDGE_TRUSTED_CALLERS_JSON` is unset. Nothing about the failure reason is
   exposed.
3. Test through `$.ts` that a workforce request without configuration is 503 and a
   forged one is 401, and that API-key behaviour is unchanged.

**Verify:**
```bash
cd contrib/deploying/gcp-tailscale && python3 -m unittest test_prepare_release test_render test_release_inputs
pnpm --dir apps/erp exec vitest run "app/routes/api+/v1+/lib"
# Expected: rendered ERP env includes both values from private inputs and nothing
# else new; HTTP 401/503 cases pass.
```

**Out of scope:** deploying; changing how API keys authenticate.

## Task 06: Session and entry-path verification

**Depends on:** none

**Files:**

- Modify: `packages/auth/src/services/session.server.ts` — explicit host-mismatch handling
- Modify: `packages/auth/src/services/workforce-session.test.ts`
- Create: `apps/erp/test/workforce-entry-path.test.ts`, `apps/mes/test/workforce-entry-path.test.ts`
- Copy from (precedent): `apps/erp/test/login-integration.test.ts`

**Steps:**

1. When the request host matches neither `ERP_URL` nor `MES_URL` in production,
   fail the request (500 with a log line naming the host) instead of falling back
   to the shared `carbon` cookie; in development keep the fallback but log once.
2. Entry-path tests, per app: `?workforce=google` with Google as the only provider
   starts the OAuth redirect once (the ref guard) and preserves `redirectTo`
   encoded; with email enabled it does not auto-start; a user with a verified TOTP
   factor arriving through this path is sent to `/mfa` by the callback; the
   legacy parent-domain cookie expiry header is present on the callback response.

**Verify:**
```bash
pnpm --filter @carbon/auth test workforce-session
pnpm --dir apps/erp exec vitest run test/workforce-entry-path.test.ts
pnpm --dir apps/mes exec vitest run test/workforce-entry-path.test.ts
# Expected: host mismatch fails closed in production; entry-path cases pass.
```

**Out of scope:** changing cookie names already deployed.

## Task 07: Complete the Carbon canonical read gate

**Depends on:** 03, 05

**Files:**

- Modify: `apps/erp/app/routes/api+/v1+/lib/base.server.ts` — single source for the allowlist; step-up denial from Task 03
- Delete: the `KNOWLEDGE_READ_OPERATIONS` export in `apps/erp/app/modules/knowledge/knowledge.server.ts` (or make `WORKFORCE_CAPABILITIES` derive from it; one list, not two)
- Modify: `apps/erp/app/modules/knowledge/knowledge.service.ts`, `knowledge.models.ts` — add `getItemSupplierPricing` with its own capability `knowledge.read.pricing` and permission `purchasing:view`
- Modify: `scripts/lib/service-metadata.ts` — permission override for the pricing read
- Modify: `apps/erp/app/routes/api+/mcp+/lib/catalog-search.ts` and `apps/erp/app/routes/api+/v1+/openapi[.]json.ts` — exclude `knowledge_*` from MCP discovery and the public OpenAPI document (they are unusable there; today they are disclosed)
- Create: `apps/erp/app/routes/api+/v1+/lib/knowledge.gate.test.ts`
- Modify: `apps/erp/app/modules/knowledge/knowledge.read.integration.test.ts`
- Create: `apps/erp/app/modules/knowledge/AGENTS.md` via `.claude/skills/create-agents-md/SKILL.md`
- Copy from (precedent): `apps/erp/test/mcp-tool-permissions.test.ts` for manifest pinning

**Steps:**

1. Collapse the two allowlists into one exported constant that both the gate and
   the module consume; add a test that every `knowledge_*` operation in the
   generated manifest appears in it with a capability, so a new service function
   cannot ship ungated.
2. Pricing as a separate operation: `getItemSupplierPricing(itemId, supplierId?)`
   returning only `supplierUnitPrice`, `currencyCode`, `unitOfMeasureCode`,
   `updatedAt` from `supplierPart`/`itemCost` through the user-scoped client,
   capability `knowledge.read.pricing`, permission `purchasing:view`. Existing reads
   keep excluding price fields; add a test that asserts none of the six read outputs
   contain a key matching `/price|cost/i`.
3. Gate tests: api-key, oauth and session callers receive `NOT_FOUND` for every
   knowledge operation; `callOperation` (the MCP/agent path) for a knowledge op
   with a non-workforce context is refused; a workforce context whose permissions
   name a different `companyId` is refused; a read-only caller invoking
   `knowledge_createProcurementDraft` over real HTTP through `$.ts` gets 403; the
   pricing op requires its capability.
4. Disclosure: filter `knowledge_*` out of `search_tools`/`describe_tool` results
   and the OpenAPI document. Keep them in the manifest digest so the permission
   pin test still covers them.
5. Regenerate the manifest (`pnpm run generate:mcp`), confirm `check:manifest`,
   write the module `AGENTS.md`.

**Verify:**
```bash
pnpm run generate:mcp && pnpm --silent check:manifest
pnpm --dir apps/erp exec vitest run "app/routes/api+/v1+/lib" app/modules/knowledge test/mcp-tool-permissions.test.ts test/mcp-tool-metadata.test.ts
pnpm exec turbo run typecheck --filter=erp --filter=@carbon/auth
# Expected: one allowlist; eight knowledge operations pinned; non-workforce callers
# blocked on every path; no price key in read outputs; knowledge absent from
# search_tools and openapi.json.
```

**Out of scope:** "board-like operational summaries" — that read belongs to the
Kanban API (Task 08) and the source adapter (platform plan Task 12), not to
Carbon; adding a read-only transaction boundary to the procurement write (a
command-path concern).

## Task 08: Kanban workforce cutover

**Depends on:** 01 (pattern), 09 (IAP audience for `knowledge-web`)

**Files (all under `../kanban`):**

- Create: `backend/app/enrollment.py`, `backend/tests/test_enrollment.py`, `backend/scripts/enroll_identity.py`
- Modify: `backend/app/authorization.py:74-75` — remove the demo-user fallback; test mode selects the actor only through `x-kanban-test-actor-id`
- Modify: `backend/app/main.py:538` (`POST /api/users`) — require a board-admin capability or disable outside test mode
- Modify: `backend/app/product.py:513,853` — take `author_id`/`uploader_id` from the principal
- Modify: `backend/app/security.py` — `KANBAN_LEGACY_TOKEN_ALLOWED` flag, default false in production; refuse to start with both the legacy token and workforce mode enabled
- Create: `backend/tests/test_workforce_signature.py` (real-key verification, mirroring Task 04)
- Modify: `deploy/gcp-setup.sh`, `deploy/deploy.sh`, `deploy/README.md` — provision `KANBAN_SERVICE_AUDIENCE`, `KANBAN_SOURCE_IAP_AUDIENCE`, `KANBAN_WORKFORCE_CALLERS`, `KANBAN_WORKFORCE_MACHINE_CALLERS` as secrets/config; IAP-fronted ingress for the web app; the Cloud Run invoker grant for `knowledge-query` and `knowledge-actions` service accounts
- Modify: `frontend/app/lib/auth.ts`, `frontend/app/kanban-api-internal/[...path]/route.ts` — no change in logic; add tests for the `KANBAN_WORKFORCE_REQUIRED === "1"` branch

**Steps:**

1. Enrollment: an operator script that binds `(issuer, subject)` to an existing
   user, refusing email-shaped subjects and subjects already bound to another user,
   and a one-time migration data step that reports (does not create) users without
   bindings so the operator can enroll them before cutover.
2. Close the three residuals: demo-user fallback, unbound-principal creation via
   `POST /api/users`, payload-supplied actor ids.
3. Signature test with a locally generated key and loopback JWKS, as in Task 04.
4. Deployment: gcp-setup provisions the secrets and grants; deploy renders the env;
   README documents the cutover sequence — enroll every current user, deploy with
   workforce required and legacy token disabled, verify one user through IAP, then
   revoke the legacy token secret.
5. Staged compatibility (platform plan §1.2 step 5): before switching ingress,
   prove the private route works behind IAP with the probe; if it cannot, keep the
   current login and record the incompatibility.

**Verify:**
```bash
make -C ../kanban test-api
make -C ../kanban test-web
bash -n ../kanban/deploy/deploy.sh ../kanban/deploy/gcp-setup.sh
# Expected: enrollment cases; demo fallback gone; POST /api/users cannot mint a
# principal in production; legacy+workforce together refuse to start; real-key
# signature cases pass.
```

**Out of scope:** board workflow changes; moving Kanban's database; the ticket
command path (platform plan Task 20).

## Task 09: Cloud identity foundation completion

**Depends on:** none (last step needs Task 05's ERP inputs)

**Files:**

- Modify: `contrib/deploying/knowledge/main.tf` — GCS backend with per-environment prefix, read from `-backend-config`
- Modify: `contrib/deploying/knowledge/identity.tf` — `google_iap_client` + brand (or documented manual brand), Cloud Run IAM `run.invoker` grants: web→query, web→actions, ingest→query, and scheduler→retention already present
- Modify: `contrib/deploying/knowledge/services.tf` — IAP on the real `knowledge-web` service entry (controller-owned template, Terraform-owned IAP binding and IAM), not only the probe
- Modify: `contrib/deploying/knowledge/networking.tf` — use `var.private_source_cidrs`: firewall egress allow to the Carbon VM's private listener, Cloud NAT or VPC peering as the private path, TLS material reference for the Postgres listener
- Modify: `contrib/deploying/knowledge/outputs.tf` — per-service audiences
- Modify: `contrib/deploying/knowledge/release.py` — read audiences from Terraform outputs instead of free env vars
- Modify: `contrib/deploying/knowledge/test_infrastructure.py` — assertions for the invoker grants, IAP on web, unused-variable check; add `terraform validate` in `knowledge-check.yml` (already there) plus `terraform plan -refresh=false` with a synthetic tfvars file in CI where credentials allow, else keep static
- Modify: `contrib/deploying/knowledge/README.md`

**Steps:**

1. State: backend block plus documented `terraform init -backend-config` per
   environment; forbid local state files via `.gitignore` (already ignored).
2. IAP client and per-service audiences as Terraform outputs; the release
   controller consumes outputs, so an audience cannot drift between infrastructure
   and configuration.
3. Invoker grants exactly per the §1.4 forwarding table; no `allUsers`, no
   project-wide `run.invoker`.
4. Private path: whichever of firewall+NAT or peering the Carbon VM's private
   listener supports (`../kanban/deploy/shared-database-setup.py` already peers
   Kanban to it; mirror that). Keep raw Postgres TLS verification.
5. Tests grow from substring checks to assertions on parsed HCL for the resources
   above; where a plan is possible in CI, assert on plan JSON.

**Verify:**
```bash
terraform -chdir=contrib/deploying/knowledge init -backend=false
terraform -chdir=contrib/deploying/knowledge validate
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_infrastructure.py'
# Expected: validate passes; tests reject a missing invoker grant, IAP absent on
# web, and the unused private_source_cidrs variable.
```

**Out of scope:** applying to production; provisioning a second cloud
application environment (local Docker remains the integration proof).

## Task 10: Provider-eligibility policy verification

**Depends on:** none

**Files:**

- Audit then modify as needed: `packages/knowledge/src/retrieval/*.server.ts`, `packages/knowledge/src/query/*.server.ts`, the schema fields that mark a source or document provider-eligible
- Create: `packages/knowledge/src/provider-policy.test.ts`
- Modify: `apps/knowledge-query/src/*` route tests

**Steps:**

1. Locate the implemented "provider policy checks" the decision record reports and
   document the exact field and code path in the platform plan §1.9.1.
2. Prove with tests that no document text reaches an external reranker, embedding
   or answer provider unless the source is marked eligible AND the user is
   authorized, that eligibility and authorization are independent, and that a
   provider call with an ineligible document in the candidate set is refused
   rather than filtered silently.
3. Add a release fence: vector search and synthesis routes stay disabled unless
   the policy test suite is part of the manual profile CI run.

**Verify:**
```bash
pnpm --filter @carbon/knowledge test provider-policy
pnpm --filter knowledge-query test
# Expected: ineligible documents never leave the process; the fence holds.
```

**Out of scope:** enabling vector search or synthesis.

## Task 11: Restricted production verification

**Depends on:** 01–10

**Files:**

- Create: `.fork/decisions/<date>-knowledge-production-verification.md` (evidence, synthetic identifiers only)
- Modify: `contrib/deploying/knowledge/README.md` §"Release validation" — mark verified boundaries

**Steps:**

1. Confirm the production target project and the initial tester's identity with the
   operator before any apply (platform plan, "Revised release approach" step 5).
2. Apply Task 09's foundation to a disposable nonproduction configuration; deploy
   the synthetic probe; prove an unauthenticated browser, an alternate origin and
   a service-account token with the wrong audience are denied, and that the private
   route to the Carbon VM answers.
3. Enroll the tester with Task 01/08 scripts; deploy manual-v1 units restricted to
   that tester; verify real Google sign-in, the Task 03 assurance path, IAP
   propagation timing for revocation (Task 02), download authorization and rollback.
4. Record what was proven and what remains unproven; this record is the one that
   authorizes admitting company documents and more users.

**Verify:** the decision record lists each §1.2/§1.4 boundary with proven /
unproven, and no tracked file contains a real project ID, audience, subject,
group or credential.

**Out of scope:** admitting more than the initial tester; enabling any deferred
feature.

## 4. Completion record

Reconciled against `saturn/main` at `7e03ef5e2d` on 2026-09-13. PR #30 integrated
the implementation program; PR #56 integrated the Carbon connection repairs.
The entries below point to historical verification, not new executions by this
documentation pass. Local fixture results do not stand in for Task 11's live
checks, and Task 11's live checks do not replace the local suites.

| Task | Merged implementation and recorded proof | Remaining acceptance boundary |
| --- | --- | --- |
| 01 | PR #15; enrollment command and owner-role tests in [enrollment record](../decisions/2026-09-11-knowledge-identity-enrollment.md). PR #50/#56 repaired the real Carbon identifier-helper grants and fixture. | Exercise the integrated enrollment path on the selected Carbon-connected environment; production enrollment belongs to 11. |
| 02 | PR #24 through #30; [revocation record](../decisions/2026-09-11-knowledge-identity-revocation.md). Trunk tests require explicit re-enrollment after reactivation and compare monotonic version deltas. | Measure deployed propagation under 11; do not mistake restored user activity for restored admission. |
| 03 | PR #22 through #30; [assurance record](../decisions/2026-09-11-knowledge-authz-03-assurance.md). | Prove the selected Workspace assurance policy and access level under 11. Carbon-session evidence is not forwarded; `carbon-mfa` continues to deny when required. |
| 04 | PR #14; [real-signature and registry checks](../decisions/2026-09-11-knowledge-authz-04-signature-tests.md). | Real cloud caller/issuer/audience configuration remains 11; fixture signatures are not Google sign-in proof. |
| 05 | PR #20; [receiver wiring record](../decisions/2026-09-11-knowledge-receiver-wiring.md), with denial handling repaired in #49/#55/#56. | Live receiver configuration under 11; reproduce the outstanding non-API-key bearer and step-up classification findings before claiming complete error semantics. |
| 06 | PR #12; [session and entry-path checks](../decisions/2026-09-11-knowledge-authz-06-session-tests.md). | Real Google session/cookie and entry-path exercise under 11. |
| 07 | PR #27 through #30; [read-gate record](../decisions/2026-09-11-knowledge-authz-07-read-gate.md). PR #52/#56 added pricing transport and published-operation drift coverage. | Exercise current canonical permissions and receipt/manual resolution through the real receiver; production proof remains 11. |
| 08 | Kanban PR #2 is indexed in the [program record](../decisions/2026-09-12-knowledge-program-status.md). | Verify that repository's current merged revision and perform its workforce deployment/cutover; Carbon CI does not prove this. |
| 09 | PR #13; [foundation record](../decisions/2026-09-11-knowledge-authz-09-cloud-foundation.md) records Terraform validation and mutation tests. | No cloud apply is recorded. Database CA mounting and runtime IAM/networking must be verified before or during 11. |
| 10 | PR #11; [provider-policy checks](../decisions/2026-09-11-knowledge-provider-policy-verification.md). | Keep vector search and synthesis disabled pending their separate release decision and applicable acceptance. |
| 11 | No completed deployment evidence. | Confirm target and initial tester; verify real Google sign-in, assurance, IAP/private ingress, IAM, storage, revocation, recovery and rollback before expanding access. |
