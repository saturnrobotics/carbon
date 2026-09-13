# Portal authorization Task 07: the Carbon canonical read gate

Implements Task 07 of `.fork/plans/2026-09-11-portal-authorization.md` on top
of Task 03 (`feat/knowledge-authz-03-assurance`) merged with Task 05
(`feat/knowledge-authz-05-erp-receiver-wiring`). Local proof only; no database
or cloud environment was touched.

## Decisions

- **One allowlist, owned by the module.** `PORTAL_OPERATIONS` in
  `apps/erp/app/modules/portal/portal.server.ts` maps each published
  operation to the workforce capability it requires. The former
  `PORTAL_READ_OPERATIONS` (unreferenced) and the gate's private
  `WORKFORCE_CAPABILITIES` are gone; `assertWorkforceAuthorization` reads the
  map through `portalCapabilityFor`, and `isPortalOperation` (by module,
  not by list) is what the gate and every disclosure filter key on, so a
  service function that exists but is not yet listed is hidden and refused
  rather than disclosed until someone lists it. `portal.gate.test.ts` pins
  that every generated `portal_*` operation has a capability and that every
  listed name is published — eight today.
- **Pricing is its own operation.** `getItemSupplierPricing(itemId, supplierId?)`
  reads `supplierPart` then `supplier` (two batched reads under the actor's
  RLS; no embed) and returns `supplierUnitPrice`, `currencyCode`,
  `unitOfMeasureCode`, `updatedAt` — plus `supplierId`, added so a list across
  suppliers is attributable when `supplierId` is omitted; it is an identifier the
  caller already holds, not a commercial field. Capability
  `portal.read.pricing`, permission `purchasing:view` (the `supplierPart` and
  `supplier` SELECT policies). The six identity reads are pinned free of any
  `/price|cost/i` key on the manifest's reflected response schemas, which
  catches a leak from a column list, an embed or a mapped return type alike.
- **Disclosure.** `isDisclosedOperation` / `DISCLOSED_OPERATIONS` in
  `operations.server.ts` withhold the portal module from `search_tools`
  (the filter lives inside `createCatalogSearch`, so no caller can index the raw
  manifest), `describe_tool` (`disclosedOperationsByName`), the
  `/.well-known/mcp.json` counts and module list, the connect-time
  instructions, and `/api/v1/openapi.json` (generated from `disclosedRouter`).
  The operations stay in `OPERATIONS`, the full `router` and the committed
  digest, so the permission pin and the HTTP transport still cover them.
  Non-workforce callers keep receiving NOT_FOUND, not FORBIDDEN — invisible,
  not merely closed.
- **Task 05's test on the merged tree.** `authenticate.http.test.ts` was written
  before Task 03 made `workforce.server.ts` import `mfa.server.ts`; on the merge
  its import chain reached a Lingui macro and the suite failed to load. It now
  replaces `@carbon/auth/mfa.server` at the same boundary as the other
  infrastructure mocks; no case reaches the assurance step, so no assertion
  changed.

## Verification

- `pnpm run generate:mcp && pnpm --silent check:manifest`: 1563 operations
  across 16 modules, digest current; the digest gains one line
  (`portal_getItemSupplierPricing`, READ, `purchasing:view`).
- `pnpm --dir apps/erp exec vitest run "app/routes/api+/v1+/lib" app/modules/portal test/mcp-tool-permissions.test.ts test/mcp-tool-metadata.test.ts`
  and `"app/routes/api+/mcp+/lib"`: all files pass; the four RLS cases in
  `portal.read.integration.test.ts` are skipped (below).
- `pnpm exec turbo run typecheck --filter=erp --filter=@carbon/auth`: 0 errors.
- Strict Biome on every changed TypeScript path: no diagnostics.

## Not done

- The `describe.skipIf` block in `portal.read.integration.test.ts` (pricing
  projection, supplier filter, cross-company refusal and the money-free identity
  read, all through `getUserScopedClient` against PostgREST) was not executed.
  It needs a disposable Supabase stack; `crbn up --no-apps --no-portless` pins
  the API port to 54321, which another worktree's running stack held, and
  portless mode needs sudo for the hosts file and proxy, which a non-interactive
  session cannot grant. Run it from a throwaway slot with
  `PORTAL_READ_TEST_SUPABASE_URL`, `_ANON_KEY`, `_SERVICE_ROLE_KEY`,
  `_JWT_SECRET` taken from that slot's `.env.local` and
  `PORTAL_READ_TEST_DISPOSABLE=1`, then `crbn down --purge`.
- `pnpm generate:swagger` was not run: it reads the database schema through
  Studio, and this task changes no schema.
