import type { ManifestEntry } from "@carbon/api";

/** The manifest module every portal operation is generated under. */
export const PORTAL_MODULE = "portal";

/**
 * The one allowlist for the portal module: every operation it publishes,
 * mapped to the workforce capability a delegated caller must hold for it.
 *
 * The API gate (`routes/api+/v1+/lib/base.server.ts`) reads this map — an
 * operation absent from it is refused even for a workforce caller — and
 * `portal.gate.test.ts` pins that every `portal_*` operation in the
 * generated manifest appears here, so a new service function cannot ship
 * ungated. Pricing is the only read that discloses money and carries its own
 * capability; the identity reads keep excluding price and cost fields.
 */
export const PORTAL_OPERATIONS = {
  portal_resolveItems: "portal.read",
  portal_getItemIdentity: "portal.read",
  portal_getDocumentReferences: "portal.read",
  portal_getRecentReceipts: "portal.read",
  portal_getRecentReceiptItems: "portal.read",
  portal_getPurchaseStatus: "portal.read",
  portal_getItemSupplierPricing: "portal.read.pricing",
  portal_createProcurementDraft: "carbon.procurement.draft"
} as const satisfies Record<`${typeof PORTAL_MODULE}_${string}`, string>;

export type PortalOperation = keyof typeof PORTAL_OPERATIONS;
export type PortalCapability = (typeof PORTAL_OPERATIONS)[PortalOperation];

/** The capability an operation requires, or `undefined` when the module does not
 *  publish it. `hasOwn`, not `in`: `"toString" in PORTAL_OPERATIONS` is true. */
export function portalCapabilityFor(
  operation: string
): PortalCapability | undefined {
  return Object.hasOwn(PORTAL_OPERATIONS, operation)
    ? PORTAL_OPERATIONS[operation as PortalOperation]
    : undefined;
}

/**
 * Whether a manifest operation belongs to this module. Decided by module rather
 * than by the allowlist, so a service function that exists but is not yet listed
 * is hidden from every non-workforce surface instead of disclosed until someone
 * lists it — the gate and the disclosure filters both fail closed.
 */
export function isPortalOperation(
  operation: Pick<ManifestEntry, "module">
): boolean {
  return operation.module === PORTAL_MODULE;
}
