import { createServiceAuthorizationHeader } from "@carbon/knowledge/identity.server";

export function createDriveTokenBroker(options: {
  url: string;
  audience: string;
  fetchImpl?: typeof fetch;
  authorizationHeader?: () => Promise<string>;
}) {
  const url = new URL(options.url);
  if (url.protocol !== "https:")
    throw new Error("Drive token broker URL must use HTTPS");
  return async (request: {
    kind: "connector" | "user";
    sourceId: string;
    actorId?: string;
  }): Promise<string | null> => {
    const authorization = await (
      options.authorizationHeader ??
      (() => createServiceAuthorizationHeader(options.audience))
    )();
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok)
      throw new Error(`Drive credential broker failed (${response.status})`);
    const body = (await response.json()) as { accessToken?: unknown };
    return typeof body.accessToken === "string" && body.accessToken.trim()
      ? body.accessToken
      : null;
  };
}
