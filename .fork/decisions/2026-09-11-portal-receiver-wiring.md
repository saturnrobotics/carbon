# ERP portal receiver: deployment wiring and error semantics

Task 05 of the portal authorization program. The ERP API's delegated
workforce branch existed but had no deployment inputs and surfaced every
failure as HTTP 500 from a plain `Error`.

## Decisions

- The deployment contract gains two optional ERP-only inputs handled by a
  dedicated `portal_receiver.py` module in the same shape as the payment
  sync credentials: `PORTAL_RECEIVER_AUDIENCE` (config) and
  `PORTAL_TRUSTED_CALLERS_JSON` (secret, file-mounted, placeholder
  substituted by the secrets entrypoint). Both render only into the ERP
  service; the secret's content hash joins ERP's pinned secret versions so a
  rotation reconfigures ERP alone and never selects platform maintenance.
- The configuration audience must equal the registry's `receiver.audience`.
  The non-secret value is the reviewable statement of what ERP accepts; the
  cross-check stops the two from drifting apart silently.
- The example secret is a `replace-` placeholder that validation refuses, so a
  copied example cannot deploy a synthetic registry. The audience alone is
  allowed and leaves the receiver disabled.
- `authorizeCarbonWorkforceRequest` throws a typed
  `WorkforceNotConfiguredError` when the registry is unset; the transport maps
  it to `503 Workforce authentication is not configured` and every other
  workforce failure to a bare `401 Unauthorized`. The API-key branch is
  untouched. No failure reason reaches the client; the verifier already
  collapses reasons server-side, so nothing is logged either.

## Verification (synthetic inputs only)

- `python -m unittest test_portal_receiver test_prepare_release test_render
  test_release_inputs test_deploy test_payment_sync`: 90 tests pass, including
  ERP-only rendering with nothing else changed, registry pinning, placeholder
  refusal and malformed registries failing without echoing their contents.
- `pnpm --dir apps/erp exec vitest run "app/routes/api+/v1+/lib"`: 58 tests
  pass; the new suite drives `$.ts` through the real `authenticate.server.ts`
  and the real verify chain with an injected rejecting verifier: unconfigured
  is 503, a forged token and a spoofed identity header are 401, and the
  API-key branch keeps its exact responses.
- `ruff check contrib/deploying`, scoped biome and `turbo run typecheck
  --filter=erp` pass.

Not covered: a live deployment, enrollment (Task 01), and the portal
services' own registration of the ERP audience (Task 09).
