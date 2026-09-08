import {
  createWorkforceForwardingHeaders,
  type VerifiedWorkforceIdentity
} from "@carbon/knowledge/identity.server";
import type { RetrievedChunk } from "@carbon/knowledge/retrieval/lexical.server";
export function createDriveAccessChecker(options: {
  request: Request;
  identity: VerifiedWorkforceIdentity;
  workerOrigin?: string;
  workerAudience?: string;
}) {
  const cache = new Map<string, { allowed: boolean; expiresAt: number }>();
  let headers: Promise<Headers> | undefined;
  return async (chunk: RetrievedChunk) => {
    if (chunk.sourceKind !== "drive") return true;
    if (!options.workerOrigin || !options.workerAudience) return false;
    const key = JSON.stringify([chunk.sourceId, chunk.sourceItemId]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > performance.now()) return cached.allowed;
    try {
      const origin = new URL(options.workerOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        return false;
      headers ??= createWorkforceForwardingHeaders({
        request: options.request,
        targetAudience: options.workerAudience,
        companyId: options.identity.principal.companyId,
        verified: options.identity
      });
      const response = await fetch(
        new URL(
          `/v1/drive/${encodeURIComponent(chunk.sourceId)}/documents/${encodeURIComponent(chunk.sourceItemId)}/access`,
          origin
        ),
        {
          method: "POST",
          headers: await headers,
          redirect: "error",
          signal: AbortSignal.any([
            options.request.signal,
            AbortSignal.timeout(1000)
          ])
        }
      );
      const allowed = response.ok;
      await response.body?.cancel();
      cache.set(key, { allowed, expiresAt: performance.now() + 1000 });
      return allowed;
    } catch {
      return false;
    }
  };
}
