import type { QueryRequest } from "@carbon/portal";
import { withPortalTransaction } from "@carbon/portal/database.server";
import {
  type ManualLink,
  resolveReceivedManual
} from "@carbon/portal/entities/resolve";
import type { VerifiedWorkforceIdentity } from "@carbon/portal/identity.server";
import type { QueryResult } from "@carbon/portal/query";
import { assembleEvidence } from "@carbon/portal/retrieval/evidence";
import {
  chunkJoins,
  chunkProjection,
  type RetrievedChunk
} from "@carbon/portal/retrieval/lexical.server";
import {
  createSourceRegistry,
  type SourceRegistryConfiguration
} from "@carbon/portal/sources/registry.server";
import type { Pool } from "pg";
import { z } from "zod";
import { createDriveAccessChecker } from "./drive-access.server";

/** How far back "recently received" reaches, in business calendar days. */
export const RECENT_RECEIPT_DAYS = 90;
const applicability = z.object({
  revision: z.string().max(256),
  manufacturer: z.string().min(1).max(256),
  mpn: z.string().min(1).max(256),
  serial: z.string().max(256).optional(),
  lot: z.string().max(256).optional(),
  variant: z.string().max(256).optional()
});
/** What each receipt-read gap means to someone reading the answer. */
const RECEIPT_GAPS: Record<string, string> = {
  "bounded-result-truncated": "more receipt lines than one read returns",
  "invalid-posting-date": "a receipt line whose posting date could not be read",
  "ambiguous-lot": "a receipt line recording more than one lot"
};

/**
 * The reasons that leave the candidate set short, in the caller's words. The
 * reason string is a comma-separated set, so a gap must never be missed just
 * because another reason travelled with it, and an unrecognised reason is
 * reported rather than waved through — a source this build does not know is
 * exactly when not to answer.
 */
export function receiptGaps(incompleteReason?: string): string[] {
  const reasons = new Set(
    (incompleteReason ?? "")
      .split(",")
      .map((reason) => reason.trim())
      .filter(Boolean)
  );
  if (!reasons.size) return ["the source did not say what was missing"];
  if (reasons.size === 1 && reasons.has("missing-identity")) return [];
  reasons.delete("missing-identity");
  return [...reasons].map((reason) => RECEIPT_GAPS[reason] ?? reason);
}

