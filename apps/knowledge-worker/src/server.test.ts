import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getManualUploadSource: vi.fn(),
  getWritableUploadSources: vi.fn(),
  persistCapturedIntake: vi.fn(),
  saveReviewDecisions: vi.fn(),
  captureImmutableUpload: vi.fn()
}));
vi.mock("@carbon/knowledge/intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@carbon/knowledge/intake")>()),
  getManualUploadSource: mocks.getManualUploadSource,
  getWritableUploadSources: mocks.getWritableUploadSources,
  persistCapturedIntake: mocks.persistCapturedIntake,
  saveReviewDecisions: mocks.saveReviewDecisions
}));
vi.mock("./gcs", () => ({
  captureImmutableUpload: mocks.captureImmutableUpload,
  readImmutableObject: vi.fn()
}));

import { createWorkerHandler, type WorkerDependencies } from "./server";

const pdf = Buffer.from("%PDF-1.4 synthetic", "ascii");

function verifiedIdentity(capabilities: string[]) {
  return {
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
      capabilities
    }
  };
}

function dependencies(
  overrides: Partial<WorkerDependencies> = {}
): WorkerDependencies {
  return {
    verifyHuman: vi
      .fn()
      .mockResolvedValue(
        verifiedIdentity([
          "knowledge.intake.capture",
          "knowledge.intake.review"
        ])
      ),
    manualSource: { sourceId: "source-manual", displayName: "Manuals" },
    bucket: "bucket",
    ...overrides
  } as unknown as WorkerDependencies;
}

function multipart(entries: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return new Request("https://worker.example.com/v1/intake", {
    method: "POST",
    body: form
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getManualUploadSource.mockResolvedValue({
    sourceId: "source-manual",
    classification: "internal"
  });
  mocks.getWritableUploadSources.mockResolvedValue([
    {
      sourceId: "source-manual",
      displayName: "Manuals",
      classification: "internal"
    }
  ]);
  mocks.captureImmutableUpload.mockImplementation(
    async (input: { objectKey: string; bytes: Buffer; mimeType: string }) => ({
      objectKey: input.objectKey,
      generation: "1",
      sha256: "a".repeat(64),
      mimeType: input.mimeType,
      bytes: input.bytes.length
    })
  );
  mocks.persistCapturedIntake.mockResolvedValue({
    id: "intake-1",
    generation: "1",
    state: "captured"
  });
  mocks.saveReviewDecisions.mockResolvedValue(undefined);
});

it("rejects a verified workforce identity without the route capability", async () => {
  const deps = dependencies({
    verifyHuman: vi.fn().mockResolvedValue(verifiedIdentity(["knowledge.read"]))
  });
  const response = await createWorkerHandler(deps)(
    new Request("https://worker.example.com/v1/intake/intake-1")
  );
  expect(response.status).toBe(401);
  expect(deps.verifyHuman).toHaveBeenCalledWith(
    expect.any(Request),
    "knowledge.intake.review"
  );
});

it("lists only the configured manual library the actor may capture into", async () => {
  const response = await createWorkerHandler(dependencies())(
    new Request("https://worker.example.com/v1/sources/writable")
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    actorId: "user",
    sources: [
      {
        sourceId: "source-manual",
        displayName: "Manuals",
        classification: "internal"
      }
    ]
  });
  expect(mocks.getWritableUploadSources).toHaveBeenCalledWith(
    undefined,
    { companyId: "company", actorId: "user", callerId: "portal" },
    { onlySourceId: "source-manual" }
  );
});

it("acquires an HTTPS URL through the fetch policy and records its provenance", async () => {
  const fetchUrl = vi.fn().mockResolvedValue({
    bytes: pdf,
    mimeType: "application/pdf",
    finalUrl: "https://manuals.example.com/pump.pdf"
  });
  const response = await createWorkerHandler(dependencies({ fetchUrl }))(
    multipart({ sourceUrl: "https://manuals.example.com/pump" })
  );
  expect(response.status).toBe(202);
  expect(fetchUrl).toHaveBeenCalledWith("https://manuals.example.com/pump");
  expect(mocks.captureImmutableUpload).toHaveBeenCalledWith(
    expect.objectContaining({ mimeType: "application/pdf", bytes: pdf }),
    undefined
  );
  expect(mocks.persistCapturedIntake).toHaveBeenCalledWith(
    undefined,
    { companyId: "company", actorId: "user", callerId: "portal" },
    expect.objectContaining({
      sourceId: "source-manual",
      ownerId: "user",
      acquiredFrom: "https://manuals.example.com/pump.pdf",
      input: expect.objectContaining({ kind: "object" })
    })
  );
});

it("reports a refused or failed acquisition as a distinct client error", async () => {
  const fetchUrl = vi
    .fn()
    .mockRejectedValue(new Error("private network intake URLs are forbidden"));
  const response = await createWorkerHandler(dependencies({ fetchUrl }))(
    multipart({ sourceUrl: "https://10.0.0.1/manual.pdf" })
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "acquisition_failed" });
  expect(mocks.captureImmutableUpload).not.toHaveBeenCalled();
});

it("refuses a library the actor cannot capture into", async () => {
  const response = await createWorkerHandler(dependencies())(
    multipart({
      sourceId: "source-other",
      document: new File([pdf], "pump.pdf", { type: "application/pdf" })
    })
  );
  expect(response.status).toBe(403);
  expect(mocks.captureImmutableUpload).not.toHaveBeenCalled();
});

it("accepts a camera photo as an image intake", async () => {
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
  const response = await createWorkerHandler(dependencies())(
    multipart({
      sourceId: "source-manual",
      document: new File([], "", { type: "application/octet-stream" }),
      photo: new File([jpeg], "nameplate.jpg", { type: "image/jpeg" })
    })
  );
  expect(response.status).toBe(202);
  expect(mocks.captureImmutableUpload).toHaveBeenCalledWith(
    expect.objectContaining({ mimeType: "image/jpeg" }),
    undefined
  );
});

it("keeps the reviewer's item association, or explicit none, with the review", async () => {
  const handler = createWorkerHandler(dependencies());
  const review = (item: unknown) =>
    handler(
      new Request("https://worker.example.com/v1/intake/intake-1/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedGeneration: "1",
          expectedVersion: "1",
          metadata: {
            title: "Pump manual",
            manufacturer: "Example",
            partNumber: "P-100",
            revision: "A",
            machine: "Cell"
          },
          item
        })
      })
    );
  expect(
    (
      await review({
        id: "item-1",
        readableId: "P-100",
        name: "Pump",
        revision: "A",
        mpn: null
      })
    ).status
  ).toBe(204);
  expect(mocks.saveReviewDecisions).toHaveBeenLastCalledWith(
    undefined,
    expect.anything(),
    expect.objectContaining({
      decisions: expect.objectContaining({
        item: expect.objectContaining({
          value: expect.objectContaining({ id: "item-1" })
        })
      })
    })
  );
  expect((await review(null)).status).toBe(204);
  expect(mocks.saveReviewDecisions).toHaveBeenLastCalledWith(
    undefined,
    expect.anything(),
    expect.objectContaining({
      decisions: expect.objectContaining({
        item: expect.objectContaining({ value: null })
      })
    })
  );
  expect((await review({ id: "item-1", extra: "rejected" })).status).toBe(422);
});
