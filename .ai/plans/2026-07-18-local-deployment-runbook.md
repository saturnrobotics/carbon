# Local staging and production runbook plan

- [x] Audit the existing local development, domain, deployment, backup, and
  GitHub workflow documentation.
- [x] Add one ordered, self-contained setup path to `LOCAL_DEVELOPMENT.md` for
  ARM64 laptop staging through rack production.
- [x] Check commands, paths, hostnames, runner labels, and configuration values
  against the repository implementation.
- [x] Run documentation/configuration validation and record the result.

Validation:

- `make test-domain-config` — passed.
- `bash -n` for deployment, backup, validator, and GCP stack test scripts —
  passed.
- Referenced local files existence check — passed.
- `git diff --check` — passed.
