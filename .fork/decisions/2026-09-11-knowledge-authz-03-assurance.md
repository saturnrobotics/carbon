# Knowledge authorization Task 03: required assurance for delegated access

Implements Task 03 of `.fork/plans/2026-09-11-knowledge-authorization.md` on top
of Task 04 (`feat/knowledge-authz-04-signature-tests`). Local proof only.

## What "recent Carbon MFA session evidence" means today

Nothing. The forwarding contract (`createWorkforceForwardingHeaders`) carries a
service ID token, the user's IAP assertion and the company id, and no Carbon
session marker exists anywhere in it. The plan forbids inventing a new bearer
and forbids reading an IAP signature or access level as an MFA level, so under
`carbon-mfa` a company that requires MFA (`companySettings.requireMfa`, or any
`CONTROLLED_ENVIRONMENT` deployment) can never be served through the delegated
path: `assurance.satisfied` is `false` whether or not the actor has a verified
TOTP factor, and the request is denied with `step_up_required`. The factor state
is still read through `userHasVerifiedTotpFactor` so the rule in the plan is
implemented as written and a future session marker is a one-constant change
(`CARBON_MFA_SESSION_EVIDENCE_FORWARDED` in `packages/auth/src/services/workforce.server.ts`).

## Registry

Each caller carries `assurance`: `{ "mode": "carbon-mfa" }` (the default when
omitted) or `{ "mode": "workspace-equivalent", "accessLevel": "<IAP level>" }`.
The runtime zod schema is a discriminated union, so a third mode, a
`workspace-equivalent` without its level, a `carbon-mfa` with one, and any extra
key are all refused. `callers.schema.json` expresses the same rules with `oneOf`,
which the purpose-built JSON Schema validator now implements; the pinning test
still diverges from the runtime schema on subject uniqueness alone. The
validator's summary line prints the mode.

`verifyWorkforceRequest` requires the documented access level in
`google.access_levels` for `workspace-equivalent` and refuses the request without
it rather than downgrading; the identity it returns carries the caller's mode.
The knowledge services never compute a verdict: an IAP assertion proves
admission, so the human principal's `assurance` (`{ required, satisfied,
method }`) is optional in the contract and set only by Carbon.

## Carbon receiver

`authorizeWorkforceRequest` reads `companySettings.requireMfa` through the
actor's own user-scoped client (as the ERP shell does), forces the requirement
on under `CONTROLLED_ENVIRONMENT`, fails closed when the setting cannot be read,
and attaches the verdict to the principal. `workspace-equivalent` satisfies a
required company because the verifier already enforced the level. A source-scan
test pins that the module never references a Carbon session or `mfaVerified`.

`assertWorkforceAuthorization` denies `required && !satisfied` last — after the
caller, capability and permission checks — with `ORPCError("FORBIDDEN", { data:
{ code: "step_up_required", method } })`, so API callers see a 403 JSON envelope
and a user is only told to step up when MFA is the one thing missing. The HTTP
test proves the denial happens before any service function runs.

## Portal

`packages/knowledge/src/step-up.ts` names the denial once for every hop.
`createSourceTransport` reads a 403 body (bounded to 4 KiB) and throws
`StepUpRequiredError` when it carries the code; other denials stay opaque. The
query service's read handler maps that error to `403 { error: "step_up_required" }`;
the web gateway forwards only a 403 with that body as the same shape and keeps
everything else `query_unavailable`; the search form then navigates to
`/step-up`, a server-rendered 403 page telling the user to sign in to Carbon
with two-factor authentication. The page links to `KNOWLEDGE_CARBON_LOGIN_URL`
when it is a bare https URL and renders without a link otherwise.

## Not done

- `release.py` rejects any web environment key outside its required set, so
  `KNOWLEDGE_CARBON_LOGIN_URL` cannot be deployed until the receiver deployment
  wiring (Task 05) accepts it. The page degrades to text-only until then.
- The query service's catch-site mapping is covered by the shared `step-up`
  unit tests and the transport test; the read handler itself is exercised only by
  the integration suite, which needs a database and was not run here.
- A user who enrolled a factor voluntarily in a company that does not require
  MFA is bounced by `requireAuthSession` in the ERP but not by this gate; the
  plan defines `required` as the company requirement and this follows it.

## Verification

`pnpm --filter @carbon/knowledge test` (28 files, 178 tests),
`pnpm --filter @carbon/auth test workforce` (13 tests),
`pnpm --dir apps/erp exec vitest run "app/routes/api+/v1+/lib"` (57 tests),
`pnpm --filter knowledge test` (32 tests), `pnpm --filter knowledge-query test`,
`pnpm --filter @carbon/knowledge callers:validate contrib/deploying/knowledge/callers.example.json`
(exit 0, both modes printed), strict Biome on all 29 changed files, and
`turbo typecheck` for `@carbon/knowledge`, `@carbon/auth`, `erp`, `knowledge`,
`knowledge-query`, `knowledge-worker`.
