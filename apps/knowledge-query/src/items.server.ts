import {
  type ItemSearchResult,
  itemSearchRequestSchema,
  itemSearchResultSchema
} from "@carbon/knowledge";
import { admitReadRequest } from "@carbon/knowledge/budgets.server";
import { withKnowledgeTransaction } from "@carbon/knowledge/database.server";
import { verifyWorkforceRequest } from "@carbon/knowledge/identity.server";
import type { SourceRequestContext } from "@carbon/knowledge/sources/http.server";
import {
  createSourceRegistry,
  type SourceRegistryConfiguration
} from "@carbon/knowledge/sources/registry.server";
import type { Pool } from "pg";

type IdentityOptions = Omit<
  Parameters<typeof verifyWorkforceRequest>[0],
  "request" | "operation"
>;

/** Bounded existing-item candidates for intake review. Reads go through the
 * registered Carbon canonical `resolveItems` operation only; nothing here can
 * create, link, or post anything. A library with no configured item source
 * answers `unavailable` so the reviewer can still publish a generic document. */
export function createItemSearchHandler(
  options: IdentityOptions & {
    pool: Pool;
    sources?: SourceRegistryConfiguration;
    /** Test seam: transport overrides for the registered source. */
    registryContext?: (
      context: SourceRequestContext
    ) => Partial<SourceRequestContext>;
  }
) {
  return async (request: Request): Promise<Response> => {
    try {
      const identity = await verifyWorkforceRequest({
        ...options,
        request,
        operation: "knowledge.query"
      });
      const principal = identity.principal;
      if (!principal.capabilities.includes("knowledge.read"))
        return Response.json({ error: "forbidden" }, { status: 403 });
      const parsed = itemSearchRequestSchema.safeParse(await request.json());
      if (!parsed.success)
        return Response.json({ error: "invalid_item_search" }, { status: 422 });
      if (!(await admitReadRequest(options.pool, principal, "knowledge.query")))
        return Response.json(
          { error: "request_limit_exceeded" },
          {
            status: 429,
            headers: { "cache-control": "no-store", "retry-after": "60" }
          }
        );
      const unavailable: ItemSearchResult = {
        items: [],
        status: "unavailable",
        incompleteReason: "No item source is configured for this library."
      };
      const configured = options.sources?.sources.filter(
        (source) => source.kind === "carbon"
      );
      if (!configured?.length)
        return Response.json(itemSearchResultSchema.parse(unavailable), {
          headers: { "cache-control": "no-store" }
        });
      const permitted = await withKnowledgeTransaction(
        options.pool,
        principal,
        "read",
        async (client) =>
          (
            await client.query<{ id: string }>(
              `SELECT id FROM knowledge.source WHERE "companyId"=$1 AND status='active' AND kind='carbon' AND id=ANY($2::text[]) ORDER BY id LIMIT 1`,
              [principal.companyId, configured.map((source) => source.id)]
            )
          ).rows
      );
      const source = permitted[0];
      if (!source)
        return Response.json(itemSearchResultSchema.parse(unavailable), {
          headers: { "cache-control": "no-store" }
        });
      const baseContext: SourceRequestContext = { request, identity };
      const registry = createSourceRegistry(options.sources!, {
        ...baseContext,
        ...options.registryContext?.(baseContext)
      });
      const items = await registry
        .carbon(source.id)
        .searchItems(parsed.data.search);
      const result: ItemSearchResult = {
        items: items.slice(0, parsed.data.limit).map((item) => ({
          id: item.id,
          readableId: item.readableId,
          name: item.name,
          revision: item.revision,
          mpn: item.mpn,
          sourceId: source.id
        })),
        status: items.length > parsed.data.limit ? "partial" : "complete",
        ...(items.length > parsed.data.limit
          ? { incompleteReason: "Narrow the search to see every candidate." }
          : {})
      };
      return Response.json(itemSearchResultSchema.parse(result), {
        headers: { "cache-control": "no-store" }
      });
    } catch {
      return Response.json(
        { error: "items_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } }
      );
    }
  };
}
