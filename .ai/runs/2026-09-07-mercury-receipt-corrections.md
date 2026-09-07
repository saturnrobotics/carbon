# Mercury receipt correction run

- Mode: fully autonomous, authorized full implementation and established deployment workflow.
- Diagnosis: completed read-only audit; confirmed missing payment context, metadata-only preview selection, mixed deferred source eligibility, provenance overwrite, and missing-document save transition.
- Plan: `.ai/plans/2026-09-07-mercury-receipt-corrections.md`.
- Scope: Mercury attachments and explicit uploads; Gmail deferred. No real financial approvals.
- Verification: red/green targeted regressions, scoped package checks, isolated browser approval/idempotency, private real-source fact audit, deployment readiness and final source attribution.
- Red evidence: current save returns NeedsReview for missing document; payment context absent; preview regressions reproduced; mixed source/provenance worker regressions reproduced.
- State: implementation and verification in progress.

- Combined verification: ERP typecheck, jobs/database scoped typechecks, scoped formatting, translation completeness, and four dataset checks passed. ERP review integration 23 tests, review models 17 tests, and UI helpers 8 tests passed. Jobs intake/payment integration suites passed 169 tests.
- Isolated browser acceptance passed: verified source bytes, placeholder/missing/unsupported states, deferred-source exclusion, stale-primary recovery, multiple-file selection, native proposal prefills, and actual approval into one Draft. Approval/source replay created no duplicates; attachment copying retained only eligible evidence; inventory and financial ledgers remained unchanged.
- Integration/deployment: pending.
