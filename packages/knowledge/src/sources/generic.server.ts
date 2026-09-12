import {
  accessResultSchema,
  type ChangePage,
  changePageSchema,
  documentReferencePageSchema,
  entityPageSchema,
  factQuerySchema,
  factsSchema,
  SOURCE_CONTRACT_SCHEMA_VERSION,
  type SourceAdapterDescriptor,
  sourceAdapterDescriptorSchema,
  sourceEntitySchema,
  sourceSearchSchema
} from "./contract";
import {
  createMachineSourceTransport,
  createSourceTransport,
  type MachineSourceRequestContext,
  type SourceConnection,
  type SourceRequestContext
} from "./http.server";
import { SOURCE_FACT_VALIDITY_SECONDS } from "./outcome";

/**
 * What an engineering or CRM producer publishes. The two kinds share one
 * adapter and one wire contract; they differ only in the entity types they
 * own and the facts they can answer, so that is all the descriptor varies.
 */
export function genericSourceDescriptor(
  kind: "engineering" | "crm"
): SourceAdapterDescriptor {
  return sourceAdapterDescriptorSchema.parse({
    kind,
    schemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    capabilities: [
      "entities.search",
      "entities.get",
      "facts.query",
      "documents.references",
      "access.check",
      "changes.feed"
    ],
    entityTypes:
      kind === "engineering"
        ? ["part", "assembly", "pcb", "machine"]
        : ["customer", "contact"],
    auth: {
      human: "workforce-forwarding",
      machine: "service-token",
      requiredCapability: "knowledge.read"
    },
    filters: ["query", "entityId", "cursor", "limit"],
    projections: {
      fields:
        kind === "engineering"
          ? [
              "status",
              "approvedAt",
              "approvedBy",
              "units",
              "massKg",
              "boardThicknessMm",
              "layerCount",
              "link"
            ]
          : ["status", "territory", "accountOwner", "email", "phone", "link"],
      facts:
        kind === "engineering"
          ? ["status", "revision", "availability"]
          : ["status", "contact-summary"]
    },
    freshness: {
      factValiditySeconds: SOURCE_FACT_VALIDITY_SECONDS,
      revisions: "immutable"
    },
    pagination: { style: "cursor", maxLimit: 40 },
    rateLimit: { requestsPerMinute: 600, concurrent: 8 },
    events: {
      feed: "cursor",
      eventTypes: ["upsert", "delete", "acl-change"],
      deletion: "tombstone-event"
    },
    deepLinks: { field: "link", authorizedOnOpen: true }
  });
}

/** Engineering/CRM producers implement this finite read contract before enrollment. */
export function createGenericReadAdapter(
  connection: SourceConnection,
  context: SourceRequestContext
) {
  const transport = createSourceTransport(connection, context);
  return {
    async searchEntities(input: unknown) {
      return entityPageSchema.parse(
        await transport.post(
          "/api/knowledge/entities/search",
          sourceSearchSchema.parse(input)
        )
      );
    },
    async getEntity(id: string) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(id))
        throw Error("Invalid entity identifier");
      return sourceEntitySchema.parse(
        await transport.get(`/api/knowledge/entities/${id}`)
      );
    },
    async queryFacts(input: unknown) {
      return factsSchema.parse(
        await transport.post(
          "/api/knowledge/facts/query",
          factQuerySchema.parse(input)
        )
      );
    },
    async getDocumentReferences(entityId: string) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(entityId))
        throw Error("Invalid entity identifier");
      return documentReferencePageSchema.parse(
        await transport.post("/api/knowledge/documents/references", {
          entityId,
          limit: 40
        })
      );
    },
    async checkAccess(ids: string[]) {
      if (
        ids.length < 1 ||
        ids.length > 40 ||
        ids.some((id) => !id || id.length > 256)
      )
        throw Error("Invalid access projection");
      const result = accessResultSchema.parse(
        await transport.post("/api/knowledge/access/check", { ids })
      );
      if (result.allowedIds.some((id) => !ids.includes(id)))
        throw Error("Source expanded the requested access scope");
      return result;
    }
  };
}
export type GenericReadAdapter = ReturnType<typeof createGenericReadAdapter>;

/**
 * A producer's cursor feed, read by the worker with a service credential and
 * never with employee evidence. A delete arrives as a tombstone; the page is
 * the contract's own shape, so nothing about hidden rows is carried.
 */
export function createGenericChangeFeed(
  connection: SourceConnection,
  context: MachineSourceRequestContext
) {
  const transport = createMachineSourceTransport(connection, context);
  return {
    async getChanges(input: {
      cursor?: string;
      limit: number;
    }): Promise<ChangePage> {
      const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 100);
      if (input.cursor && !/^[A-Za-z0-9_.-]{1,512}$/.test(input.cursor))
        throw Error("Invalid changes cursor");
      const query = new URLSearchParams({
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: `${limit}`
      });
      return changePageSchema.parse(
        await transport.get(`/api/knowledge/changes?${query.toString()}`)
      );
    }
  };
}
