import { parseAbsolute } from "@internationalized/date";
import {
  PORTAL_COMPANY_HEADER,
  PORTAL_USER_EVIDENCE_HEADER
} from "../identity.server";
import {
  factQuerySchema,
  type SourceAdapterDescriptor,
  type SourceChange,
  type SourceKind,
  sourceAdapterDescriptorSchema
} from "./contract";
import { createGenericChangeFeed } from "./generic.server";
import {
  type MachineSourceRequestContext,
  type SourceRequestContext,
  SourceTransportError
} from "./http.server";
import { SOURCE_FACT_VALIDITY_SECONDS } from "./outcome";
import { createSourceRegistry } from "./registry.server";

/**
 * The reusable conformance suite for a producer of the finite read contract.
 *
 * It drives the producer through the SAME registry and generic adapter the
 * query service uses, so a producer that passes here is one the router can
 * consume with no code change. Every check names the contract clause it
 * proves; a failing check carries the reason, never hidden rows.
 */
export type ConformanceCheck = {
  id: string;
  passed: boolean;
  detail?: string;
};
export type ConformanceReport = {
  passed: boolean;
  checks: ConformanceCheck[];
};

export type SourceConformanceFixture = {
  source: { id: string; kind: SourceKind; origin: string; audience: string };
  /** What the producer claims; compared with the registry's declaration. */
  descriptor: SourceAdapterDescriptor;
  /** An authorized reader inside the boundary. */
  reader: SourceRequestContext;
  /** A reader outside it: another company, or off the record's ACL. */
  outsider: SourceRequestContext;
  /** The worker's machine credential for the change feed. */
  machine: MachineSourceRequestContext;
  probes: {
    /** A query the reader may see at least two rows for. */
    searchQuery: string;
    knownEntityId: string;
    /** Exists, but outside the reader's boundary. */
    forbiddenEntityId: string;
    /** Visible to the reader until the suite deletes it. */
    deletableEntityId: string;
  };
  deleteEntity: (id: string) => void | Promise<void>;
  /** A reader whose producer answers `429`; proves the limit is mapped, not swallowed. */
  throttled?: SourceRequestContext;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

function transportError(error: unknown): SourceTransportError {
  assert(
    error instanceof SourceTransportError,
    `Expected a SourceTransportError, got ${error instanceof Error ? error.message : String(error)}`
  );
  return error;
}

export async function runSourceConformance(
  fixture: SourceConformanceFixture
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  async function check(id: string, run: () => Promise<string | undefined>) {
    try {
      const detail = await run();
      checks.push({ id, passed: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      checks.push({
        id,
        passed: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const descriptor = fixture.descriptor;
  const configuration = { version: 1 as const, sources: [fixture.source] };
  const registry = createSourceRegistry(configuration, fixture.reader);
  const adapter = registry.generic(fixture.source.id);
  const maxLimit = descriptor.pagination.maxLimit;
  const { knownEntityId, forbiddenEntityId, deletableEntityId } =
    fixture.probes;

  async function walkSearch(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page <= maxLimit; page += 1) {
      const result = await adapter.searchEntities({
        query: fixture.probes.searchQuery,
        limit: 1,
        ...(cursor ? { cursor } : {})
      });
      assert(result.items.length <= 1, "A page exceeded its limit");
      for (const item of result.items) ids.push(item.id);
      if (!result.nextCursor) {
        assert(result.status === "complete", "The last page is not complete");
        return ids;
      }
      assert(result.status === "partial", "A continued page must be partial");
      assert(result.nextCursor !== cursor, "A cursor repeated itself");
      cursor = result.nextCursor;
    }
    throw Error("Pagination did not terminate within the declared limit");
  }

  await check("descriptor.valid", async () => {
    sourceAdapterDescriptorSchema.parse(descriptor);
    assert(descriptor.kind === fixture.source.kind, "Descriptor kind mismatch");
    return undefined;
  });
  await check("descriptor.registered", async () => {
    assert(
      JSON.stringify(registry.describe(fixture.source.id)) ===
        JSON.stringify(descriptor),
      "The registry declares a different contract than the producer"
    );
    return undefined;
  });
  await check("descriptor.freshness-bounded", async () => {
    assert(
      descriptor.freshness.factValiditySeconds <= SOURCE_FACT_VALIDITY_SECONDS,
      "Fact validity exceeds the shared live-fact rule"
    );
    return undefined;
  });

  let bounded: string[] = [];
  await check("search.bounded", async () => {
    const page = await adapter.searchEntities({
      query: fixture.probes.searchQuery,
      limit: maxLimit
    });
    assert(page.items.length >= 2, "The search probe must match two rows");
    assert(page.items.length <= maxLimit, "Search exceeded the declared limit");
    for (const item of page.items) {
      assert(
        descriptor.entityTypes.includes(item.type),
        `Undeclared entity type ${item.type}`
      );
      for (const key of Object.keys(item.fields))
        assert(
          descriptor.projections.fields.includes(key),
          `Undeclared projection field ${key}`
        );
    }
    parseAbsolute(page.observedAt, "UTC");
    bounded = page.items.map((item) => item.id);
    return `${page.items.length} rows`;
  });
  await check("search.deep-links", async () => {
    const page = await adapter.searchEntities({
      query: fixture.probes.searchQuery,
      limit: maxLimit
    });
    for (const item of page.items) {
      const link = item.fields[descriptor.deepLinks.field];
      assert(
        typeof link === "string" &&
          link.startsWith(`${fixture.source.origin}/`),
        `Row ${item.id} has no deep link into the owning application`
      );
    }
    return undefined;
  });
  await check("search.pagination", async () => {
    const walked = await walkSearch();
    assert(
      new Set(walked).size === walked.length,
      "A row repeated across pages"
    );
    assert(
      JSON.stringify(walked) === JSON.stringify(bounded),
      "Walking the cursor did not reproduce the bounded page"
    );
    return `${walked.length} pages`;
  });
  await check("search.boundary", async () => {
    assert(
      !bounded.includes(forbiddenEntityId),
      "A search listed a row outside the reader's boundary"
    );
    return undefined;
  });

  await check("entity.get", async () => {
    const entity = await adapter.getEntity(knownEntityId);
    assert(entity.id === knownEntityId, "The producer returned another entity");
    assert(entity.revision.length > 0, "An entity needs a revision");
    return entity.revision;
  });
  await check("entity.immutable-revision", async () => {
    if (descriptor.freshness.revisions !== "immutable")
      return "declared mutable";
    const [first, second] = await Promise.all([
      adapter.getEntity(knownEntityId),
      adapter.getEntity(knownEntityId)
    ]);
    assert(
      JSON.stringify(first) === JSON.stringify(second),
      "The same revision was served with different content"
    );
    return undefined;
  });
  await check("entity.forbidden-denied", async () => {
    const error = await adapter.getEntity(forbiddenEntityId).then(
      () => undefined,
      (caught: unknown) => caught
    );
    assert(
      transportError(error).reason === "denied",
      "A record outside the boundary must be a denial, not a result"
    );
    return undefined;
  });
  await check("entity.outsider-denied", async () => {
    const outsider = createSourceRegistry(configuration, fixture.outsider);
    const error = await outsider
      .generic(fixture.source.id)
      .getEntity(knownEntityId)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    assert(
      transportError(error).reason === "denied",
      "An outsider read a record inside the boundary"
    );
    return undefined;
  });

  await check("facts.declared", async () => {
    for (const fact of descriptor.projections.facts) {
      const result = await adapter.queryFacts({
        entityId: knownEntityId,
        fact
      });
      assert(
        result.entityId === knownEntityId,
        `Fact ${fact} names another entity`
      );
      assert(result.facts.length >= 1, `Fact ${fact} answered nothing`);
      parseAbsolute(result.observedAt, "UTC");
    }
    return descriptor.projections.facts.join(",");
  });
  await check("facts.undeclared-rejected", async () => {
    const undeclared = factQuerySchema.shape.fact.options.find(
      (fact) => !descriptor.projections.facts.includes(fact)
    );
    if (!undeclared) return "every fact declared";
    const error = await adapter
      .queryFacts({ entityId: knownEntityId, fact: undeclared })
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    assert(error !== undefined, `Undeclared fact ${undeclared} was answered`);
    return undeclared;
  });

  await check("documents.references", async () => {
    const page = await adapter.getDocumentReferences(knownEntityId);
    assert(page.items.length <= maxLimit, "References exceeded the limit");
    for (const item of page.items) {
      assert(
        item.entityId === knownEntityId,
        "A reference names another entity"
      );
      assert(item.documentVersionId.length > 0, "A reference needs a version");
    }
    return `${page.items.length} references`;
  });

  await check("access.subset", async () => {
    const result = await adapter.checkAccess([
      knownEntityId,
      forbiddenEntityId,
      "missing-record"
    ]);
    assert(
      result.allowedIds.includes(knownEntityId),
      "The known row was denied"
    );
    assert(
      !result.allowedIds.includes(forbiddenEntityId),
      "The forbidden row was allowed"
    );
    assert(
      !result.allowedIds.includes("missing-record"),
      "A missing id was allowed"
    );
    parseAbsolute(result.validUntil, "UTC");
    return undefined;
  });

  await check("deletion.not-found", async () => {
    const before = await adapter.getEntity(deletableEntityId);
    assert(
      before.id === deletableEntityId,
      "The deletable row was not readable"
    );
    await fixture.deleteEntity(deletableEntityId);
    const error = await adapter.getEntity(deletableEntityId).then(
      () => undefined,
      (caught: unknown) => caught
    );
    assert(
      transportError(error).status === 404,
      "A deleted row is still served"
    );
    const walked = await walkSearch();
    assert(
      !walked.includes(deletableEntityId),
      "A deleted row is still listed"
    );
    const access = await adapter.checkAccess([deletableEntityId]);
    assert(access.allowedIds.length === 0, "A deleted row is still accessible");
    return undefined;
  });

  const seen: Headers[] = [];
  const machineFetch = fixture.machine.fetch ?? fetch;
  const feed = createGenericChangeFeed(fixture.source, {
    ...fixture.machine,
    fetch: async (input, init) => {
      seen.push(new Headers(init?.headers));
      return machineFetch(input, init);
    }
  });
  const events: SourceChange[] = [];
  await check("events.tombstone", async () => {
    if (descriptor.events.feed === "none") return "no feed declared";
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await feed.getChanges({
        limit: 100,
        ...(cursor ? { cursor } : {})
      });
      events.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    for (const event of events) {
      assert(
        descriptor.events.eventTypes.includes(event.eventType),
        `Undeclared event type ${event.eventType}`
      );
      if (event.eventType === "delete")
        assert(!event.entity, "A tombstone carried a projection");
    }
    const tombstone = events.find(
      (event) =>
        event.entityId === deletableEntityId && event.eventType === "delete"
    );
    assert(
      descriptor.events.deletion !== "tombstone-event" || tombstone,
      "The feed carries no tombstone for the deleted row"
    );
    return `${events.length} events`;
  });
  await check("events.machine-only", async () => {
    assert(seen.length > 0, "The feed was never read");
    for (const headers of seen) {
      assert(
        !headers.has(PORTAL_USER_EVIDENCE_HEADER),
        "Employee evidence reached the feed"
      );
      assert(
        headers.get("authorization")?.startsWith("Bearer "),
        "No service credential"
      );
      assert(
        headers.get(PORTAL_COMPANY_HEADER) === fixture.machine.companyId,
        "No company scope"
      );
    }
    const forged = await machineFetch(
      new URL("/api/knowledge/changes?limit=1", fixture.source.origin),
      {
        method: "GET",
        headers: {
          authorization: await fixture.machine.authorizationHeader(),
          [PORTAL_COMPANY_HEADER]: fixture.machine.companyId,
          [PORTAL_USER_EVIDENCE_HEADER]: "forwarded-evidence"
        }
      }
    );
    assert(
      forged.status === 401 || forged.status === 403,
      "The producer accepted employee evidence on machine ingress"
    );
    return undefined;
  });

  await check("rate-limit.mapped", async () => {
    if (!fixture.throttled) return "no throttled reader supplied";
    const throttled = createSourceRegistry(configuration, fixture.throttled);
    const error = await throttled
      .generic(fixture.source.id)
      .getEntity(knownEntityId)
      .then(
        () => undefined,
        (caught: unknown) => caught
      );
    assert(
      transportError(error).status === 429,
      "A rate limit was not surfaced"
    );
    return `${descriptor.rateLimit.requestsPerMinute}/min`;
  });

  return { passed: checks.every((entry) => entry.passed), checks };
}
