import { describe, expect, it } from "vitest";
import { isKnowledgeWebReady } from "./health";

const configured = {
  KNOWLEDGE_COMPANY_ID: "company-example",
  KNOWLEDGE_MANUAL_SOURCE_JSON:
    '{"sourceId":"manuals","displayName":"Manual library"}',
  KNOWLEDGE_QUERY_AUDIENCE: "query-audience",
  KNOWLEDGE_QUERY_URL: "https://query.example",
  KNOWLEDGE_RELEASE_PROFILE: "manual-v1",
  KNOWLEDGE_WEB_IAP_AUDIENCE: "iap-audience",
  KNOWLEDGE_WEB_ORIGIN: "https://manuals.example",
  KNOWLEDGE_WORKER_AUDIENCE: "worker-audience",
  KNOWLEDGE_WORKER_URL: "https://worker.example"
};

describe("manual-v1 web readiness", () => {
  it("fails closed for missing or deferred release profiles", () => {
    expect(isKnowledgeWebReady(configured)).toBe(true);
    expect(
      isKnowledgeWebReady({ ...configured, KNOWLEDGE_WORKER_URL: "" })
    ).toBe(false);
    expect(
      isKnowledgeWebReady({
        ...configured,
        KNOWLEDGE_RELEASE_PROFILE: "platform"
      })
    ).toBe(false);
  });
});
