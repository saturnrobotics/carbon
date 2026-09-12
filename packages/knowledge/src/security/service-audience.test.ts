import { describe, expect, it } from "vitest";
import {
  verifyIapBrowserRequest,
  verifyWorkforceRequest
} from "../identity.server";
import {
  binding,
  configuration,
  now,
  otherIapAudience,
  portalIapAudience,
  verifier,
  workforceRequest
} from "./identity-fixture";

const identityStore = { resolveHuman: async () => binding };

describe("service-token audience confusion", () => {
  it("accepts the control pair minted for this receiver", async () => {
    const identity = await verifyWorkforceRequest({
      request: workforceRequest("service:query", "iap:portal:alex"),
      operation: "knowledge.query",
      configuration,
      tokenVerifier: verifier,
      identityStore,
      nowEpochSeconds: now
    });
    expect(identity.principal.actorId).toBe("usr_alex");
  });

  it("rejects a service token minted for the worker audience at the query receiver", async () => {
    await expect(
      verifyWorkforceRequest({
        request: workforceRequest("service:worker", "iap:portal:alex"),
        operation: "knowledge.query",
        configuration,
        tokenVerifier: verifier,
        identityStore,
        nowEpochSeconds: now
      })
    ).rejects.toThrow("unauthorized");
  });

  it("rejects user evidence minted for another caller's IAP audience", async () => {
    await expect(
      verifyWorkforceRequest({
        request: workforceRequest("service:query", "iap:other:alex"),
        operation: "knowledge.query",
        configuration,
        tokenVerifier: verifier,
        identityStore,
        nowEpochSeconds: now
      })
    ).rejects.toThrow("unauthorized");
  });

  it("rejects a browser assertion for a different backend audience", async () => {
    const request = new Request("https://portal.example.test/", {
      headers: { "x-goog-iap-jwt-assertion": "iap:other:alex" }
    });
    await expect(
      verifyIapBrowserRequest({
        request,
        sourceIapAudience: portalIapAudience,
        tokenVerifier: verifier,
        nowEpochSeconds: now
      })
    ).rejects.toThrow("unauthorized");
    await expect(
      verifyIapBrowserRequest({
        request,
        sourceIapAudience: otherIapAudience,
        tokenVerifier: verifier,
        nowEpochSeconds: now
      })
    ).resolves.toMatchObject({ sourceIapAudience: otherIapAudience });
  });
});
