import {
  type IdentityBinding,
  verifyWorkforceRequest,
  type WorkforceIdentityStore
} from "@carbon/knowledge/identity.server";

type Options = Omit<
  Parameters<typeof verifyWorkforceRequest>[0],
  "request" | "operation"
>;

export async function handleIdentityRequest(
  request: Request,
  options: Options
): Promise<Response> {
  let resolved: IdentityBinding | null = null;
  const identityStore: WorkforceIdentityStore = {
    resolveHuman: async (identity) => {
      resolved = await options.identityStore.resolveHuman(identity);
      return resolved;
    }
  };
  try {
    const identity = await verifyWorkforceRequest({
      ...options,
      request,
      operation: "knowledge.identity",
      identityStore
    });
    if (!resolved) throw new Error("Missing identity");
    return Response.json(
      {
        identity,
        binding: {
          ...(resolved as IdentityBinding),
          capabilities: identity.principal.capabilities
        }
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
}
