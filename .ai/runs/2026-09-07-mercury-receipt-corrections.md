# Mercury receipt correction run

- Mode: fully autonomous, authorized full implementation and established deployment workflow.
- Diagnosis: completed read-only audit; confirmed missing payment context, metadata-only preview selection, mixed deferred source eligibility, provenance overwrite, and missing-document save transition.
- Plan: `.ai/plans/2026-09-07-mercury-receipt-corrections.md`.
- Scope: Mercury attachments and explicit uploads; Gmail deferred. No real financial approvals.
- Verification: red/green targeted regressions, scoped package checks, isolated browser approval/idempotency, private real-source fact audit, deployment readiness and final source attribution.
- Red evidence: current save returns NeedsReview for missing document; payment context absent; preview regressions reproduced; mixed source/provenance worker regressions reproduced.
- State: implementation, verification, upstream integration, and deployment complete.

- Combined verification: ERP typecheck, jobs/database scoped typechecks, scoped formatting, translation completeness, and four dataset checks passed. ERP review integration 23 tests, review models 17 tests, and UI helpers 8 tests passed. Jobs intake/payment integration suites passed 169 tests.
- Isolated browser acceptance passed: verified source bytes, placeholder/missing/unsupported states, deferred-source exclusion, stale-primary recovery, multiple-file selection, native proposal prefills, and actual approval into one Draft. Approval/source replay created no duplicates; attachment copying retained only eligible evidence; inventory and financial ledgers remained unchanged.
- Integration/deployment: deployment from the laptop completed successfully; immutable ERP/MES/Ops image revisions agree, private application/database/event readiness passed, and unauthenticated application requests redirect to login. Deployment retained scheduled cold backups and created a recovery snapshot.

- Upstream integration: preserved invoice validation registration alongside the new API workflow dispatcher; retained the union of operation blocks and regenerated the ignored manifest/tracked digest. Merged ERP/MES/API typechecks, 84 scoped ERP/API tests, 6 auth cache tests, and manifest verification passed. No database migrations were introduced.
- A clean local restart of the merged release passed the browser smoke check without HTTP 500s or uncaught browser errors. Live authenticated browser approval was deliberately not exercised on real purchases; the isolated native Draft approval provides that evidence.
- The private revision-pinned repair completed the Mercury refresh and historical intake bridge, retained existing evidence, and processed missing supported evidence through the deployed worker. The operation restored background processing; service health was checked again afterward. Operational records, source documents, extraction facts, and company-specific counts remain private.
- Before/after full-row hashes matched for all monitored native master, invoice, inventory, and accounting tables. Existing payment approval fields and immutable extraction records were preserved. Newly extracted core facts were checked against the actual PDF; ambiguous descriptions and duplicate header/line charge treatment still require explicit human review.
