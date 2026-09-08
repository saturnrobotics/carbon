import { expect, it, vi } from "vitest";
import { createWorkerHandler, type WorkerDependencies } from "./server";

it("rejects a verified workforce identity without the route capability", async () => {
  const dependencies = {
    verifyHuman: vi.fn().mockResolvedValue({
      principal: {
        kind: "human",
        actorId: "user",
        companyId: "company",
        callerId: "portal",
        sourceIdentity: {
          issuer: "https://identity.example.com",
          subject: "subject"
        },
        policyVersion: "policy-1",
        capabilities: ["knowledge.read"]
      }
    })
  } as unknown as WorkerDependencies;
  const response = await createWorkerHandler(dependencies)(
    new Request("https://worker.example.com/v1/intake/intake-1")
  );
  expect(response.status).toBe(401);
  expect(dependencies.verifyHuman).toHaveBeenCalledWith(
    expect.any(Request),
    "knowledge.intake.review"
  );
});
