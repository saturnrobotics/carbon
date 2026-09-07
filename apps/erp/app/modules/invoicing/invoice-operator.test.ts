import { emptyInvoiceExtraction } from "@carbon/jobs";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/modules/settings", () => ({ getCompanySettings: vi.fn() }));
vi.mock("@carbon/glossary", () => ({
  terms: {},
  getEntry: vi.fn(),
  lookupEntry: vi.fn(),
  hasEntry: vi.fn(),
  termSlug: vi.fn()
}));
const { invoiceOperatorConfigSchema, reusableInvoiceAttempt } = await import(
  "./invoice-operator.server"
);

describe("maintained invoice operator identity", () => {
  const identity = {
    modelId: "example-model",
    promptVersion: "example-prompt",
    schemaVersion: "invoice-intake.v1"
  };
  const attempt = {
    ...identity,
    operation: "extract",
    status: "completed",
    storagePath: "example/source.pdf",
    extractedData: emptyInvoiceExtraction()
  };
  it("requires the exact schema, prompt, model and registered source path", () => {
    expect(
      reusableInvoiceAttempt(attempt, identity, [attempt.storagePath])
    ).toBe(true);
    for (const key of [
      "modelId",
      "promptVersion",
      "schemaVersion",
      "storagePath",
      "status",
      "operation"
    ] as const)
      expect(
        reusableInvoiceAttempt({ ...attempt, [key]: "different" }, identity, [
          attempt.storagePath
        ]),
        key
      ).toBe(false);
    expect(
      reusableInvoiceAttempt({ ...attempt, extractedData: {} }, identity, [
        attempt.storagePath
      ])
    ).toBe(false);
  });
  it("defaults to no new extractions and rejects unbounded or non-review operations", () => {
    const config = {
      companyId: "example-company",
      userId: "example-user",
      requiredRevision: "a".repeat(40),
      identity,
      steps: [
        { action: "normalize", intakeId: "example-intake", expectedRevision: 0 }
      ]
    };
    expect(invoiceOperatorConfigSchema.parse(config).maxNewExtractions).toBe(0);
    expect(
      invoiceOperatorConfigSchema.safeParse({
        ...config,
        maxNewExtractions: 11
      }).success
    ).toBe(false);
    expect(
      invoiceOperatorConfigSchema.safeParse({
        ...config,
        steps: [{ action: "approve", intakeId: "example-intake" }]
      }).success
    ).toBe(false);
    expect(
      invoiceOperatorConfigSchema.safeParse({
        ...config,
        steps: [
          { action: "parse", intakeId: "example-intake", expectedRevision: 0 }
        ]
      }).success
    ).toBe(false);
  });
});
