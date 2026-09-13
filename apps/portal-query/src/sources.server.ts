import { createHash } from "node:crypto";
import type { Evidence, QueryRequest } from "@carbon/portal";
import { sourceEntityRequestSchema } from "@carbon/portal";
import { withPortalTransaction } from "@carbon/portal/database.server";
import type { VerifiedWorkforceIdentity } from "@carbon/portal/identity.server";
import type { QueryResult } from "@carbon/portal/query";
import { type QueryRoute, routeQuery } from "@carbon/portal/query/router";
import type { SourceOutcome } from "@carbon/portal/sources/contract";
import {
  createSourceRegistry,
  type SourceRegistryConfiguration
} from "@carbon/portal/sources/registry.server";
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
  const permitted = await withPortalTransaction(
    pool,
    identity.principal,
    "read",
    async (client) =>
      (
        await client.query<{ id: string; kind: string }>(
          `SELECT id,kind FROM portal.source WHERE "companyId"=$1 AND status='active' AND ($2::text IS NULL OR id=$2) ORDER BY id LIMIT 5`,
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

function entityEvidence(options: {
  sourceId: string;
  entity: {
    id: string;
    title: string;
    description?: string | null;
    revision: string;
    fields: Record<string, string | number | boolean | null>;
  };
  origin: string;
  observedAt: string;
  policyVersion: string;
}): Evidence {
  const { entity, sourceId } = options;
  return {
    id: revision([sourceId, entity.id]),
    sourceId,
    entityId: entity.id,
    sourceRevision: entity.revision,
    title: entity.title,
    excerpt:
      entity.description?.slice(0, 2000) ??
      Object.entries(entity.fields)
        .filter(([key, value]) => key !== "link" && value !== null)
        .slice(0, 6)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
    // The owning application's authenticated page when the source gave one.
    sourceUri:
      typeof entity.fields.link === "string"
        ? entity.fields.link
        : new URL(
            `/sources/${encodeURIComponent(sourceId)}/entities/${encodeURIComponent(entity.id)}`,
            options.origin
          ).toString(),
    observedAt: options.observedAt,
    policyVersion: options.policyVersion,
    freshness: "current"
  };
}

/** One record the reader chose from an ambiguity, read directly and once. */
async function selectedEntityEvidence(options: {
  registry: ReturnType<typeof createSourceRegistry>;
  source: { id: string; kind: string };
  entityId: string;
  origin: string;
  policyVersion: string;
}): Promise<{ evidence: Evidence[]; outcome: SourceOutcome | null }> {
  const { source, entityId, registry } = options;
  if (source.kind === "carbon" || source.kind === "kanban") {
    const result = await registry.adapter(source.id).getEntity(entityId);
    if (!result.entity) return { evidence: [], outcome: result.outcome };
    return {
      outcome: null,
      evidence: [
        entityEvidence({
          sourceId: source.id,
          entity: result.entity,
          origin: options.origin,
          observedAt: result.observedAt,
          policyVersion: options.policyVersion
        })
      ]
    };
  }
  const entity = await registry.generic(source.id).getEntity(entityId);
  if (entity.id !== entityId) throw Error("Source returned a different entity");
  return {
    outcome: null,
    evidence: [
      entityEvidence({
        sourceId: source.id,
        entity,
        origin: options.origin,
        observedAt: now("UTC").toAbsoluteString(),
        policyVersion: options.policyVersion
      })
    ]
  };
}

/**
 * Live facts bypass answer caching; each owner service enforces its own ACLs.
 * The intent is the router's deterministic decision, made from the request
 * text before this function runs; nothing a source returns can change it.
 */
export async function structuredSourceQuery(options: {
  request: Request;
  query: QueryRequest;
  /** The router's decision for `query`; derived from the text when omitted. */
  route?: QueryRoute;
  identity: VerifiedWorkforceIdentity;
  pool: Pool;
  configuration: SourceRegistryConfiguration;
  origin: string;
  businessTimezone?: string;
  workerOrigin?: string;
  workerAudience?: string;
}): Promise<QueryResult | null> {
  const { query, identity } = options;
  const intent = (options.route ?? routeQuery(query)).structured;
  const ticketIntent = intent?.kind === "tickets" ? intent : undefined;
  const purchaseIntent = intent?.kind === "purchase-order" ? intent : undefined;
  const manualIntent = intent?.kind === "received-manual";
  const partIntent = intent?.kind === "parts" ? intent : undefined;
  if (!intent && !query.context?.source) return null;
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
  const evidence: Evidence[] = [];
  let partial = false;
  let blocking: SourceOutcome | null = null;
  const observedAt = now("UTC").toAbsoluteString();
  const base = (): QueryResult => ({
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
  });
  // An ambiguity choice names one record; read it directly instead of
  // searching again, from the sources the intent would have searched.
  const chosen = query.context?.entityId;
  if (chosen && intent && !manualIntent && !purchaseIntent) {
    const candidates = sources.filter((source) =>
      ticketIntent
        ? source.kind === "kanban"
        : source.kind === "carbon" ||
          source.kind === "engineering" ||
          source.kind === "crm"
    );
    if (!candidates.length) return null;
    const results = await Promise.allSettled(
      candidates.map((source) =>
        selectedEntityEvidence({
          registry,
          source,
          entityId: chosen,
          origin: options.origin,
          policyVersion: identity.principal.policyVersion
        })
      )
    );
    for (const result of results) {
      if (result.status !== "fulfilled") {
        partial = true;
        continue;
      }
      evidence.push(...result.value.evidence);
      if (result.value.outcome && result.value.outcome.kind !== "not-found")
        blocking = result.value.outcome;
    }
    const structured =
      blocking && !evidence.length ? outcomeResult(base(), blocking) : null;
    return structured ?? base();
  }
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
  const results = await Promise.allSettled(
    selected.map(async (source) => {
      if (ticketIntent) {
        const search = ticketIntent.searchText;
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
        const search = partIntent.searchText;
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
      const purchaseId = purchaseIntent?.purchaseOrderId;
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
  // A structured refusal from a source outranks an empty page: an outage or a
  // denial is never rendered as an authoritative "nothing found".
  const structured =
    blocking && !evidence.length ? outcomeResult(base(), blocking) : null;
  return structured ?? base();
}
