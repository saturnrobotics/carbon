# Portal Scheduler readiness repair

HTTP invocation grants now restrict the same caller/receiver edges using exact foundation-derived request hosts, an attribute supported by Cloud Run. Manual Scheduler log correlation uses the scheduled dispatch identity rather than imposing a total order on distributed Started/Finished timestamps. Pausing a job can clear attempt metadata, so the controller captures it first and retains observable concurrency checks. Cron settlement permits bounded scheduled-time versus dispatch-time differences.

Verification: failing-then-passing regressions, 198 Portal Python tests, scoped Ruff, Terraform validation, and a reviewed plan limited to the five HTTP invocation conditions. A focused provider check against an existing deployed runtime returned HTTP 200 through Scheduler and passed revision checks before and after; unauthenticated readiness access returned HTTP 403. Both jobs were left paused. No runtime images changed or full release ran for this proof.

Limits: wrong-receiver denial was not exercised because the operator could not impersonate the Scheduler identity. This proof does not cover parser/retention job execution permissions. Reading and pausing a job are separate API operations; a dispatch in that interval can still be hidden when pause clears metadata. Full release and real user workflow verification remain separate gates.
