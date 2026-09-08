## Do not change shared disposable-database credentials to run a test

**Context:** Parallel agents used one explicitly disposable knowledge-schema database with a documented synthetic migrator login.

**Problem:** Changing the shared test role's password locally let one integration run proceed but interrupted another agent's migration run.

**Rule:** Use the documented shared-fixture credential exactly as provided. If it is missing or fails, ask the fixture owner or use a separately created disposable database; never alter a shared test role's password for convenience.

**Applies to:** Shared disposable PostgreSQL fixtures and parallel migration/integration test runs.
