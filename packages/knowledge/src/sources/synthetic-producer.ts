import { now } from "@internationalized/date";
import { z } from "zod";
import {
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER
} from "../identity.server";
import {
  accessResultSchema,
  changePageSchema,
  documentReferencePageSchema,
  type documentReferenceSchema,
  entityPageSchema,
  factQuerySchema,
  factsSchema,
  type SourceAdapterDescriptor,
  type SourceChange,
  sourceEntitySchema,
  sourceSearchSchema
} from "./contract";
import { factValidUntil } from "./outcome";

/**
 * The owner side of the finite read contract, in memory. A future CAD, PCB or
 * CRM application publishes exactly these routes; the knowledge side reads
 * them through the unchanged generic adapter. This scaffold exists so the two
 * example producers and the conformance suite agree on one wire behaviour:
 *
 * - employee reads require the trusted-forwarder pair and the company scope;
 *   the evidence value stands in for the verified subject (synthetic only);
 * - the machine feed refuses forwarded employee evidence outright;
 * - a record outside the caller's boundary is `403`, a deleted or unknown one
 *   is `404`, and a search never lists either;
 * - deletion appends a tombstone with no projection to the cursor feed.
 */
export type SourceEntity = z.infer<typeof sourceEntitySchema>;
export type FactKind = z.infer<typeof factQuerySchema>["fact"];
export type Fact = { label: string; value: string };
export type SyntheticAttachment = z.infer<typeof documentReferenceSchema>;
export type SyntheticRecord = {
  companyId: string;
  /** Verified subjects allowed to read the record; empty means every company member. */
  readers: readonly string[];
  entity: SourceEntity;
  facts: Partial<Record<FactKind, readonly Fact[]>>;
  attachments: readonly SyntheticAttachment[];
  searchTerms: readonly string[];
};

export type SyntheticProducerOptions = {
  descriptor: SourceAdapterDescriptor;
  origin: string;
  audience: string;
  records: readonly SyntheticRecord[];
  /** Deterministic time for fixtures; defaults to the UTC clock. */
  clock?: () => string;
  /** Answer `429` once this many requests have been served; absent means never. */
  rateLimitAfter?: number;
};

type Principal = { companyId: string; subject: string };

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function authenticate(
  headers: Headers,
  mode: "human" | "machine"
): Principal | Response {
  const authorization = headers.get("authorization");
  const companyId = headers.get(PORTAL_COMPANY_HEADER)?.trim();
  const evidence = headers.get(PORTAL_USER_EVIDENCE_HEADER)?.trim();
  if (!authorization?.startsWith("Bearer ") || !companyId)
    return json({ error: "unauthorized" }, 401);
  if (mode === "machine") {
    // A source indexer is never an employee; evidence on machine ingress is a
    // configuration error, refused rather than ignored.
    if (evidence) return json({ error: "forbidden" }, 403);
    return { companyId, subject: "" };
  }
  if (!evidence) return json({ error: "unauthorized" }, 401);
  return { companyId, subject: evidence };
}

