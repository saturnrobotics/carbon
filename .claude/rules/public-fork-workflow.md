---
description: Public fork integration and laptop deployment workflow
paths:
  - "**"
---

# Public fork workflow

- `saturn/main` is the integration and deployment branch. Create feature branches
  from it, merge completed and verified features back into it, then merge the
  latest `upstream/main` and verify affected behavior before deployment.
- Prefer merges for the shared integration branch; never force-push or reset away
  fork changes. Use `contrib/deploying/gcp-tailscale/fork.sh` for the workflow.
- `make deploy` runs from a clean committed `saturn/main` on the operator's laptop,
  checks upstream inclusion, publishes the exact source commit, and deploys it.
- Keep fork-specific instructions and deployment code under
  `contrib/deploying/gcp-tailscale/`. Avoid editing root-level files such as
  `README.md` or expanding the root Makefile, to limit upstream merge conflicts.
- Keep private company details and credentials out of every published artifact.
  Store deployment inputs only in ignored `.local/` configuration. Review source
  and commit history for privacy before invoking deployment, which publishes it.

See `contrib/deploying/gcp-tailscale/WORKFLOW.md` for the operator commands.
