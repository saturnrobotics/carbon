import { describe, expect, it } from "vitest";
import { createExtraction, extractionFingerprint } from "./extraction.server";
import { captureIdentity } from "./intake.server";

describe("captureIdentity", () => {
  it("deduplicates the same immutable object for one source without crossing ACLs", () => {
    const input = {
      kind: "object" as const,
      objectKey: "intake/a.pdf",
      generation: "7",
      sha256: "a".repeat(64),
      mimeType: "application/pdf",
      bytes: 3
    };
    expect(
      captureIdentity({
        sourceId: "drive-a",
        ownerId: "u",
        acl: "engineering",
        input
      }).idempotencyKey
    ).toBe(
      captureIdentity({
        sourceId: "drive-a",
        ownerId: "u",
        acl: "engineering",
        input
      }).idempotencyKey
    );
    expect(
      captureIdentity({
        sourceId: "drive-b",
        ownerId: "u",
        acl: "private",
        input
      }).idempotencyKey
    ).not.toBe(
      captureIdentity({
        sourceId: "drive-a",
        ownerId: "u",
        acl: "engineering",
        input
      }).idempotencyKey
    );
  });
});

it("fingerprints persisted JSONB independently of object key order", () => {
  expect(
    extractionFingerprint({
      fields: { title: "Manual" },
      evidence: {},
      unresolved: [],
      warnings: []
    })
  ).toBe(
    extractionFingerprint({
      warnings: [],
      unresolved: [],
      evidence: {},
      fields: { title: "Manual" }
    })
  );
});

describe("createExtraction", () => {
  it("rejects parser output that cannot fit the immutable database envelope", () => {
    expect(() =>
      createExtraction({
        fields: { body: "x".repeat(70_000) },
        evidence: {},
        warnings: []
      })
    ).toThrow("byte limit");
  });
  it("keeps bounded page evidence for long manuals", () => {
    const extraction = createExtraction({
      fields: { title: "Synthetic long manual" },
      evidence: {
        body: Array.from({ length: 100 }, (_, index) => ({
          page: index + 1,
          text: `page ${index + 1} ${"x".repeat(1_000)}`
        }))
      },
      warnings: []
    });
    expect(extraction.evidence.body).toHaveLength(100);
  });
});
