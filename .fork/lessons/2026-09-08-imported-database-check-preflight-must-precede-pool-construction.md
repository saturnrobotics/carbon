## Database-check preflight must precede pool construction

**Context:** Running a database-dependent commit check in a checkout without local database configuration.

**Problem:** The check handled failed connections but constructed a pool first; its required URL was undefined, so initialization threw an opaque TypeError before the environment policy could run.

**Rule:** Check required configuration before constructing database clients. Preserve the command's existing distinction between unavailable development infrastructure and actual validation failure. Report skipped checks explicitly; never report them as passing validation. Cover both missing configuration and configured validation failures in CLI regressions.

**Applies to:** Dataset checks, backup checks, and other database-dependent developer commands.
