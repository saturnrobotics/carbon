import { describe, expect, it } from "vitest";
import {
  emptyInvoiceExtraction,
  invoiceDecimalSchema,
  invoiceExtractionEnvelopeSchema
} from "./contracts";

describe("invoice evidence contracts", () => {
  it("preserves absent and low-confidence evidence", () => {
    const evidence = emptyInvoiceExtraction();
    evidence.header.total = {
      value: "0.01234",
      confidence: 0.1,
      sourceText: "0.01234",
      page: 1
    };
    const parsed = invoiceExtractionEnvelopeSchema.parse(evidence);
    expect(parsed.header.total).toEqual(evidence.header.total);
    expect(parsed.header.issueDate.value).toBeNull();
  });
  it.each([
    "Infinity",
    "NaN",
    "1e100",
    "",
    "1,000.00",
    "9007199254740992"
  ])("refuses unsafe decimal %s", (value) => {
    expect(invoiceDecimalSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "0",
    "0.00123",
    "-23.12",
    "200"
  ])("preserves decimal %s", (value) => {
    expect(invoiceDecimalSchema.parse(value)).toBe(value);
  });
  it("does not accept unknown provider properties or pretend canonical IDs are evidence", () => {
    expect(
      invoiceExtractionEnvelopeSchema.safeParse({
        ...emptyInvoiceExtraction(),
        supplierId: "untrusted"
      }).success
    ).toBe(false);
  });
});
