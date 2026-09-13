# Supplier pricing gets a transport path, and the gap class gets a test

Implements Task 05 of `.fork/plans/2026-09-13-portal-erp-join-repairs.md`.
Base: `saturn/main` at `eb5da21766`. Local proof only; no cloud environment was
touched, and no authorization rule changed.

## What was found

Carbon published `portal_getItemSupplierPricing` with a capability
(`portal.read.pricing`), a permission (`purchasing:view`), a manifest entry
and a committed digest line. The portal platform's source transport keeps an
allowlist of permitted endpoints so retrieved content cannot induce an
unexpected call — and pricing was not in it. Nothing under
`packages/portal` or `apps/portal*` referenced the operation. Every side
of the boundary worked; the only reachable answer was the transport's own
`unregistered` refusal, which the adapter maps to
`{ kind: "unavailable", reason: "unregistered" }` — an outage, not a gap.

## Decisions

- **Registered, not widened.** One entry
  (`/api/v1/portal/getItemSupplierPricing`) joins the allowlist. No other
  path, no change to the transport's blanket `portal.read` check, and no
  change to Carbon's gate.
- **Pricing is a Carbon adapter method, not a source-contract capability.**
  `createCarbonSourceAdapter().getSupplierPricing(itemId, supplierId?)` in
  `sources/carbon.server.ts`. It is deliberately NOT a `sourceEntity` field and
  NOT a new `factQuery` name: `sourceEntitySchema` and the fact enum are what
  keep the item, receipt and purchase-order projections free of money, and
  `portal.read.integration.test.ts` pins that on the manifest's response
  schemas. Widening either to carry a price would delete the separation the
  separate capability exists to create. `sourceAdapterDescriptorSchema` is
  therefore untouched — its capability enum describes the finite money-free
  contract every producer implements, and pricing is Carbon-only.
- **The capability is re-read before the call, and can only refuse.** The
  transport's existing check is `portal.read`, which does not imply
  `portal.read.pricing`; Carbon's gate stays the authority. Refusing locally
  means a caller who never held the capability does not spend a source read
  learning that, and a caller who passes it still receives
  `insufficient-permission` from Carbon without `purchasing:view`. A denial is
  never rendered as "this item has no prices".
- **A bounded page says so.** Carbon returns at most 50 supplier prices; a full
  page reports `status: "partial"`, the same rule the item search and document
  references already follow, so the bound is never passed off as the population.

## The durable part: the drift test

`packages/portal/src/sources/carbon-operations.test.ts` asserts that every
portal operation Carbon publishes is either registered in the transport or
named in `EXCLUDED_CARBON_OPERATIONS` with a stated reason.

Both sides are READ, never restated. The published set comes from
`apps/erp/app/routes/api+/mcp+/lib/tool-manifest.digest.json` — the manifest
itself is gitignored build output, so the digest is the only committed record of
the published contract, and `pnpm check:manifest` keeps it current. The
registered set comes from the live allowlist, exported as
`REGISTERED_SOURCE_OPERATIONS`. A second hand-written copy of either would be
the same defect wearing a different hat.

It reads BOTH directions. Forward: a published operation with no entry fails
with the operation named. Reverse: an allowlist entry naming no published
operation is dead, and a typo looks exactly like a registration — so a Carbon
path must be a published operation or appear in `CARBON_NON_OPERATION_PATHS`
with what it actually is (today: the machine-only `source-changes` route, which
is outside the operation dispatch on purpose). Unreadable digest is a failure,
never a skip: a drift test that quietly passes when it cannot read the published
set is the silence it exists to break.

One exclusion is recorded today — `portal_createProcurementDraft`, a write
whose review boundary is the portal and whose route is the actions service's
own, not this read transport.

`apps/erp/app/modules/portal/AGENTS.md` gains the matching rule, since the
author who publishes a new operation is the one who creates the drift.

## Verification

Recorded in the PR body's verification table. The drift test was proved by
deleting an allowlist entry and watching it fail with the operation named —
once for `getItemSupplierPricing`, once for the pre-existing
`getPurchaseStatus`, so the proof is not a restatement of the pin.

## Not done

- No consumer calls `getSupplierPricing` yet. The query service's source wiring
  (`apps/portal-query/src/index.ts`, `query.server.ts`) is Tasks 03 and 04 and
  belongs to another change; this task is the transport path and the gap class.
- The four row-level-security cases in `portal.read.integration.test.ts`
  remain skipped — they need a disposable Supabase stack, as recorded in
  `.fork/decisions/2026-09-11-portal-authz-07-read-gate.md`. Unchanged here.
