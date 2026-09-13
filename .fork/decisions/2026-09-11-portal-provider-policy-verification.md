# Portal provider-eligibility policy verification

**Date:** 2026-09-11
**Scope:** Task 10 of the portal authorization program (platform plan §1.9.1).
**Base revision:** `saturn/main` at `7464d10347`.

## What was found

The decision record's "provider policy checks" claim was implemented in two places
and half-implemented in a third:

- `portal.source."providerPolicy"` (jsonb, default `{}`) is the eligibility
  field; `providerEligible` requires the provider to be listed for the document's
  classification. Index-time embedding already refused, not filtered, an
  ineligible document (`embedCurrentDocumentVersion`).
- The query service computed eligibility per chunk but then **silently filtered**
  the synthesis candidates to the eligible subset before calling the answer
  provider, and `assembleEvidence` carried an unused `providerId` option that did
  the same filtering inside user-facing evidence assembly.
- No reranker exists; the query embedder only ever receives the reader's question.

## What changed

- `packages/portal/src/provider-policy.ts` owns `providerEligible`,
  `assertProviderCandidates` and `ProviderPolicyRefusal`. A candidate set is
  disclosed whole or not at all; a refusal carries counts only.
- `createProviderDisclosure` in `apps/portal-query/src/query.server.ts` is the
  only path to the answer provider: fresh authorization re-read, then policy on
  the re-read rows, then the provider. A refusal is recorded as a `model` deny.
- `executeReadQuery` turns a refusal into `results` with
  `PROVIDER_POLICY_REFUSED_MESSAGE`, so the reader keeps their evidence and the
  refusal is visible rather than silent.
- `assembleEvidence` no longer accepts `providerId`; provider policy never trims
  what the reader may see.
- Release fence: `apps/portal-query/src/release-fence.test.ts` fails if the
  manual profile wires `embedding`/`model`/`sources`, or if either provider-policy
  suite leaves the CI runtime job's unit profile (checked by running
  `vitest list` in each package and reading the workflow).

## Verification (local, synthetic, no provider network calls)

- `pnpm --filter @carbon/portal test provider-policy` — 9 passed.
- `pnpm --filter @carbon/portal test` — 26 files, 121 passed.
- `pnpm --filter portal-query test` — 9 files, 29 passed (includes the fence
  and `provider-disclosure.test.ts`).
- Negative proof of the fence: hiding `provider-policy.test.ts` and, separately,
  removing the `@carbon/portal test` line from the workflow each made the fence
  fail; restored state passes.
- `pnpm exec biome check --error-on-warnings` on every changed file — clean.
- `pnpm exec turbo run typecheck --filter=@carbon/portal --filter=portal-query` — clean.

Not run locally: the PostgreSQL/Redis integration profile; it runs unchanged in
the `portal-check` workflow. Vector search and synthesis remain disabled.
