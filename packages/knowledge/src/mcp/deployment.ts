import { MANUAL_RELEASE_PROFILE } from "../release-profile";

/**
 * MCP deployment is OFF until an intended client has passed authentication and
 * HTTP/MCP permission parity against the real services. HTTP remains the
 * primary integration surface (plan Task 22 step 5), so this is not a feature
 * flag a deployment flips casually — it takes two independent, reviewable
 * changes:
 *
 * 1. `KNOWLEDGE_MCP_ENABLED=true` on the service, and
 * 2. a release profile that is NOT the approved `manual-v1` boundary, because
 *    that boundary is read-only document retrieval and deliberately activates
 *    no deferred surface even when old environment values are still present.
 *
 * A third lock sits outside the application: `contrib/deploying/knowledge/release.py`
 * rejects any environment key absent from its `REQUIRED_ENVIRONMENT` set as
 * deferred configuration, so the variable cannot reach a deployed revision
 * until that set is edited too. Unset, malformed and "1"/"yes" values are all
 * off — only the exact string `true` is on.
 */
export const MCP_ENABLED_VARIABLE = "KNOWLEDGE_MCP_ENABLED";

export function isMcpEnabled(
  environment: Record<string, string | undefined>
): boolean {
  if (environment[MCP_ENABLED_VARIABLE]?.trim() !== "true") return false;
  const profile =
    environment.KNOWLEDGE_RELEASE_PROFILE?.trim() || MANUAL_RELEASE_PROFILE;
  return profile !== MANUAL_RELEASE_PROFILE;
}
