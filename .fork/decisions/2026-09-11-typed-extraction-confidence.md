# Typed intake proposals with calibrated confidence

Context: knowledge intake stored parser output as an untyped `fields` record with
no confidence, no units, and no explicit manufacturer/MPN/revision proposal
(company knowledge platform plan, Task 13 step 3).

Decision:

- Extraction contract version 2 adds `proposed` (`packages/knowledge/src/intake/contracts.ts`):
  `title`, `manufacturer`, `mpn`, `revision`, `documentType` as
  `{ value, confidence, evidence: [{ page, region? }] }`, plus `measurements`
  whose entries carry a typed `unit` enum. Identity fields reject a unit.
  Version-1 rows still parse through `parseStoredExtraction`, which defaults
  `contractVersion: 1` and `proposed: {}`. The untyped `fields` record is kept.
- `calibrateConfidence(rawScore, evidenceCount, sourceKind)`
  (`intake/confidence.ts`) is deterministic: clamp, evidence factor
  (0 / 0.8 / 0.9 / 1 for 0 / 1 / 2 / 3+ references), source prior
  (text-layer 1, OCR 0.9, model 0.85; unknown kinds use the model prior).
  Buckets: below 0.6 unresolved, 0.6 to 0.85 review, 0.85 and above confident.
  `createExtraction` adds an unresolved entry for every proposal below 0.6, the
  same way it does for a field with no evidence. Malformed or unknown proposals
  are dropped with a warning rather than failing intake.
- `reconcileExtraction` keeps the parser's proposals immutable, carries the
  reviewer's value in `fields`, and marks a field unresolved only when the new
  generation proposes a disagreeing value. A field the parser no longer emits is
  not new evidence, so an earlier correction carries over silently. Review
  decision names map to proposal names (`partNumber` to `mpn`).
- The review page seeds inputs from the typed proposal, shows bucket, percent
  and page references, and lists document type and measurements separately.
  Unresolved names are aliased so one acknowledgement covers `partNumber` and
  `mpn`.

Not done: `reconcileExtraction` still has no production call site because the
worker never re-extracts an intake that has reached review; wiring belongs to
the reparse path when it exists. Parser output is unchanged; no current parser
emits `proposed`.
