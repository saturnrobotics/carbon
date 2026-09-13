/**
 * Deterministic confidence calibration for typed proposed fields.
 *
 * A parser's raw score is untrusted: it is clamped to [0, 1], discounted by how
 * much evidence backs it, and discounted by how reliable the way the document
 * was read is. The calibrated value is what the reviewer sees and what decides
 * whether a proposal may stand without explicit confirmation.
 *
 * Buckets (lower bound inclusive):
 *
 * | Range         | Bucket       | Meaning                                              |
 * | ------------- | ------------ | ---------------------------------------------------- |
 * | [0.00, 0.60)  | `unresolved` | reviewer must confirm or correct before publishing   |
 * | [0.60, 0.85)  | `review`     | shown with a caution; publishable as proposed        |
 * | [0.85, 1.00]  | `confident`  | shown as-is                                          |
 */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.6;
export const CONFIDENCE_CONFIDENT_THRESHOLD = 0.85;

export type ConfidenceBucket = "unresolved" | "review" | "confident";

export const extractionSourceKinds = ["text-layer", "ocr", "model"] as const;
export type ExtractionSourceKind = (typeof extractionSourceKinds)[number];

/**
 * Prior reliability of each way of reading a document. A PDF text layer is
 * verbatim; OCR mis-reads glyphs (0 vs O, 1 vs l) in exactly the part numbers
 * this exists to identify; a model can produce a plausible value with no
 * grounding at all, so it is trusted least.
 */
const SOURCE_PRIOR: Readonly<Record<ExtractionSourceKind, number>> = {
  "text-layer": 1,
  ocr: 0.9,
  model: 0.85
};

/** The prior applied when a parser does not say how it read the document. */
export const DEFAULT_EXTRACTION_SOURCE_KIND: ExtractionSourceKind = "model";

export function isExtractionSourceKind(
  value: unknown
): value is ExtractionSourceKind {
  return (
    typeof value === "string" &&
    (extractionSourceKinds as readonly string[]).includes(value)
  );
}

/**
 * One sighting is a single reading of the page; two corroborate; three or more
 * earn full weight. No evidence means the value cannot be checked at all, so
 * it is worth nothing regardless of the score the parser claimed.
 */
function evidenceFactor(evidenceCount: number): number {
  if (!Number.isInteger(evidenceCount) || evidenceCount <= 0) return 0;
  if (evidenceCount === 1) return 0.8;
  if (evidenceCount === 2) return 0.9;
  return 1;
}

export function calibrateConfidence(
  rawScore: number,
  evidenceCount: number,
  sourceKind: ExtractionSourceKind
): number {
  if (!Number.isFinite(rawScore)) return 0;
  const clamped = Math.min(1, Math.max(0, rawScore));
  return clamped * evidenceFactor(evidenceCount) * SOURCE_PRIOR[sourceKind];
}

export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (!(confidence >= CONFIDENCE_REVIEW_THRESHOLD)) return "unresolved";
  if (confidence < CONFIDENCE_CONFIDENT_THRESHOLD) return "review";
  return "confident";
}

/** True when a proposal must be confirmed or corrected by a reviewer. */
export function requiresReviewerConfirmation(confidence: number): boolean {
  return confidenceBucket(confidence) === "unresolved";
}
