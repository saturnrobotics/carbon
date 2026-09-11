# Public fork conventions

- Keep fork-specific instructions and deployment code under
  `contrib/deploying/gcp-tailscale/`. Avoid editing root-level files such as
  `README.md` or expanding the root Makefile, to limit upstream merge conflicts.
- Keep private company details and credentials out of every published artifact.
  Store deployment inputs only in ignored `.local/` configuration. Review source
  and commit history for privacy before invoking deployment, which publishes it.
