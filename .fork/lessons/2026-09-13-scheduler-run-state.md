# Match Scheduler job states in provider tests

**Context:** Deployment checked a paused no-work Scheduler job before enabling ingestion.

**Problem:** The test adapter allowed RunJob while paused; the live provider requires ENABLED.

**Rule:** Enforce provider state preconditions in tests. Temporarily enable only the
no-work check, require fresh completed authenticated evidence, and restore its
paused state in finally before enabling ingestion. Cover lost responses, polling
errors, failed cleanup and concurrent attempts. Local regression tests do not
replace a focused managed-platform check before a full release retry.

**Applies to:** Portal Scheduler readiness and stateful cloud deployment adapters.
