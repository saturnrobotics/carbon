# Portal nomenclature — coordinated implementation

The user approved renaming the entire company knowledge platform to Portal,
including internal identifiers, cloud names and deployment tooling. Base:
`fe62a8a46d2b90fa76b5f173dbe8adb05d742704`; branch `refactor/portal-naming`.

## Progress
- [x] Rename active packages, applications, ERP module/API contracts and configuration.
- [x] Preserve immutable SQL history; add data-preserving forward catalog migrations and backup mappings.
- [x] Rename Terraform, service identities, images, secrets, CI and Make entry points; reject stale configuration.
- [x] Regenerate lockfile links, database types, API metadata and Portal locale catalogs from authored inputs.
- [x] Verify fresh installation and legacy database upgrade, authorization tests, scoped builds/typechecks, Python infrastructure gates and browser workflow.
- [x] Review remaining legacy references and public/private boundary; prepare a focused PR.

## Task 1: Rename the active application surface

Files: move `apps/knowledge{,-query,-worker,-actions}` to corresponding `apps/portal*`;
`packages/knowledge` to `packages/portal`; `apps/erp/app/modules/knowledge` to
`apps/erp/app/modules/portal`. Update actual importers, routes, permissions,
capabilities, protocol/cache namespaces, workspace names and locale paths.
Use `PORTAL_ORIGIN` for former `KNOWLEDGE_PORTAL_ORIGIN` and
`PORTAL_LOCAL_WEB_PORT` for former `KNOWLEDGE_LOCAL_PORTAL_PORT`.
Preserve the unrelated ERP customer portal, acknowledge identifiers, and the
upstream in-app agent documentation knowledge base.
Verify with scoped package unit tests and `pnpm exec turbo run typecheck
--filter=@carbon/portal --filter=portal --filter=portal-query --filter=portal-worker
--filter=portal-actions --filter=erp`; all selected tasks must pass.

## Task 2: Preserve database upgrade integrity

Keep every existing Carbon and platform SQL migration's bytes and basename.
Create the Carbon forward migration with `pnpm db:migrate:new portal-naming`.
Rename the three public platform tables/functions, record backup table mappings,
and use a temporary resolver bridge while historical private migrations replay.
Add a final private migration to rename schemas, roles, policies, functions,
capability data and the migration ledger, preserving ACLs and data. Remove the
temporary bridge at completion. Adapt `packages/portal/src/migrations.server.ts`
and bootstrap fixtures for both fresh and legacy ledgers. Regenerate database
types only from an owned migration-built disposable database, never existing dev
or production state. Verification must prove checksum continuity, retained rows,
allowed/denied authorization, fresh replay and idempotent reentry.

## Task 3: Rename infrastructure and its checks

Move `contrib/deploying/knowledge` to `contrib/deploying/portal`, the GCP receiver
helper to `portal_receiver.py`, and the knowledge workflow to `portal-check.yml`.
Rename Make commands, Terraform addresses and resource names, env/secrets, images,
roles and test fixtures. Update the ledger observer and reject old configuration
keys. Add a naming regression guard with explicit historical/bridge exceptions.
Run `python3 -m unittest discover -s contrib/deploying/portal -p 'test_*.py'`,
scoped GCP deployment tests, Ruff, Terraform validation and Make dry runs; all pass.
Do not overwrite ignored deployment inputs or apply a destructive Terraform plan.
Existing cloud resource names require an explicit migration assessment, not a
blind state move.

## Task 4: Regenerate and verify the integrated rename

Run the pinned pnpm lockfile-only update and frozen install; dependency versions
must not change. Run database generators, `pnpm generate:mcp`, and scoped Lingui
extraction/compilation. Run Portal unit/integration/browser tests in isolated
fixtures and review remaining legacy tokens. Existing historical SQL, checksum
bridge code and unrelated generic knowledge prose are intentional exceptions.
Record verification evidence and any live-cloud prerequisite privately; no real
project IDs, domains, credentials, documents or operator logs enter tracked files.
