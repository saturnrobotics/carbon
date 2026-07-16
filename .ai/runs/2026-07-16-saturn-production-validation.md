# Saturn Production Validation — 2026-07-16

- `bash -n contrib/deploying/simple-docker-caddy/deploy.sh contrib/deploying/simple-docker-caddy/scripts/backup.sh` — passed.
- Ruby YAML parse of all changed workflow files — passed.
- `git diff --check` — passed.
- `make help` and dry runs of every branch/PR/tag target — passed with GNU Make
  3.81; no Git or GitHub mutation was executed.
- Ruby YAML parsing passed for the reusable deploy, staging caller, production
  promotion, and staging/production backup matrix workflows.
- Confirmed staging deploys `github.sha` from `saturn/main` and production takes
  `github.event.workflow_run.head_sha` only after that staging run succeeds.
- Confirmed staging and production use distinct runner labels, release roots,
  configuration files, stack names, image namespaces, and backup mounts.
- Confirmed `check.yml` and `pr-complexity.yml` target `saturn/main`.
- Confirmed the Saturn production and backup jobs require
  `saturnrobotics/carbon` plus the dedicated `saturn-production` runner label.
- No deployment, migration, database reset, secret creation, GitHub setting
  change, or production-host mutation was performed from this checkout.
