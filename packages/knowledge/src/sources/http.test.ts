import { describe, expect, it } from "vitest";
import { createSourceTransport } from "./http.server";

const identity = {
  principal: {
    kind: "human" as const,
    actorId: "alice",
    companyId: "company-a",
    callerId: "query",
    sourceIdentity: { issuer: "iap", subject: "a" },
    policyVersion: "1",
    capabilities: ["knowledge.read"]
  },
  companyGroupId: "g",
  allowedOperations: [],
  accessLevels: []
};
const request = new Request("https://query.example", {
  headers: {
    "x-portal-user-evidence": "signed",
    "x-portal-company-id": "company-a"
  }
});
describe("source transport boundary", () => {
  it("replaces incoming credentials with exact-audience service identity", async () => {
    let seen: RequestInit | undefined;
    const source = createSourceTransport(
      { origin: "https://source.example", audience: "source-aud" },
      {
        request,
        identity,
        headers: async () =>
          new Headers({
            authorization: "Bearer fresh",
            "x-portal-user-evidence": "signed",
            "x-portal-company-id": "company-a"
          }),
        fetch: async (_url, options) => {
          seen = options;
          return Response.json({ value: 1 });
        }
      }
    );
    expect(
      await source.post("/api/v1/knowledge/getItemIdentity", {
        itemId: "part-a"
      })
    ).toEqual({ value: 1 });
    expect(new Headers(seen?.headers).get("authorization")).toBe(
      "Bearer fresh"
    );
    expect(seen?.redirect).toBe("error");
  });
  it("rejects user-controlled origins and paths outside the source contract", async () => {
    const source = createSourceTransport(
      { origin: "https://source.example", audience: "source-aud" },
      {
        request,
        identity,
        headers: async () => new Headers(),
        fetch: async () => {
          throw Error("unexpected");
        }
      }
    );
    await expect(source.post("https://other.example", {})).rejects.toThrow(
      "source operation"
    );
    await expect(source.post("/api/v1/../../admin", {})).rejects.toThrow(
      "source operation"
    );
  });
  it("bounds source responses before JSON parsing", async () => {
    const source = createSourceTransport(
      { origin: "https://source.example", audience: "source-aud" },
      {
        request,
        identity,
        headers: async () => new Headers(),
        fetch: async () => new Response('"' + "x".repeat(262144) + '"')
      }
    );
    await expect(
      source.post("/api/v1/knowledge/getItemIdentity", {})
    ).rejects.toThrow("response limit");
  });
});
