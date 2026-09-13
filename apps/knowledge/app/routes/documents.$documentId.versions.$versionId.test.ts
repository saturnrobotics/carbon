import { afterEach, describe, expect, it, vi } from "vitest";
import { loader } from "./documents.$documentId.versions.$versionId";

/**
 * This route is a resource route: it renders no ErrorBoundary, so a throw from
 * the identity gate reached React Router's last-resort handler and came back as
 * a 500 whose text/plain body was `Error: unauthorized workforce request`. A
 * server error is the wrong class for an unauthenticated download, and the
 * message was internal detail the browser had no business receiving.
 */
const environment = {
  KNOWLEDGE_COMPANY_ID: "company_synthetic",
  KNOWLEDGE_WORKER_URL: "https://worker.example.test",
  KNOWLEDGE_WORKER_AUDIENCE: "https://worker.example.test",
  KNOWLEDGE_WEB_IAP_AUDIENCE: "/projects/000/global/backendServices/portal"
};

function download() {
  return new Request(
    "https://knowledge.example.test/documents/doc/versions/version"
  );
}

const params = { documentId: "doc", versionId: "version" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a document version download", () => {
  it("answers an unauthenticated request with 401 and no internal detail", async () => {
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);

    const response = await loader({ request: download(), params });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "unauthorized" });
    // The class, never the reason: nothing here says whether the identity was
    // missing, forged, revoked, or simply another company's.
    expect(body).not.toContain("unauthorized workforce request");
    expect(body).not.toContain("Error");
  });

  it("keeps a misconfiguration an outage rather than a denial", async () => {
    for (const [name, value] of Object.entries(environment))
      vi.stubEnv(name, value);
    vi.stubEnv("KNOWLEDGE_COMPANY_ID", "");

    const response = await loader({ request: download(), params });

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "service_unavailable" });
    expect(body).not.toContain("Knowledge company selection is not configured");
  });
});
