import type { QueryRequest } from "@carbon/knowledge";
import { withKnowledgeTransaction } from "@carbon/knowledge/database.server";
import {
  type ManualLink,
  resolveReceivedManual
} from "@carbon/knowledge/entities/resolve";
import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";
import type { QueryResult } from "@carbon/knowledge/query";
import { assembleEvidence } from "@carbon/knowledge/retrieval/evidence";
import {
  chunkJoins,
  chunkProjection,
  type RetrievedChunk
} from "@carbon/knowledge/retrieval/lexical.server";
import {
  createSourceRegistry,
  type SourceRegistryConfiguration
} from "@carbon/knowledge/sources/registry.server";
import type { Pool } from "pg";
import { z } from "zod";
import { createDriveAccessChecker } from "./drive-access.server";

const applicability = z.object({
  revision: z.string().max(256),
  manufacturer: z.string().min(1).max(256),
  mpn: z.string().min(1).max(256),
  serial: z.string().max(256).optional(),
  lot: z.string().max(256).optional(),
  variant: z.string().max(256).optional()
});
export async function resolveRecentManual(options: {
  request: Request;
  query: QueryRequest;
  identity: VerifiedWorkforceIdentity;
  pool: Pool;
  configuration: SourceRegistryConfiguration;
  origin: string;
  sourceIds: string[];
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
  if (
    receipts.status !== "complete" &&
    receipts.incompleteReason !== "missing-identity"
  )
    return {
      ...result,
      partial: true,
      message:
        "The receipt source returned incomplete identity or reversal information. Review the receipt before selecting a manual."
    };
  const links = await withKnowledgeTransaction(
    options.pool,
    options.identity.principal,
    "read",
    async (client) => {
      const rows = await client.query<{
        sourceEntityId: string;
        documentVersionId: string;
        applicability: unknown;
      }>(
        `SELECT e."sourceEntityId",l."documentVersionId",l.applicability FROM knowledge."entityLink" l JOIN knowledge.entity e ON e.id=l."entityId" AND e."companyId"=l."companyId" WHERE e."companyId"=$1 AND e."sourceId"=$2 AND e."sourceEntityId"=ANY($3::text[]) AND l.relation='manual-for' AND l."verifiedAt" IS NOT NULL AND l."verifiedBy" IS NOT NULL AND l."documentVersionId" IS NOT NULL LIMIT 101`,
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
  const resolved = resolveReceivedManual(enriched, links);
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
  const chunks = await withKnowledgeTransaction(
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
