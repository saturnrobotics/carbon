import { createHash } from "node:crypto";
import type { Evidence, QueryRequest } from "@carbon/knowledge";
import { sourceEntityRequestSchema } from "@carbon/knowledge";
import { withKnowledgeTransaction } from "@carbon/knowledge/database.server";
import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";
import type { QueryResult } from "@carbon/knowledge/query";
import type { SourceOutcome } from "@carbon/knowledge/sources/contract";
import {
  createSourceRegistry,
  type SourceRegistryConfiguration
} from "@carbon/knowledge/sources/registry.server";
import { now } from "@internationalized/date";
import type { Pool } from "pg";
import { resolveRecentManual } from "./manual.server";

function revision(value: unknown) {
  return `projection:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
/**
 * A structured source outcome rendered for the reader. Nothing here names or
 * counts hidden rows: an outage is labelled as such, a denial as such, and
 * `moreHidden` only says the list is not the whole population.
 */
export function outcomeResult(
  base: QueryResult,
  outcome: SourceOutcome
): QueryResult | null {
  if (outcome.kind === "ok") return null;
  if (outcome.kind === "ambiguous")
    return {
      ...base,
      kind: "clarification",
      message: outcome.moreHidden
        ? "More than one record matches. Select one, or narrow the description; some matches are not shown."
        : "More than one record matches. Select one.",
      choices: outcome.choices.slice(0, 20)
    };
  if (outcome.kind === "insufficient-permission")
    return {
      ...base,
      kind: "abstention",
      message: "This source did not authorize the request.",
      partial: true
    };
  if (outcome.kind === "not-found")
    return {
      ...base,
      kind: "abstention",
      message: "No authorized matching records were found."
    };
  return {
    ...base,
    kind: "abstention",
    message:
      outcome.reason === "deadline"
        ? "A source did not answer within its time budget; this is not an empty result."
        : "A source could not complete this request; this is not an empty result.",
    partial: true
  };
}

async function permittedSources(
  pool: Pool,
  identity: VerifiedWorkforceIdentity,
  configuration: SourceRegistryConfiguration,
  sourceId?: string
) {
  const permitted = await withKnowledgeTransaction(
    pool,
    identity.principal,
    "read",
    async (client) =>
      (
        await client.query<{ id: string; kind: string }>(
          `SELECT id,kind FROM knowledge.source WHERE "companyId"=$1 AND status='active' AND ($2::text IS NULL OR id=$2) ORDER BY id LIMIT 5`,
          [identity.principal.companyId, sourceId ?? null]
        )
      ).rows
  );
  return configuration.sources
    .filter((source) =>
      permitted.some((row) => row.id === source.id && row.kind === source.kind)
    )
    .slice(0, 4);
}
export async function getSourceEntity(options: {
  request: Request;
  identity: VerifiedWorkforceIdentity;
  pool: Pool;
  configuration: SourceRegistryConfiguration;
}) {
  const input = sourceEntityRequestSchema.parse(await options.request.json());
  const sources = await permittedSources(
    options.pool,
    options.identity,
    options.configuration,
    input.sourceId
  );
  const source = sources.find((source) => source.id === input.sourceId);
  if (!source) throw Error("Source unavailable");
  const registry = createSourceRegistry(options.configuration, options);
  if (source.kind === "kanban") {
    const result = await registry.kanban(source.id).getTicket(input.entityId);
    return {
      kind: "ticket",
      title: result.ticket.title,
      description: result.ticket.description,
      fields: {
        boardId: result.ticket.boardId,
        columnId: result.ticket.columnId,
        dueDate: result.ticket.dueDate
      },
      sourceRevision: result.sourceRevision,
      observedAt: now("UTC").toAbsoluteString()
    };
  }
  if (source.kind === "carbon") {
    if (input.kind === "purchase-order") {
      const purchase = await registry
        .carbon(source.id)
        .purchaseStatus(input.entityId);
      if (!purchase) throw Error("Entity unavailable");
      return {
        kind: "purchase-order",
        title: `Purchase order ${purchase.purchaseOrderId}`,
        description: null,
        fields: { status: purchase.status, orderDate: purchase.orderDate },
        sourceRevision: revision(purchase),
        observedAt: now("UTC").toAbsoluteString()
      };
    }
    const item = await registry.carbon(source.id).getItem(input.entityId);
    if (!item) throw Error("Entity unavailable");
    return {
      kind: "item",
      title: item.name,
      description: item.description ?? null,
      fields: {
        itemId: item.readableId,
        revision: item.revision,
        mpn: item.mpn
      },
      sourceRevision: revision(item),
      observedAt: now("UTC").toAbsoluteString()
    };
  }
  if (source.kind === "engineering" || source.kind === "crm") {
    const entity = await registry.generic(source.id).getEntity(input.entityId);
    if (entity.id !== input.entityId)
      throw Error("Source returned a different entity");
    return {
      kind: entity.type,
      title: entity.title,
      description: entity.description ?? null,
      fields: entity.fields,
      sourceRevision: entity.revision,
      observedAt: now("UTC").toAbsoluteString()
    };
  }
  throw Error("Source entity operation unavailable");
}

/** Live facts bypass answer caching; each owner service enforces its own ACLs. */
export async function structuredSourceQuery(options: {
  request: Request;
  query: QueryRequest;
  identity: VerifiedWorkforceIdentity;
  pool: Pool;
  configuration: SourceRegistryConfiguration;
  origin: string;
  businessTimezone?: string;
  workerOrigin?: string;
  workerAudience?: string;
}): Promise<QueryResult | null> {
  const { query, identity } = options;
  const ticketIntent = /\b(?:ticket|tickets|task|tasks)\b/i.test(query.text);
  const purchaseIntent =
    /\b(?:purchase order|PO)[\s:#-]*([A-Za-z0-9_./-]+)/i.exec(query.text);
  const manualIntent =
    /\bmanual\b/i.test(query.text) &&
    /\b(?:recently|got|received|bought|purchased)\b/i.test(query.text);
  const genericIntent =
    /^(?:please\s+)?(?:find|show|open|locate)(?:\s+me)?\s+(?:the\s+)?(?:customers?|contacts?|parts?|assembl(?:y|ies)|pcbs?|machines?)\b/i.test(
      query.text
    );
  const partIntent =
    !manualIntent &&
    /^(?:please\s+)?(?:find|show|open|locate)(?:\s+me)?\s+(?:the\s+)?(?:parts?|items?)\b/i.test(
      query.text
    );
  if (
    !ticketIntent &&
    !purchaseIntent &&
    !manualIntent &&
    !genericIntent &&
    !partIntent &&
    !query.context?.source
  )
    return null;
  const sources = await permittedSources(
    options.pool,
    identity,
    options.configuration,
    query.context?.source
  );
  if (manualIntent)
    return resolveRecentManual({
      ...options,
      sourceIds: sources.map((source) => source.id)
    });
  const registry = createSourceRegistry(options.configuration, options);
  const selected = sources.filter((source) =>
    ticketIntent
      ? source.kind === "kanban"
      : purchaseIntent
        ? source.kind === "carbon"
        : partIntent
          ? source.kind === "carbon" ||
            source.kind === "engineering" ||
            source.kind === "crm"
          : source.kind === "engineering" || source.kind === "crm"
  );
  if (!selected.length) return null;
  const evidence: Evidence[] = [];
  let partial = false;
  let blocking: SourceOutcome | null = null;
  const observedAt = now("UTC").toAbsoluteString();
  const results = await Promise.allSettled(
    selected.map(async (source) => {
      if (ticketIntent) {
        const search = query.text
          .replace(/^(?:please\s+)?(?:find|show|open|locate)(?:\s+me)?\s+/i, "")
          .replace(/\b(?:tickets?|tasks?|the|for)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!search) return [];
        const result = await registry.kanban(source.id).searchTickets(search);
        if (result.nextCursor) partial = true;
        return result.items.slice(0, 8).map((ticket) => ({
          id: revision([source.id, ticket.id]),
          sourceId: source.id,
          entityId: ticket.id,
          sourceRevision: result.sourceRevision,
          title: ticket.title,
          excerpt: [
            ticket.description?.slice(0, 2000),
            ticket.dueDate ? `Due: ${ticket.dueDate}` : undefined
          ]
            .filter(Boolean)
            .join("\n"),
          sourceUri: new URL(
            `/sources/${encodeURIComponent(source.id)}/entities/${encodeURIComponent(ticket.id)}`,
            options.origin
          ).toString(),
          observedAt,
          policyVersion: identity.principal.policyVersion,
          freshness: "current" as const
        }));
      }
      if (source.kind === "carbon" && partIntent) {
        const search = query.text
          .replace(/^(?:please\s+)?(?:find|show|open|locate)(?:\s+me)?\s+/i, "")
          .replace(/\b(?:parts?|items?|the|for)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!search) return [];
        const { outcome, page } = await registry
          .adapter(source.id)
          .searchEntities({ query: search, limit: 40 });
        if (!page) {
          blocking = outcome;
          return [];
        }
        if (page.status !== "complete") partial = true;
        return page.items.slice(0, 8).map((entity) => ({
          id: revision([source.id, entity.id]),
          sourceId: source.id,
          entityId: entity.id,
          sourceRevision: entity.revision,
          title: entity.title,
          excerpt: Object.entries(entity.fields)
            .filter(([key, value]) => key !== "link" && value !== null)
            .slice(0, 6)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n"),
          // The owning application's authenticated page: Carbon re-authorizes
          // on open, and the freshness stamp says when this row was observed.
          sourceUri:
            typeof entity.fields.link === "string"
              ? entity.fields.link
              : new URL(
                  `/sources/${encodeURIComponent(source.id)}/entities/${encodeURIComponent(entity.id)}`,
                  options.origin
                ).toString(),
          observedAt: page.observedAt,
          policyVersion: identity.principal.policyVersion,
          freshness: (page.status === "complete" ? "current" : "partial") as
            | "current"
            | "partial"
        }));
      }
      if (source.kind === "engineering" || source.kind === "crm") {
        const page = await registry
          .generic(source.id)
          .searchEntities({ query: query.text, limit: 40 });
        if (page.status !== "complete" || page.nextCursor) partial = true;
        return page.items.slice(0, 8).map((entity) => ({
          id: revision([source.id, entity.id]),
          sourceId: source.id,
          entityId: entity.id,
          sourceRevision: page.sourceRevision,
          title: entity.title,
          excerpt:
            entity.description?.slice(0, 2000) ??
            Object.entries(entity.fields)
              .slice(0, 5)
              .map(([key, value]) => `${key}: ${value}`)
              .join("\n"),
          sourceUri: new URL(
            `/sources/${encodeURIComponent(source.id)}/entities/${encodeURIComponent(entity.id)}`,
            options.origin
          ).toString(),
          observedAt: page.observedAt,
          policyVersion: identity.principal.policyVersion,
          freshness: "current" as const
        }));
      }
      const purchaseId = purchaseIntent?.[1];
      if (!purchaseId) return [];
      const purchase = await registry
        .carbon(source.id)
        .purchaseStatus(purchaseId);
      if (!purchase) return [];
      return [
        {
          id: revision([source.id, purchase.id]),
          sourceId: source.id,
          entityId: purchase.id,
          sourceRevision: revision(purchase),
          title: `Purchase order ${purchase.purchaseOrderId}`,
          excerpt: `Status: ${purchase.status}`,
          sourceUri: new URL(
            `/sources/${encodeURIComponent(source.id)}/entities/${encodeURIComponent(purchase.id)}?kind=purchase-order`,
            options.origin
          ).toString(),
          observedAt,
          policyVersion: identity.principal.policyVersion,
          freshness: "current" as const
        }
      ];
    })
  );
  for (const result of results) {
    if (result.status === "fulfilled") evidence.push(...result.value);
    else partial = true;
  }
  if (
    !ticketIntent &&
    !purchaseIntent &&
    !partIntent &&
    !query.context?.source &&
    !evidence.length &&
    !partial
  )
    return null;
  const base: QueryResult = {
    requestId: query.requestId,
    kind: evidence.length ? "results" : "abstention",
    evidence: evidence.slice(0, 8),
    claims: [],
    message: evidence.length
      ? ""
      : partial
        ? "A source could not complete this request; this is not an empty result."
        : "No authorized matching records were found.",
    partial
  };
  // A structured refusal from a source outranks an empty page: an outage or a
  // denial is never rendered as an authoritative "nothing found".
  const structured =
    blocking && !evidence.length ? outcomeResult(base, blocking) : null;
  return structured ?? base;
}
