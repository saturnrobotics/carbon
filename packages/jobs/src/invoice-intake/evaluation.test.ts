import { describe, expect, it } from "vitest";
import { invoiceExtractionEnvelopeSchema } from "./contracts";
import {
  assertInvoiceRepeatCheckpoint,
  evaluateInvoices,
  type InvoiceEvaluationSample,
  scoreInvoiceSample
} from "./evaluation";
import { syntheticInvoiceFixtures } from "./fixtures/synthetic";

const fixtures = syntheticInvoiceFixtures();
const samples = (): InvoiceEvaluationSample[] =>
  fixtures.map((fixture) => ({
    fixtureId: fixture.id,
    modelId: "synthetic-test-model",
    attemptId: `fixture-attempt-${fixture.id}`,
    result: structuredClone(fixture.labels),
    status: fixture.heldOutRepeat ? "Ready" : "NeedsReview",
    latencyMs: 250,
    actualCostUsd: 0.01,
    repeatSelection: fixture.heldOutRepeat
      ? {
          expected: { item: "fixture-item", unit: "EA", factor: 1 },
          actual: { item: "fixture-item", unit: "EA", factor: 1 }
        }
      : undefined
  }));
describe("invoice extraction release evaluation", () => {
  it("provides thirty schema-valid synthetic documents including duplicates and held-out repeats", () => {
    expect(fixtures).toHaveLength(30);
    fixtures.forEach((fixture) => {
      expect(
        invoiceExtractionEnvelopeSchema.safeParse(fixture.labels).success
      ).toBe(true);
    });
    expect(new Set(fixtures.map((f) => f.format)).size).toBe(3);
    expect(fixtures.some((f) => f.pages.length > 1)).toBe(true);
    expect(fixtures.filter((f) => f.heldOutRepeat)).toHaveLength(5);
    expect(fixtures[29]?.duplicateOf).toBe(fixtures[3]?.id);
  });
  it("scores exact numeric values instead of model confidence", () => {
    const sample = samples()[0]!;
    const result = invoiceExtractionEnvelopeSchema.parse(sample.result);
    result.header.total.value = `${result.header.total.value}00`;
    result.header.total.confidence = 0;
    expect(
      scoreInvoiceSample(fixtures[0]!, { ...sample, result }).errors
    ).toEqual([]);
    result.header.total.value = "99999";
    result.header.total.confidence = 1;
    expect(
      scoreInvoiceSample(fixtures[0]!, { ...sample, result, status: "Ready" })
        .wrongReady
    ).toBe(true);
  });
  it("fails incomplete, unmeasured or duplicated corpus runs", () => {
    expect(evaluateInvoices(fixtures, samples()).models[0]?.passed).toBe(true);
    expect(
      evaluateInvoices(fixtures, samples().slice(1)).models[0]?.passed
    ).toBe(false);
    const unmeasured = samples();
    unmeasured[0]!.actualCostUsd = null;
    expect(evaluateInvoices(fixtures, unmeasured).models[0]?.passed).toBe(
      false
    );
    expect(
      evaluateInvoices(fixtures, [...samples().slice(1), samples()[1]!])
        .models[0]?.passed
    ).toBe(false);
  });
  it("cannot reuse an earlier complete pass after that candidate fails on resume", () => {
    const observations = samples();
    const original = structuredClone(observations);
    expect(evaluateInvoices(fixtures, observations).models[0]?.passed).toBe(
      true
    );
    const report = evaluateInvoices(fixtures, observations, {
      failedModelIds: ["synthetic-test-model"]
    });
    expect(report.models[0]).toMatchObject({
      passed: false,
      corpusComplete: true,
      accuracy: 1,
      repeatCorrect: 5
    });
    expect(observations).toEqual(original);
    expect(
      evaluateInvoices(
        fixtures,
        [
          ...observations,
          ...observations.map((sample) => ({
            ...sample,
            modelId: "other-model"
          }))
        ],
        { failedModelIds: ["synthetic-test-model"] }
      ).models.map((model) => model.passed)
    ).toEqual([false, true]);
  });
  it("accepts only unchanged, still Ready held-out checkpoints without improving observations", () => {
    const checkpoint = samples()[20]!;
    const selection = {
      supplierId: "fixture-supplier",
      lines: [
        {
          itemId: "fixture-item",
          purchaseUnit: "PACK",
          stockUnit: "EA",
          conversionFactor: "100"
        }
      ]
    };
    checkpoint.repeatSelection = {
      expected: structuredClone(selection),
      actual: structuredClone(selection)
    };
    const original = structuredClone(checkpoint);
    const current = {
      status: "Ready",
      ready: true,
      attemptId: checkpoint.attemptId,
      expected: checkpoint.repeatSelection!.expected,
      actual: checkpoint.repeatSelection!.actual
    };
    expect(() =>
      assertInvoiceRepeatCheckpoint(checkpoint, current)
    ).not.toThrow();
    for (const changed of [
      { ...current, status: "NeedsReview" },
      { ...current, ready: false },
      { ...current, attemptId: "replacement-attempt" },
      { ...current, actual: { ...selection, supplierId: "another-supplier" } },
      ...[
        { itemId: "another-item" },
        { purchaseUnit: "EA" },
        { stockUnit: "PACK" },
        { conversionFactor: "1" }
      ].map((line) => ({
        ...current,
        actual: { ...selection, lines: [{ ...selection.lines[0], ...line }] }
      })),
      { ...current, expected: { ...selection, supplierId: "another-supplier" } }
    ])
      expect(() => assertInvoiceRepeatCheckpoint(checkpoint, changed)).toThrow(
        "invoice_evaluation_checkpoint_changed"
      );
    expect(() =>
      assertInvoiceRepeatCheckpoint(
        { ...checkpoint, status: "NeedsReview" },
        current
      )
    ).toThrow("invoice_evaluation_checkpoint_changed");
    expect(checkpoint).toEqual(original);
  });
  it("counts missing lines and rejects wrong-ready exception documents", () => {
    const sample = samples()[6]!,
      result = invoiceExtractionEnvelopeSchema.parse(sample.result);
    result.lines.pop();
    expect(
      scoreInvoiceSample(fixtures[6]!, { ...sample, result }).missingFlagged
    ).toBe(false);
    result.issues = ["Incomplete final row"];
    expect(
      scoreInvoiceSample(fixtures[6]!, { ...sample, result }).missingFlagged
    ).toBe(true);
    expect(
      scoreInvoiceSample(fixtures[26]!, { ...samples()[26]!, status: "Ready" })
        .wrongReady
    ).toBe(true);
  });
  it("requires observed preselection correctness on the held-out repeat set", () => {
    const selected = samples();
    delete selected[20]!.repeatSelection;
    const report = evaluateInvoices(fixtures, selected).models[0]!;
    expect(report.repeatCorrect).toBe(4);
    expect(report.passed).toBe(false);
    const notReady = samples();
    notReady[20]!.status = "NeedsReview";
    expect(evaluateInvoices(fixtures, notReady).models[0]!.passed).toBe(false);
  });
  it("rejects unexpected Ready identity and line-charge errors", () => {
    const fixture = fixtures[0]!,
      sample = samples()[0]!;
    const result = invoiceExtractionEnvelopeSchema.parse(sample.result);
    result.supplier.name.value = "Another Example Supplier";
    result.header.invoiceNumber.value = "WRONG-REFERENCE";
    result.lines[0]!.shipping.value = "1.00";
    const score = scoreInvoiceSample(fixture, {
      ...sample,
      result,
      status: "Ready"
    });
    expect(score.wrongReady).toBe(true);
    expect(score.identityErrors).toContain("supplier.name");
    expect(score.identityErrors).toContain("header.invoiceNumber");
    expect(score.errors).toContain("lines.0.shipping");
  });
  it("counts one shared paid attempt once for an exact duplicate source", () => {
    const selected = samples();
    selected[29]!.attemptId = selected[3]!.attemptId;
    expect(evaluateInvoices(fixtures, selected).models[0]!.costUsd).toBeCloseTo(
      0.29
    );
  });
});
