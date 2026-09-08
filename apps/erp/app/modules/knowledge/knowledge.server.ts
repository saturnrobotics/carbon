export const KNOWLEDGE_READ_OPERATIONS = [
  "knowledge_resolveItems",
  "knowledge_getRecentReceipts",
  "knowledge_getRecentReceiptItems",
  "knowledge_getItemIdentity",
  "knowledge_getDocumentReferences",
  "knowledge_getPurchaseStatus"
] as const;

export type KnowledgeReadOperation = (typeof KNOWLEDGE_READ_OPERATIONS)[number];
