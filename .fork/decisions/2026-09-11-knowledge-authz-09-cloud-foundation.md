# Knowledge authorization Task 09: cloud identity foundation completion

Context: `.fork/plans/2026-09-11-knowledge-authorization.md` Task 09 (read from
its authoring commit `83f462029a` on `docs/knowledge-authorization-plan`, which
is `saturn/main` `7464d10347` plus that document only). Implemented against
`saturn/main` at `7464d10347`, offline, with no cloud apply. All identifiers in
tracked files are synthetic. This delivers configuration proof only; the
managed-cloud proof remains Task 11.

## Decisions

- **State**: `main.tf` declares a partial `backend "gcs" {}`; bucket and
  `prefix=knowledge/<environment>` come from `-backend-config` (README "State
  backend"). CI keeps `init -backend=false`.
- **IAP client**: none. IAP on Cloud Run admits in-organization Workspace users
  through the Google-managed OAuth client, and the provider marks
  `google_iap_client`/`google_iap_brand` deprecated because the IAP OAuth Admin
  API stopped functioning after July 2025 (`terraform validate` warned on the
  first draft that declared it). A resource that cannot apply is worse than an
  absent one, so the task's "`google_iap_client` plus brand" step is satisfied
  by documentation of the Google-managed path and a test that fails if either
  resource reappears.
- **Web entry**: `google_cloud_run_v2_service.web` is a Terraform-owned shell
  (`iap_enabled`, ingress, IAP service-agent invoker, Workspace-group binding)
  whose template is the probe image and is ignored on every later apply. The
  controller copies `run.googleapis.com/iap-enabled` and `ingress` from the
  observed service onto each v1 `replace` and refuses to promote `knowledge-web`
  when the shell is absent or IAP is off, so a release cannot switch IAP off.
- **Audiences**: outputs `service_audiences` (IAP audience
  `/projects/<number>/locations/<region>/services/knowledge-web`; deterministic
  `https://<service>-<number>.<region>.run.app` for query/ingest/actions) and
  `service_urls`. `release.py --foundation-outputs` fills the audience variables
  and refuses drift; `--override-audiences` is the explicit env-var override.
- **Invoker grants**: exactly the §1.4 table (web→query, web→actions,
  ingest→query) plus the two existing job triggers, each a `roles/run.invoker`
  member bound by an exact `resource.name` condition — the receivers are
  controller-created, so a service-level binding cannot exist at foundation
  time. No `allUsers`, no `allAuthenticatedUsers`, no unconditioned invoker.
- **Private source path**: mirrors Kanban — bidirectional VPC peering to
  `var.private_source_network`, an egress allow for TCP 5432 to
  `var.private_source_cidrs` for instances tagged
  `knowledge-source-database-client`, and an egress deny for everything else. No
  Cloud NAT. `release.py` stamps the tag only on units holding a database
  credential (query, ingest, schema, retention). A `knowledge-source-database-ca`
  secret container is granted to those four identities for
  `sslmode=verify-full`.
- **Tests**: `test_infrastructure.py` parses the HCL with a small block parser
  (no `python-hcl2` offline) and asserts over resources, arguments, outputs,
  locals and every-variable-referenced.

## Verification (2026-09-11, local)

```text
terraform -chdir=contrib/deploying/knowledge init -backend=false   exit 0
terraform -chdir=contrib/deploying/knowledge validate               Success, no warnings
terraform -chdir=contrib/deploying/knowledge fmt -check             exit 0
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_infrastructure.py'   18 tests OK
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_release.py'          15 tests OK
python3 -m unittest discover -s contrib/deploying/knowledge -p 'test_*.py'                45 tests OK
ruff check contrib/deploying                                        All checks passed
```

Mutation proof (scratch copies of the `.tf` files, tests re-run against each):
removing the web→actions edge, setting `iap_enabled = false` on
`knowledge-web`, and dropping the `var.private_source_cidrs` references were
each rejected by the intended test.

## Not done, and why

- No cloud apply and no `terraform plan` in CI: the plan needs project
  credentials (`data.google_project`), which CI does not hold; static checks
  stay as the gate.
- The CA file is not yet mounted into the database units by `release.py`; the
  database URL secrets are the only place `sslrootcert` is referenced. Wiring a
  secret-file mount is a runtime-contract change deferred to Task 05/11.
- `knowledge-actions` receives its §1.4 grant although it is not a manual-v1
  unit; the conditioned grant matches nothing until that service exists.
- The Task 09 checkbox lives in the plan on `docs/knowledge-authorization-plan`,
  not on `saturn/main`; tick it when that branch merges.
