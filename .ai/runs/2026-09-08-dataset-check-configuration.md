# Dataset-check configuration failure

- Root cause: the CLI constructed the shared pool before checking whether its required URL existed. Missing configuration raised an undefined/includes TypeError outside the existing connection-failure handler.
- Fix: validate the configured URL before pool construction and use the command's established explicit-skip policy for unavailable local development infrastructure. Invalid arguments and actual dataset/schema failures continue to return failure.
- Regression: command-level tests isolate dotenv and PostgreSQL boundaries, cover unset/empty/whitespace configuration, and prove configured dataset failures still block. Two original regressions failed before implementation; all five final cases pass.
- Added a dependency-free Node test command through the package's existing tsx dependency. No database reset, migration, or hook bypass performed.
- Verification: package test command passes five tests; scoped typecheck passes; Biome check with warnings treated as errors passes all three checked files; diff whitespace check passes.
- The real dataset-check command exits zero with an explicit missing-configuration skip. This is not evidence that datasets passed against a live schema; no local database is configured in this checkout.
