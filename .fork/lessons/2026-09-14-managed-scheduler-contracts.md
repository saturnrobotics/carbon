# Verify managed identity and execution-log contracts

Context → An authenticated Scheduler release check failed after the runtime images were already deployed.

Problem → HTTP invocation grants used a resource attribute unsupported by Cloud Run, while a strict log timestamp ordering check hid the resulting denial. Pausing the Scheduler job also cleared attempt metadata that the controller expected to retain.

Rule → Validate IAM condition attributes for the exact data-plane permission, then prove the intended allow and denial paths on the provider. Use explicit dispatch identity for manual execution-log correlation; distributed timestamps are not a total order. Capture attempt metadata before state transitions, preserve denial and concurrency checks, and test actual provider response shapes. Keep scheduled cron time distinct from manual dispatch time.

Applies to → Cloud Run invocation grants, Cloud Scheduler readiness and quiescence, and deployment provider adapters.
