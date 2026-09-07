# Mercury receipt intake corrections

Scope: Mercury payment evidence and directly attached receipts, plus explicit manual uploads. Gmail acquisition and matching are deferred; existing evidence must be retained without blocking this flow. No automatic financial approval, inventory receipt, posting, or settlement.

- [x] Preserve complete payment context and acquisition outcomes in review.
- [x] Retain Mercury attachment provenance and use consistent eligible sources through registration, extraction, preview, validation, and attachment copying.
- [x] Correct empty/unavailable previews, source selection, missing-document saves, and processing/readiness feedback.
- [x] Display extracted supplier facts and useful native supplier/item proposals; preserve confirmed recognition behavior.
- [x] Display payment/document reconciliation without inventing or overwriting source amounts.
- [x] Run red/green regressions, scoped types/lint, transactional approval tests, and browser checks against the actual Mercury-shaped flow.
- [x] Audit actual Mercury attachment coverage and real extraction facts privately; clearly separate source availability, parsing, readiness, and approval counts.
- [x] Review public diff, integrate upstream into the deployment branch, deploy from laptop, and verify deployed behavior.

Acceptance requires a visible verified receipt and identifiable payment; no model call without document bytes; deterministic handling of missing/unsupported/multiple files; explicit correction and approval using native typed masters; repeat ingestion/approval without duplicates; and no implied inventory or accounting posting.
