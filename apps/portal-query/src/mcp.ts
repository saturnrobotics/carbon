import { isMcpEnabled } from "@carbon/portal/mcp";
import {
  createMcpHandler,
  type McpRouteTable
} from "@carbon/portal/mcp/transport";

/**
 * The query service's optional MCP transport.
 *
 * It receives this service's own HTTP dispatch entries and can reach nothing
 * else, so an MCP caller gets the identity verification, caller authorization,
 * budgets and deadlines that route already performs — there is no second read
 * path to keep in step. Absent the deployment flag (and a release profile past
 * the approved manual boundary) the handler answers 404 exactly as an
 * unmounted path does.
 */
export function createQueryMcpHandler(options: {
  environment: NodeJS.ProcessEnv;
  routes: McpRouteTable;
}): (request: Request) => Promise<Response> {
  return createMcpHandler({
    enabled: isMcpEnabled(options.environment),
    routes: options.routes,
    serverName: "portal-query"
  });
}
