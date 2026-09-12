import { isServiceAudience } from "@carbon/knowledge/identity.server";

/**
 * The Carbon login link the step-up page offers. Read from
 * `KNOWLEDGE_CARBON_LOGIN_URL`; only a bare https URL (no credentials, query
 * or fragment) is ever rendered, and the page still explains what to do when
 * the link is not configured.
 */
export function carbonLoginUrl(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.KNOWLEDGE_CARBON_LOGIN_URL?.trim();
  return value && isServiceAudience(value) ? value : null;
}
