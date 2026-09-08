import {
  accessResultSchema,
  documentReferencePageSchema,
  entityPageSchema,
  factQuerySchema,
  factsSchema,
  sourceEntitySchema,
  sourceSearchSchema
} from "./contract";
import {
  createSourceTransport,
  type SourceConnection,
  type SourceRequestContext
} from "./http.server";

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
