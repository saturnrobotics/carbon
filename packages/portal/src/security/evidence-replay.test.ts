import { describe, expect, it } from "vitest";
import { verifyWorkforceRequest } from "../identity.server";
import {
  binding,
  configuration,
  now,
  verifier,
  workforceRequest
} from "./identity-fixture";

const identityStore = { resolveHuman: async () => binding };

describe("replayed user evidence", () => {
  it("is refused when a different registered caller presents it", async () => {
    // other-portal is enrolled, but its IAP audience is not the one the evidence carries.
    await expect(
      verifyWorkforceRequest({
        request: workforceRequest("service:other-portal", "iap:portal:alex"),
        operation: "portal.query",
        configuration,
        tokenVerifier: verifier,
        identityStore,
        nowEpochSeconds: now
      })
    ).rejects.toThrow("unauthorized");
  });

  it("is refused for a company the verified subject is not bound to", async () => {
    await expect(
      verifyWorkforceRequest({
        request: workforceRequest(
          "service:query",
          "iap:portal:alex",
          "cmp_beta"
        ),
        operation: "portal.query",
        configuration,
        tokenVerifier: verifier,
        identityStore,
        nowEpochSeconds: now
      })
    ).rejects.toThrow("unauthorized");
  });

  it("is refused after the assertion lifetime, even with a fresh service token", async () => {
    await expect(
      verifyWorkforceRequest({
        request: workforceRequest("service:query", "iap:portal:alex"),
        operation: "portal.query",
        configuration,
        tokenVerifier: {
          ...verifier,
          verifyServiceToken: async () => ({
            iss: "https://accounts.google.com",
            sub: "100000000000000000001",
            aud: configuration.receiver.audience,
            iat: now + 3_000,
            exp: now + 3_300
          })
        },
        identityStore,
        nowEpochSeconds: now + 3_030
      })
    ).rejects.toThrow("unauthorized");
  });

  it("is refused once the canonical binding is revoked", async () => {
    await expect(
      verifyWorkforceRequest({
        request: workforceRequest("service:query", "iap:portal:alex"),
        operation: "portal.query",
        configuration,
        tokenVerifier: verifier,
        identityStore: {
          resolveHuman: async () => ({ ...binding, bindingActive: false })
        },
        nowEpochSeconds: now
      })
    ).rejects.toThrow("unauthorized");
  });
});