export function createSyntheticProducer(options: SyntheticProducerOptions) {
  const clock = options.clock ?? (() => now("UTC").toAbsoluteString());
  const records = new Map<string, SyntheticRecord>();
  const deleted = new Set<string>();
  const events: SourceChange[] = [];
  let requests = 0;

  function record(entry: SyntheticRecord, eventType: "upsert" | "acl-change") {
    sourceEntitySchema.parse(entry.entity);
    records.set(entry.entity.id, entry);
    events.push({
      id: `evt-${events.length + 1}`,
      entityType: entry.entity.type,
      entityId: entry.entity.id,
      sourceVersion: entry.entity.revision,
      eventType,
      observedAt: clock(),
      entity: entry.entity
    });
  }
  for (const entry of options.records) record(entry, "upsert");

  function visible(entry: SyntheticRecord, principal: Principal): boolean {
    return (
      !deleted.has(entry.entity.id) &&
      entry.companyId === principal.companyId &&
      (entry.readers.length === 0 || entry.readers.includes(principal.subject))
    );
  }
  function lookup(
    id: string,
    principal: Principal
  ): SyntheticRecord | Response {
    const entry = records.get(id);
    if (!entry || deleted.has(id)) return json({ error: "not_found" }, 404);
    if (!visible(entry, principal)) return json({ error: "forbidden" }, 403);
    return entry;
  }
  function epoch(): string {
    return `${options.descriptor.kind}:${events.length}`;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    requests += 1;
    if (
      options.rateLimitAfter !== undefined &&
      requests > options.rateLimitAfter
    )
      return json({ error: "rate_limited" }, 429, { "retry-after": "60" });
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== options.origin) return json({ error: "not_found" }, 404);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const parseBody = <T>(schema: z.ZodType<T>): T | Response => {
      try {
        return schema.parse(JSON.parse(body ?? ""));
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
    };

    if (url.pathname === "/api/knowledge/changes") {
      if (method !== "GET") return json({ error: "method" }, 405);
      const principal = authenticate(headers, "machine");
      if (principal instanceof Response) return principal;
      const limit = Math.min(
        Math.max(Number(url.searchParams.get("limit") ?? "100"), 1),
        100
      );
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const scoped = events.filter(
        (event) =>
          records.get(event.entityId)?.companyId === principal.companyId
      );
      const items = scoped.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + limit < scoped.length ? `${cursor + limit}` : undefined;
      return json(
        changePageSchema.parse({
          items,
          ...(nextCursor ? { nextCursor } : {}),
          observedAt: clock(),
          sourceRevision: epoch(),
          status: nextCursor ? "partial" : "complete",
          ...(nextCursor
            ? { incompleteReason: "more-changes-behind-cursor" }
            : {})
        })
      );
    }

    const principal = authenticate(headers, "human");
    if (principal instanceof Response) return principal;

    const entityPath =
      url.pathname === "/api/knowledge/entities/search"
        ? null
        : /^\/api\/knowledge\/entities\/([A-Za-z0-9_-]{1,256})$/.exec(
            url.pathname
          );
    if (entityPath?.[1]) {
      if (method !== "GET") return json({ error: "method" }, 405);
      const entry = lookup(entityPath[1], principal);
      return entry instanceof Response ? entry : json(entry.entity);
    }
    if (method !== "POST") return json({ error: "method" }, 405);

    if (url.pathname === "/api/knowledge/entities/search") {
      const search = parseBody(sourceSearchSchema);
      if (search instanceof Response) return search;
      const tokens = search.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = [...records.values()]
        .filter((entry) => visible(entry, principal))
        .filter((entry) => {
          const haystack = entry.searchTerms.join(" ").toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        })
        .sort((a, b) => a.entity.id.localeCompare(b.entity.id));
      const limit = Math.min(
        search.limit,
        options.descriptor.pagination.maxLimit
      );
      const offset = Number(search.cursor ?? "0");
      const items = matches.slice(offset, offset + limit).map((m) => m.entity);
      const nextCursor =
        offset + limit < matches.length ? `${offset + limit}` : undefined;
      return json(
        entityPageSchema.parse({
          items,
          ...(nextCursor ? { nextCursor } : {}),
          observedAt: clock(),
          sourceRevision: epoch(),
          status: nextCursor ? "partial" : "complete",
          ...(nextCursor
            ? { incompleteReason: "more-results-behind-cursor" }
            : {})
        })
      );
    }
    if (url.pathname === "/api/knowledge/facts/query") {
      const query = parseBody(factQuerySchema);
      if (query instanceof Response) return query;
      if (!options.descriptor.projections.facts.includes(query.fact))
        return json({ error: "unsupported_fact" }, 400);
      const entry = lookup(query.entityId, principal);
      if (entry instanceof Response) return entry;
      return json(
        factsSchema.parse({
          entityId: entry.entity.id,
          sourceRevision: entry.entity.revision,
          observedAt: clock(),
          facts: entry.facts[query.fact] ?? []
        })
      );
    }
    if (url.pathname === "/api/knowledge/documents/references") {
      const input = parseBody(
        z.object({ entityId: z.string().min(1).max(256), limit: z.number() })
      );
      if (input instanceof Response) return input;
      const entry = lookup(input.entityId, principal);
      if (entry instanceof Response) return entry;
      const limit = Math.min(
        input.limit,
        options.descriptor.pagination.maxLimit
      );
      return json(
        documentReferencePageSchema.parse({
          items: entry.attachments.slice(0, limit),
          observedAt: clock(),
          sourceRevision: entry.entity.revision,
          status: entry.attachments.length > limit ? "partial" : "complete",
          ...(entry.attachments.length > limit
            ? { incompleteReason: "bounded-result-truncated" }
            : {})
        })
      );
    }
    if (url.pathname === "/api/knowledge/access/check") {
      const input = parseBody(
        z.object({ ids: z.array(z.string().min(1).max(256)).min(1).max(40) })
      );
      if (input instanceof Response) return input;
      const observedAt = clock();
      return json(
        accessResultSchema.parse({
          allowedIds: input.ids.filter((id) => {
            const entry = records.get(id);
            return entry !== undefined && visible(entry, principal);
          }),
          policyVersion: epoch(),
          validUntil: factValidUntil(observedAt)
        })
      );
    }
    return json({ error: "not_found" }, 404);
  };

  return {
    descriptor: options.descriptor,
    connection: { origin: options.origin, audience: options.audience },
    fetch: fetchImpl,
    /** Source deletion: the row is gone, and the feed carries only a tombstone. */
    delete(id: string): void {
      const entry = records.get(id);
      if (!entry || deleted.has(id)) return;
      deleted.add(id);
      events.push({
        id: `evt-${events.length + 1}`,
        entityType: entry.entity.type,
        entityId: id,
        sourceVersion: entry.entity.revision,
        eventType: "delete",
        observedAt: clock(),
        entity: null
      });
    },
    /** Publish a new immutable projection of a record; the previous one is never rewritten. */
    publish(entry: SyntheticRecord): void {
      const previous = records.get(entry.entity.id);
      if (previous && previous.entity.revision === entry.entity.revision)
        throw Error("A revision is immutable; publish a new revision");
      deleted.delete(entry.entity.id);
      record(entry, "upsert");
    },
    /** Change who may read a record; the feed carries an `acl-change`, never the reader list. */
    restrict(id: string, readers: readonly string[]): void {
      const entry = records.get(id);
      if (!entry) return;
      record({ ...entry, readers }, "acl-change");
    },
    requestCount: () => requests
  };
}
export type SyntheticProducer = ReturnType<typeof createSyntheticProducer>;
