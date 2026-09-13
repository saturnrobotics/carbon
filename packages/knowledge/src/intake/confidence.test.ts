import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_CONFIDENT_THRESHOLD,
  CONFIDENCE_REVIEW_THRESHOLD,
  calibrateConfidence,
  confidenceBucket,
  isExtractionSourceKind,
  requiresReviewerConfirmation
} from "./confidence";

describe("calibrateConfidence", () => {
  it("is deterministic and bounded to [0, 1]", () => {
    expect(calibrateConfidence(0.9, 3, "text-layer")).toBe(
      calibrateConfidence(0.9, 3, "text-layer")
    );
    expect(calibrateConfidence(7, 3, "text-layer")).toBe(1);
    expect(calibrateConfidence(-3, 3, "text-layer")).toBe(0);
    expect(calibrateConfidence(Number.NaN, 3, "text-layer")).toBe(0);
    expect(calibrateConfidence(Number.POSITIVE_INFINITY, 3, "text-layer")).toBe(
      0
    );
  });

  it("is worthless without evidence regardless of the claimed score", () => {
    expect(calibrateConfidence(1, 0, "text-layer")).toBe(0);
    expect(calibrateConfidence(1, -1, "text-layer")).toBe(0);
    expect(calibrateConfidence(1, 1.5, "text-layer")).toBe(0);
  });

  it("discounts a single sighting and rewards corroboration", () => {
    expect(calibrateConfidence(1, 1, "text-layer")).toBeCloseTo(0.8);
    expect(calibrateConfidence(1, 2, "text-layer")).toBeCloseTo(0.9);
    expect(calibrateConfidence(1, 3, "text-layer")).toBe(1);
    expect(calibrateConfidence(1, 40, "text-layer")).toBe(1);
  });

  it("trusts a text layer over OCR and OCR over a model", () => {
    const text = calibrateConfidence(0.9, 3, "text-layer");
    const ocr = calibrateConfidence(0.9, 3, "ocr");
    const model = calibrateConfidence(0.9, 3, "model");
    expect(text).toBeGreaterThan(ocr);
    expect(ocr).toBeGreaterThan(model);
    expect(text).toBeCloseTo(0.9);
    expect(ocr).toBeCloseTo(0.81);
    expect(model).toBeCloseTo(0.765);
  });

  it("is monotonic in the raw score", () => {
    const scores = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const calibrated = scores.map((score) =>
      calibrateConfidence(score, 2, "ocr")
    );
    for (let index = 1; index < calibrated.length; index += 1)
      expect(calibrated[index]).toBeGreaterThanOrEqual(
        calibrated[index - 1] as number
      );
  });
});

describe("confidenceBucket", () => {
  it("places the documented boundaries", () => {
    expect(confidenceBucket(0)).toBe("unresolved");
    expect(confidenceBucket(CONFIDENCE_REVIEW_THRESHOLD - 0.001)).toBe(
      "unresolved"
    );
    expect(confidenceBucket(CONFIDENCE_REVIEW_THRESHOLD)).toBe("review");
    expect(confidenceBucket(CONFIDENCE_CONFIDENT_THRESHOLD - 0.001)).toBe(
      "review"
    );
    expect(confidenceBucket(CONFIDENCE_CONFIDENT_THRESHOLD)).toBe("confident");
    expect(confidenceBucket(1)).toBe("confident");
    expect(confidenceBucket(Number.NaN)).toBe("unresolved");
  });

  it("requires reviewer confirmation only below the review threshold", () => {
    expect(requiresReviewerConfirmation(0.59)).toBe(true);
    expect(requiresReviewerConfirmation(0.6)).toBe(false);
    expect(
      requiresReviewerConfirmation(calibrateConfidence(0.95, 1, "ocr"))
    ).toBe(false);
    expect(
      requiresReviewerConfirmation(calibrateConfidence(0.7, 1, "model"))
    ).toBe(true);
  });
});

it("recognizes only the declared source kinds", () => {
  expect(isExtractionSourceKind("text-layer")).toBe(true);
  expect(isExtractionSourceKind("ocr")).toBe(true);
  expect(isExtractionSourceKind("model")).toBe(true);
  expect(isExtractionSourceKind("llm")).toBe(false);
  expect(isExtractionSourceKind(undefined)).toBe(false);
});
