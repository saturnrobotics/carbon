import { invoiceExtractionEnvelopeSchema } from "./contracts";
import type { InvoiceFixture } from "./fixtures/synthetic";
export type InvoiceEvaluationSample = {
  fixtureId: string;
  modelId: string;
  attemptId: string;
  result: unknown;
  status: string;
  latencyMs: number;
  actualCostUsd: number | null;
  correctedFields?: number;
  reviewedFields?: number;
  repeatSelection?: { expected: unknown; actual: unknown };
};
const decimalEqual = (a: string, b: string) => {
  const normalize = (value: string) => {
    const sign = value.startsWith("-") ? "-" : "";
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    const output = `${whole!.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
    return output === "0." ? "0" : sign + output;
  };
  return normalize(a) === normalize(b);
};
function exact(a: unknown, b: unknown, numeric = false) {
  return numeric && typeof a === "string" && typeof b === "string"
    ? decimalEqual(a, b)
    : a === b;
}
export function scoreInvoiceSample(
  fixture: InvoiceFixture,
  sample: InvoiceEvaluationSample
) {
  const parsed = invoiceExtractionEnvelopeSchema.safeParse(sample.result);
  let present = 0,
    correct = 0,
    types = 0,
    correctTypes = 0;
  const errors: string[] = [];
  const actual = parsed.success ? parsed.data : null;
  const check = (
    path: string,
    expected: string | null,
    received: string | null | undefined,
    numeric = false
  ) => {
    if (expected === null) return;
    present++;
    if (exact(expected, received, numeric)) correct++;
    else errors.push(path);
  };
  for (const key of [
    "issueDate",
    "dueDate",
    "currencyCode",
    "subtotal",
    "discount",
    "shipping",
    "tax",
    "total"
  ] as const)
    check(
      `header.${key}`,
      fixture.labels.header[key].value,
      actual?.header[key].value,
      !["issueDate", "dueDate", "currencyCode"].includes(key)
    );
  const identityErrors: string[] = [];
  const identity = (
    key: string,
    expected: string | null,
    observed: string | null | undefined
  ) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    if (normalize(expected) !== normalize(observed)) identityErrors.push(key);
  };
  identity(
    "supplier.name",
    fixture.labels.supplier.name.value,
    actual?.supplier.name.value
  );
  identity(
    "header.invoiceNumber",
    fixture.labels.header.invoiceNumber.value,
    actual?.header.invoiceNumber.value
  );
  fixture.labels.lines.forEach((line, index) => {
    const observed = actual?.lines[index];
    for (const key of [
      "quantity",
      "unitPrice",
      "lineTotal",
      "tax",
      "discount",
      "shipping"
    ] as const)
      check(
        `lines.${index}.${key}`,
        line[key].value,
        observed?.[key].value,
        true
      );
    for (const key of [
      "description",
      "supplierSku",
      "purchaseUnit",
      "packText"
    ] as const)
      identity(`lines.${index}.${key}`, line[key].value, observed?.[key].value);
    if (line.suggestedType.value) {
      types++;
      if (line.suggestedType.value === observed?.suggestedType.value)
        correctTypes++;
    }
  });
  const incompleteFlag =
    actual?.issues.some((issue) =>
      /incomplete|missing|unreadable|illegible|truncat|unparsed|cut off/i.test(
        issue
      )
    ) ?? false;
  const missingLines = Math.max(
    0,
    fixture.labels.lines.length - (actual?.lines.length ?? 0)
  );
  const extraLines = Math.max(
    0,
    (actual?.lines.length ?? 0) - fixture.labels.lines.length
  );
  const exception = [
    "credit",
    "statement",
    "paymentConfirmation",
    "multiple",
    "unknown"
  ].includes(fixture.labels.documentKind);
  const kindCorrect = actual?.documentKind === fixture.labels.documentKind;
  const wrongReady =
    sample.status === "Ready" &&
    (!parsed.success ||
      correct < present ||
      identityErrors.length > 0 ||
      missingLines > 0 ||
      extraLines > 0 ||
      exception ||
      !kindCorrect);
  const repeatCorrect = !fixture.heldOutRepeat
    ? null
    : sample.repeatSelection
      ? JSON.stringify(sample.repeatSelection.expected) ===
        JSON.stringify(sample.repeatSelection.actual)
      : false;
  return {
    fixtureId: fixture.id,
    schemaValid: parsed.success,
    present,
    correct,
    types,
    correctTypes,
    missingLines,
    extraLines,
    missingFlagged: missingLines === 0 || incompleteFlag,
    kindCorrect,
    wrongReady,
    repeatCorrect,
    errors,
    identityErrors,
    observedReady: sample.status === "Ready",
    latencyMs: sample.latencyMs,
    actualCostUsd: sample.actualCostUsd,
    correctedFields: sample.correctedFields ?? null,
    reviewedFields: sample.reviewedFields ?? null
  };
}
export function evaluateInvoices(
  fixtures: InvoiceFixture[],
  samples: InvoiceEvaluationSample[]
) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const models = [...new Set(samples.map((s) => s.modelId))];
  return {
    version: "invoice-evaluation.v1",
    models: models.map((modelId) => {
      const selected = samples.filter((s) => s.modelId === modelId);
      const scores = selected.map((sample) => {
        const fixture = byId.get(sample.fixtureId);
        if (!fixture) throw new Error("invoice_evaluation_fixture_unknown");
        return scoreInvoiceSample(fixture, sample);
      });
      const total = (
        key:
          | "present"
          | "correct"
          | "types"
          | "correctTypes"
          | "missingLines"
          | "extraLines"
      ) => scores.reduce((sum, row) => sum + row[key], 0);
      const unique =
        new Set(selected.map((s) => s.fixtureId)).size === fixtures.length &&
        selected.length === fixtures.length;
      const present = total("present"),
        accuracy = present ? total("correct") / present : 0;
      const repeat = scores.filter((s) => s.repeatCorrect !== null);
      const measured = selected.every(
        (s) =>
          s.attemptId.length > 0 &&
          s.actualCostUsd !== null &&
          Number.isFinite(s.latencyMs) &&
          s.latencyMs >= 0
      );
      const passed =
        unique &&
        measured &&
        accuracy >= 0.95 &&
        scores.every(
          (s) =>
            s.schemaValid && s.missingFlagged && !s.wrongReady && s.kindCorrect
        ) &&
        repeat.every((s) => s.repeatCorrect && s.observedReady);
      return {
        modelId,
        passed,
        corpusComplete: unique,
        measured,
        accuracy,
        typeAccuracy: total("types")
          ? total("correctTypes") / total("types")
          : null,
        unexpectedReady: scores.filter((s) => s.wrongReady).length,
        observedReady: scores.filter((s) => s.observedReady).length,
        missingLines: total("missingLines"),
        extraLines: total("extraLines"),
        repeatCorrect: repeat.filter((s) => s.repeatCorrect).length,
        repeatTotal: repeat.length,
        costUsd: [
          ...new Map(
            selected.map((sample) => [sample.attemptId, sample.actualCostUsd])
          ).values()
        ].reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
        unknownCost: scores.filter((s) => s.actualCostUsd === null).length,
        latencyMsMean: scores.length
          ? scores.reduce((sum, s) => sum + s.latencyMs, 0) / scores.length
          : null,
        correctionRate: scores.every(
          (s) => s.correctedFields !== null && s.reviewedFields !== null
        )
          ? scores.reduce((sum, s) => sum + (s.correctedFields ?? 0), 0) /
            Math.max(
              1,
              scores.reduce((sum, s) => sum + (s.reviewedFields ?? 0), 0)
            )
          : null,
        scores
      };
    })
  };
}
