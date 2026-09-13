import { isMcpEnabled } from "@carbon/knowledge/mcp";
import {
  createMcpHandler,
  type McpRouteTable
} from "@carbon/knowledge/mcp/transport";

/**
 * The command service's optional MCP transport.
 *
 * The route table is this service's own command dispatch, so a tool call runs
 * the identical handler an HTTP command runs: the same per-request workforce
 * verification, the same command-specific capability check, the same board
 * authorization and the same durable idempotency key. MCP adds no command and
 * no privilege — a caller registration without the command operation is
 * refused inside the delegate, exactly as over HTTP.
 *
 * The mount is one line in `index.ts`'s dispatch and is 404 until the
 * deployment flag and a release profile past the approved manual boundary are
 * both set (see `contrib/deploying/knowledge/README.md`).
 */
export function createActionsMcpHandler(options: {
  environment: NodeJS.ProcessEnv;
  routes: McpRouteTable;
}): (request: Request) => Promise<Response> {
  return createMcpHandler({
    enabled: isMcpEnabled(options.environment),
    routes: options.routes,
    serverName: "knowledge-actions"
  });
}
