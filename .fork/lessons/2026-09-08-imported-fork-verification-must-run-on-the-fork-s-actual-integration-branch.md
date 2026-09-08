## Fork verification must run on the fork's actual integration branch

**Context:** Relying on inherited CI and root workspace test commands after adding module tests.

**Problem:** CI targeted upstream's branch name and ERP lacked a test command, so successful manual checks were not a repeatable release gate.

**Rule:** Inspect the actual CI trigger and task graph. Run explicit pure and isolated-database suites on the integration branch; keep synthetic browser fixtures and generic operational tooling maintained. Fresh-checkout checks must build required workspace dist exports, invoke tracked CLI entry points rather than shell-installed binaries, and isolate test environment files from application dotenv overrides. Finish tracked release notes before deployment and keep post-deployment evidence private to avoid a notes-only rollout.

**Applies to:** Public forks, CI, deployment scripts, and release acceptance claims.
