# Saturn On-Premises Production

## Objective

Deploy `saturnrobotics/carbon:saturn/main` to the Saturn server rack through a
dedicated GitHub Actions runner inside the VPN, preserving production data and
applying migrations before application rollout.

## Repository work

- [x] Run CI for pull requests and pushes targeting `saturn/main`.
- [x] Prevent upstream Carbon deployment jobs from executing in the Saturn fork.
- [x] Add a serialized, environment-gated production workflow.
- [x] Stage immutable SHA-addressed release directories.
- [x] Require and verify an externally mounted backup destination.
- [x] Back up Postgres and object storage before upgrades.
- [x] Migrate an existing stack before rolling new application tasks.
- [x] Wait for ERP/MES container health and HTTP health endpoints.
- [x] Add a scheduled backup workflow with archive verification.
- [x] Add an isolated staging deployment with its own runner, stack, data,
      configuration, releases, images, secrets, URLs, and backups.
- [x] Gate production on successful staging and pass the exact staging SHA into
      the production deployment.
- [x] Factor staging and production through one reusable deployment workflow.
- [x] Add guarded Make targets for feature creation, production pull requests,
      upstream synchronization, protected merges, and deployed-commit tags.
- [x] Document branch protection, runner hardening, VPN policy, TLS, migrations,
      backups, recovery, and routine operations in `LOCAL_DEVELOPMENT.md`.

## Operator work before first deployment

- [ ] Set `saturn/main` as the fork's default branch.
- [ ] Create the protected `production` GitHub Environment.
- [ ] Apply the documented GitHub rulesets to `main` and `saturn/main`.
- [ ] Provision separate staging and production hosts/VMs inside the VPN.
- [ ] Install dedicated runners with the `saturn-staging` and
      `saturn-production` labels; never colocate the labels.
- [ ] Select and configure the private TLS model; install its CA on the runner.
- [ ] Mount separate external backup storage at `/mnt/carbon-staging-backups`
      and `/mnt/carbon-backups`.
- [ ] Create `/etc/carbon/staging.env` and `/etc/carbon/production.env` with mode
      `600` and distinct hosts, URLs, and integration credentials.
- [ ] Initialize independent Docker Swarms and Docker secrets.
- [ ] Run and verify the first staging → approval → production promotion.
- [ ] Restore a generated backup into an isolated environment and record the
      recovery result.

## Verification

See `.ai/runs/2026-07-16-saturn-production-validation.md`.
