# Bugfix run: Mercury receipt review presentation

- Date: 2026-09-07
- Mode: fully autonomous, within the parent task's approved scope.
- Request: Correct the Mercury-only invoice review flow, preserve bank evidence, and verify the normal review and proposal experience.
- Phases: root cause completed; runtime instrumentation skipped because source-selection and projection omissions were established from code; fix and regression tests completed; browser verification owned by the release reviewer; commit/deployment owned by the parent task.

## Decisions and evidence

- Keep payment details separate from extracted invoice facts; show each payment's amount, currency, status, payee, reference, memo, and receipt acquisition outcomes.
- Use server-provided eligible source IDs for signing and review. Exclude metadata placeholders from preview choices and retain deferred Gmail provenance without using it for approval.
- Preserve unavailable attached-file identity and offer refresh instead of claiming the file is absent.
- Preserve supplier corrections. Prefill native proposals from document evidence and exact configured unit/country matches; do not guess pack conversions or unknown country codes.
- Retain fast polling while canonical validation is pending. Existing production records showed matching raw/persisted fields; the intermediate polling issue is a guarded latent case, not an attributed production hydration failure.
- Red regression run: 5 of 7 assertions failed on previous placeholder/default behavior. Green run: 7 passed after the helpers and real callers were updated.
- Country normalization red run: 1 of 8 assertions failed. Green run: 8 passed with name/code normalization and preserved unknown text.
- Scoped Biome checks passed. Initial ERP typecheck identified one partial test-cast error and a concurrent server status union; test contract corrected and server owner notified. Final ERP typecheck is coordinated by the parent.
- Translation: all active new messages filled in 12 non-source locales. Deterministic merge reported zero remaining/mismatched entries; `linguito check` passed. Catalog cleanup leaves ERP catalogs only. Glossary scan has existing failures and reviewed grammar/domain-sense false positives; no glossary edits or unrelated terminology rewrites were made.

## Outcome

UI implementation and unit tests ready for the parent release gate. Synthetic browser verification and final combined checks are owned by the parent/release reviewer. No production intake was approved or mutated by this work.
