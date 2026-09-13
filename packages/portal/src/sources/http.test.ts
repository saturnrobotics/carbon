import { describe, expect, it } from "vitest";
import { StepUpRequiredError } from "../step-up";
import { createSourceTransport } from "./http.server";

const identity = {
  principal: {
    kind: "human" as const,
    actorId: "alice",
    companyId: "company-a",
    callerId: "query",
    sourceIdentity: { issuer: "iap", subject: "a" },
    policyVersion: "1",
    capabilities: ["portal.read"]
  },
  companyGroupId: "g",
  allowedOperations: [],
  accessLevels: [],
  assurance: { mode: "carbon-mfa" as const }
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
      await source.post("/api/v1/portal/getItemIdentity", {
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
      source.post("/api/v1/portal/getItemIdentity", {})
    ).rejects.toThrow("response limit");
  });
  it("surfaces a step-up denial as its own error and keeps other denials opaque", async () => {
    const transport = (body: unknown, status: number) =>
      createSourceTransport(
        { origin: "https://source.example", audience: "source-aud" },
        {
          request,
          identity,
          headers: async () => new Headers(),
          fetch: async () => Response.json(body, { status })
        }
      );
    await expect(
      transport(
        {
          defined: false,
          code: "FORBIDDEN",
          status: 403,
          message:
            "This request requires a Carbon sign-in with two-factor authentication",
          data: { code: "step_up_required", method: "carbon-mfa" }
        },
        403
      ).post("/api/v1/portal/getItemIdentity", {})
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    // Any other 403 is a status-aware denial: nothing about the body reaches
    // the caller.
    await expect(
      transport(
        { code: "FORBIDDEN", status: 403, message: "not authorized" },
        403
      ).post("/api/v1/portal/getItemIdentity", {})
    ).rejects.toMatchObject({
      name: "SourceTransportError",
      reason: "denied",
      status: 403,
      message: "Source access denied"
    });
    await expect(
      transport({ data: { code: "step_up_required" } }, 200).post(
        "/api/v1/portal/getItemIdentity",
        {}
      )
    ).resolves.toEqual({ data: { code: "step_up_required" } });
  });
});
