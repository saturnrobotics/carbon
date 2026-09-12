import type { ManifestEntry } from "@carbon/api";

/** The manifest module every knowledge operation is generated under. */
export const KNOWLEDGE_MODULE = "knowledge";

/**
 * The one allowlist for the knowledge module: every operation it publishes,
 * mapped to the workforce capability a delegated caller must hold for it.
 *
 * The API gate (`routes/api+/v1+/lib/base.server.ts`) reads this map — an
 * operation absent from it is refused even for a workforce caller — and
 * `knowledge.gate.test.ts` pins that every `knowledge_*` operation in the
 * generated manifest appears here, so a new service function cannot ship
 * ungated. Pricing is the only read that discloses money and carries its own
 * capability; the identity reads keep excluding price and cost fields.
 */
export const KNOWLEDGE_OPERATIONS = {
  knowledge_resolveItems: "knowledge.read",
  knowledge_getItemIdentity: "knowledge.read",
  knowledge_getDocumentReferences: "knowledge.read",
  knowledge_getRecentReceipts: "knowledge.read",
  knowledge_getRecentReceiptItems: "knowledge.read",
  knowledge_getPurchaseStatus: "knowledge.read",
  knowledge_getItemSupplierPricing: "knowledge.read.pricing",
  knowledge_createProcurementDraft: "carbon.procurement.draft"
} as const satisfies Record<`${typeof KNOWLEDGE_MODULE}_${string}`, string>;

export type KnowledgeOperation = keyof typeof KNOWLEDGE_OPERATIONS;
export type KnowledgeCapability =
  (typeof KNOWLEDGE_OPERATIONS)[KnowledgeOperation];

/** The capability an operation requires, or `undefined` when the module does not
 *  publish it. `hasOwn`, not `in`: `"toString" in KNOWLEDGE_OPERATIONS` is true. */
export function knowledgeCapabilityFor(
  operation: string
): KnowledgeCapability | undefined {
  return Object.hasOwn(KNOWLEDGE_OPERATIONS, operation)
    ? KNOWLEDGE_OPERATIONS[operation as KnowledgeOperation]
    : undefined;
}

/**
 * Whether a manifest operation belongs to this module. Decided by module rather
 * than by the allowlist, so a service function that exists but is not yet listed
 * is hidden from every non-workforce surface instead of disclosed until someone
 * lists it — the gate and the disclosure filters both fail closed.
 */
export function isKnowledgeOperation(
  operation: Pick<ManifestEntry, "module">
): boolean {
  return operation.module === KNOWLEDGE_MODULE;
}
