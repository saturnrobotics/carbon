# Selective releases require complete inputs and executed failure paths

**Context:** A dependency-aware deployment planner still selected unrelated apps,
and its host rollout promised rollback after a failed health check.

**Problem:** Broad renderer hashes caused full maintenance; narrow Turbo task
inputs missed bundled source and script helpers; shell error propagation could
exit before rollback or count a failed startup as success.

**Rule:** Compare each service's complete effective build/runtime inputs against
its last successful receipt. Include bundled workspace source and transitive
generator helpers even when a task declares narrower inputs. Record immutable
image identity, preserve the old service source revision on reuse, and version
fingerprint semantics. Prove selection using real Git merges/deletions and Turbo
graphs. Execute host startup and health-failure paths with a synthetic Docker
boundary; assert rollback runs and the successful baseline does not advance.
Execute embedded remote Python scripts in fixtures instead of mocking only their
returned JSON. Publish successful receipts only after all required verification;
check downstream operators when moving from global tags to per-service image IDs.
Never rewrite a deployed baseline to force a no-op.

**Applies to:** Fork/upstream integration, Docker input selection, deployment
previews, host rollout scripts, and coding agents changing their verification.
