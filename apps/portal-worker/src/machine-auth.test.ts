import { describe, expect, it } from "vitest";
import { verifyMachineRequest } from "./machine-auth";

const configuration = {
  audience: "https://worker.example.com",
  callers: [
    {
      subject: "service@example.iam.gserviceaccount.com",
      callerId: "drive-sync",
      companyIds: ["company"],
      sourceIds: ["source"],
      capabilities: ["source.changes.read" as const]
    }
  ]
};

describe("verifyMachineRequest", () => {
  it("accepts only an enrolled service account scoped to the requested company and source", async () => {
    const request = new Request(
      "https://worker.example.com/v1/sources/drive/sync",
      {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "x-portal-company-id": "company"
        }
      }
    );
    const principal = await verifyMachineRequest({
      request,
      sourceId: "source",
      capability: "source.changes.read",
      configuration,
      tokenVerifier: {
        verifyServiceToken: async () => ({
          iss: "https://accounts.google.com",
          sub: "service@example.iam.gserviceaccount.com",
          aud: configuration.audience,
          iat: 100,
          exp: 200
        })
      },
      nowEpochSeconds: 150
    });
    expect(principal).toMatchObject({
      kind: "machine",
      callerId: "drive-sync",
      companyId: "company",
      sourceIds: ["source"]
    });
  });

  it("rejects forwarded employee evidence on machine ingress", async () => {
    const request = new Request(
      "https://worker.example.com/v1/sources/drive/sync",
      {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "x-portal-company-id": "company",
          "x-portal-user-evidence": "iap"
        }
      }
    );
    await expect(
      verifyMachineRequest({
        request,
        sourceId: "source",
        capability: "source.changes.read",
        configuration,
        tokenVerifier: { verifyServiceToken: async () => ({}) }
      })
    ).rejects.toThrow("unauthorized machine request");
  });
});