export async function resolveRecentManual(options: {
  request: Request;
  query: QueryRequest;
  identity: VerifiedWorkforceIdentity;
  pool: Pool;
  configuration: SourceRegistryConfiguration;
  origin: string;
  sourceIds: string[];
  businessTimezone?: string;
  workerOrigin?: string;
  workerAudience?: string;
}): Promise<QueryResult> {
  const result: QueryResult = {
    requestId: options.query.requestId,
    kind: "abstention",
    evidence: [],
    claims: [],
    message:
      "The received item's exact identity and applicable manual could not be verified.",
    partial: false
  };
  const sources = options.configuration.sources.filter(
    (source) =>
      source.kind === "carbon" && options.sourceIds.includes(source.id)
  );
  if (sources.length !== 1)
    return {
      ...result,
      kind: "clarification",
      message: "Select the source containing the item receipt.",
      choices: sources
        .slice(0, 20)
        .map((source) => ({ id: source.id, label: source.id }))
    };
  const source = sources[0]!;
  const registry = createSourceRegistry(options.configuration, options);
  const carbon = registry.carbon(source.id);
  const frame = /\bNEMA\s*\d+\b/i.exec(options.query.text)?.[0];
  const term =
    frame ??
    options.query.text
      .replace(
        /\b(?:pull|up|the|manual|for|we|recently|got|received|bought|purchased|find|show|me)\b/gi,
        " "
      )
      .replace(/\s+/g, " ")
      .trim();
  const items = await carbon.searchItems(term);
  if (!items.length) return result;
  if (items.length >= 40)
    return {
      ...result,
      kind: "clarification",
      message:
        "Narrow the part description before selecting an applicable manual.",
      choices: items
        .slice(0, 20)
        .map((item) => ({ id: item.id, label: item.name }))
    };
  const receipts = await carbon.recentReceiptItems(
    items.map((item) => item.id)
  );
  // `missing-identity` is not a gap in the read — those rows ARE present, and
  // the resolver's own identity rules decide what to do with them. Every other
  // reason means receipt lines were left out of the candidate set, so an answer
  // drawn from what remains could be the wrong one. Say which, so this reads as
  // a fact about the receipt rather than as the source being down.
  const unresolvable = receiptGaps(receipts.incompleteReason);
  if (receipts.status !== "complete" && unresolvable.length)
    return {
      ...result,
      partial: true,
      message: `The receipt history could not be read in full (${unresolvable.join("; ")}), so the received item cannot be identified. Review the receipt in Carbon before selecting a manual.`
    };
  const links = await withPortalTransaction(
    options.pool,
    options.identity.principal,
    "read",
    async (client) => {
      const rows = await client.query<{
        sourceEntityId: string;
        documentVersionId: string;
        applicability: unknown;
      }>(
        `SELECT e."sourceEntityId",l."documentVersionId",l.applicability FROM portal."entityLink" l JOIN portal.entity e ON e.id=l."entityId" AND e."companyId"=l."companyId" WHERE e."companyId"=$1 AND e."sourceId"=$2 AND e."sourceEntityId"=ANY($3::text[]) AND l.relation='manual-for' AND l."verifiedAt" IS NOT NULL AND l."verifiedBy" IS NOT NULL AND l."documentVersionId" IS NOT NULL LIMIT 101`,
        [
          options.identity.principal.companyId,
          source.id,
          items.map((item) => item.id)
        ]
      );
      if (rows.rows.length > 100)
        throw Error("Applicable manual projection exceeded");
      return rows.rows.flatMap((row) => {
        const parsed = applicability.safeParse(row.applicability);
        return parsed.success
          ? [
              {
                ...parsed.data,
                itemId: row.sourceEntityId,
                documentVersionId: row.documentVersionId,
                verified: true
              } satisfies ManualLink
            ]
          : [];
      });
    }
  );
  // An explicit, human-verified item/manual link may supply a missing manufacturer.
  // Similar frame sizes or an unreviewed model extraction never do.
  const enriched = receipts.items.map((receipt) => {
    if (receipt.manufacturer) return receipt;
    const manufacturers = [
      ...new Set(
        links
          .filter(
            (link) =>
              link.itemId === receipt.itemId &&
              link.revision === receipt.revision &&
              link.mpn === receipt.mpn
          )
          .map((link) => link.manufacturer)
      )
    ];
    return manufacturers.length === 1
      ? {
          ...receipt,
          manufacturer: manufacturers[0]!,
          missingIdentityFields: receipt.missingIdentityFields?.filter(
            (field) => field !== "manufacturer"
          )
        }
      : receipt;
  });
  // "Recently" is a business-calendar window in the company's timezone.
  const resolved = resolveReceivedManual(enriched, links, {
    businessTimezone: options.businessTimezone,
    recentDays: RECENT_RECEIPT_DAYS
  });
  if (resolved.status === "ambiguous")
    return {
      ...result,
      kind: "clarification",
      message:
        "More than one received item or manual is applicable. Select the exact item and revision.",
      choices: resolved.choices.slice(0, 20).map((choice) => ({
        id: choice.slice(0, 256),
        label: choice.slice(0, 500)
      }))
    };
  if (resolved.status !== "resolved") return result;
  const chunks = await withPortalTransaction(
    options.pool,
    options.identity.principal,
    "read",
    async (client) =>
      (
        await client.query<RetrievedChunk>(
          `SELECT ${chunkProjection} FROM ${chunkJoins} WHERE c."companyId"=$1 AND c."documentVersionId"=$2 ORDER BY c.ordinal LIMIT 1`,
          [options.identity.principal.companyId, resolved.documentVersionId]
        )
      ).rows
  );
  result.evidence = await assembleEvidence(chunks, {
    origin: options.origin,
    policyVersion: options.identity.principal.policyVersion,
    maxTokens: 7000,
    countTokens: (text) => new TextEncoder().encode(text).length,
    authorize: createDriveAccessChecker(options)
  });
  if (result.evidence.length) {
    result.kind = "results";
    result.message = "";
  }
  return result;
}
