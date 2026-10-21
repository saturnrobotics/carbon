# What this fork changes relative to upstream

Inventory of the fork's diff against `crbnos/carbon`, taken from
`git diff upstream/main...HEAD` **after** the legacy sync tooling was removed
(fork commit `5c11eb4c4e` vs upstream `6e519ed298`, 2026-09-11): 721 files,
112,861 insertions, 5,646 deletions; 565 fork-added files, 153 shared files
modified, 3 upstream files deleted. Refresh the numbers with
`bash scripts/fork/drift.sh`; refresh this inventory when a sync PR adds or
removes a shared-file modification.

Legend for §(b): **upstream** = generic, should be contributed with
`scripts/fork/upstream-pr.sh`; **extension point** = should be reshaped so the
fork-owned code plugs into a hook instead of editing the file; **inherent** =
must stay a fork edit. The inventory counts above describe the dated snapshot;
subsequent ownership changes are recorded below.

On 2026-09-24, container customization moved to root `Dockerfile.saturn`.
Root `Dockerfile` was restored byte-for-byte from upstream
`5ba005208b53584224d846ef8544225fe3781191` and stays upstream-owned. GCP app/ops,
Swarm, and AWS build recipes explicitly select the fork file. See
[the transition instructions](CONVENTIONS.md#container-build-ownership) for draft
PR #77.

On 2026-10-18, sign-in through an HQ identity provider (GoTrue's Keycloak
provider) was added. Its behavior is fork-owned (`packages/auth/src/saturn/`,
`contrib/deploying/gcp-tailscale/hq_sign_in.py`). It adds hooks to shared files
already listed under **Login / public pages** and **Environment schema** (the
`hq` provider), one new shared-file line (the `./saturn/hq-sign-in` export in
`packages/auth/package.json`), and one message to the ERP and MES locale
catalogs.

On 2026-10-19, Carbon's side of HQ's central authz service (HQ plan 0006B) was
added, off until the operator enables it: fork migration
`20261018214537_saturn-authz-projection` (schema `carbon_private`, role
`carbon_authz_applier`, guard triggers on `userPermission`, `employeeType` and
`employeeTypePermission`), the ERP module `apps/erp/app/modules/saturn/`, the
Inngest job `packages/jobs/src/saturn-authz/` and the token hook's `authz_api`
claim. Shared files gain one-line hooks: the five permission routes under
`apps/erp/app/routes/x+/users+/`, the API gate in `routes/api+/v1+/lib/base.server.ts`
(both under **Auth / session**) and the function list in
`packages/jobs/src/inngest/index.ts` (**Inngest / event dispatch hooks**), plus
three ERP catalog messages.

On 2026-10-19, Carbon's read contract for HQ's feed canvas (HQ plan 0012 Step 5)
was added as fork migration `20261019070224_saturn-hq-feeds` and its regression
test `packages/database/supabase/tests/saturn-hq-feeds.test.sql`. It only acts
where HQ's roles and `authz` functions exist: money-free column grants and
FOR SELECT policies for HQ's `hq_api` on six tables, EXECUTE on the three RLS
helpers Carbon's own SELECT policies call, and USAGE on `public` for `hq_owner`.
It touches no shared upstream file.

On 2026-10-19, fork migration `20261020030112_saturn-hq-feeds-usage` completed
that contract with USAGE on `public` for `hq_api`, under the same guard. The first
migration relied on PUBLIC's USAGE, which a database can lack (only named roles
such as `anon`, `authenticated`, `service_role` and `postgres` then hold it), and
there every HQ feed read failed with "permission denied for schema public". USAGE
only lets `hq_api` name objects in `public`: it still reads only the 21 money-free
columns through the row policies. It can also call the functions in `public` that
grant EXECUTE to PUBLIC (35 on a fresh stack, 3 of them SECURITY DEFINER), the
same surface `anon` has through the API; `hq_api` sends no JWT claims. The
regression test now revokes PUBLIC's USAGE on `public` inside its transaction and
shows reads failing without the grant and filtered by policy with it. It touches
no shared upstream file.

On 2026-10-20, fork migration `20261020154924_saturn-authz-identities` added
`carbon_private.authz_identities()`, the reader HQ's authz service uses for
GoTrue's `google` and `keycloak` identities (user id, provider and `provider_id`
only), with EXECUTE for HQ's `authz_owner` alone, under a guard like the feed
contract's. GoTrue's `auth.identities` has row level security on and no policy, so
the column grant HQ used before read zero rows. Its regression test is
`packages/database/supabase/tests/saturn-authz-identities.test.sql`; the #84 test
now counts the reader. It touches no shared upstream file.

On 2026-10-20, the flows that create or end membership were made safe for the
permission lock (HQ plan 0006B B7). While `carbon_private.authz_projection.enabled`
is true they write membership only and report that permissions are managed in
HQ; while it is off they behave as upstream. Fork migration
`20261020190000_saturn-authz-membership-only` adds
`carbon_private.authz_ensure_system_employee_type`, which creates a company's
Admin or Console Operator employee type with no template permissions (EXECUTE:
`postgres` only), because `employee."employeeTypeId"` is NOT NULL. The behaviour
lives in `packages/auth/src/saturn/authz.server.ts`,
`packages/database/supabase/functions/lib/saturn-authz.ts` and
`apps/erp/app/modules/saturn/`. Shared files gain hooks (**Auth / session**):
`packages/database/supabase/functions/seed-company/index.ts` (company creation
and onboarding's restore from a backup: the Admin type through the writer, no
template, no `userPermission` grant), the three `deactivate*` functions in
`packages/auth/src/services/users.server.ts` (no `userPermission` strip),
`migrateUserToSso` in `packages/ee/src/sso/provisioning.server.ts` (no invite
permission merge), `apps/erp/app/routes/x+/settings+/people.tsx` (console mode
creates its type first), one more call in the API gate in
`routes/api+/v1+/lib/base.server.ts` (after its authorization checks, with the
operation's input, for `settings_updateConsoleSetting`) and the
`./saturn/authz.server` export in `packages/auth/package.json`. Company restore needed no change: it never wipes
or loads the locked tables, which `packages/jobs/src/saturn-authz/restore.test.ts`
pins.

On 2026-10-20, invite acceptance was made safe for the permission lock as well
(HQ plan 0006B). While the lock is on, `acceptInvite` in
`apps/erp/app/modules/users/users.server.ts` (**Auth / session**) writes
membership only: it sends no `userPermission` request, so a row the projection
has not synced yet can no longer make the guard refuse the invite's permission
merge and roll the invite back. While the lock is off it behaves as upstream. The
hook is one read of `getPermissionsManagement()` and `skippedPermissionWrite(authz) ??`
in front of upstream's `setUserPermissions` call. It cannot live in a fork-owned
file because the merge runs inside upstream's `Promise.all` with the membership
writes, and the rollback reads its result. The invite page
`apps/erp/app/routes/_public+/invite.$code.tsx` (**Login / public pages**) gains
one loader field (`authzManaged`) and one render line for
`apps/erp/app/modules/saturn/ui/AuthzInviteNotice.tsx`, which tells the invitee,
before they join, that access is managed in HQ and may take a minute to appear.
The route owns its loader and layout, and its success redirect already sets the
session cookie, so a flash message there would add a second `Set-Cookie` for the
same cookie and one of them would be lost. The page is public, so it never shows
HQ's access URL. One message was added to the 13 ERP catalogs.

On 2026-10-20, Kong's `authz_api` claim check (HQ plan 0006B Step 7) was added,
off until the operator sets `AUTHZ_API_CLAIM_REQUIRED`, and HQ sign-in now lowers
GoTrue's access-token lifetime to 15 minutes. Both live in fork-owned deployment
tooling (`contrib/deploying/gcp-tailscale/authz_api_claim.py`, `hq_sign_in.py`,
`auth/kong-authz-api.lua`): the renderer still starts from upstream's
`packages/dev/docker/kong.yml` and `docker-compose.prod.yml`, which are
unchanged. It touches no shared upstream file.

On 2026-10-21, the fork raised the security pins in two shared files to the
values upstream `main` already carries (upstream #1940). This covers sharp's
librsvg advisory (GHSA-wq5f-xc86-pv6w, sharp 0.35.5) and the other critical and
high audit findings that had a fix. The files are `pnpm-workspace.yaml` (existing
`overrides` lines and the `axios` catalog entry) and the root `package.json`
(its `fast-uri` dependency). No override line was added. Other fixes are
lockfile-only refreshes within existing ranges. On the next sync, take upstream's
lines, then run `pnpm audit --prod` again: the `regen` driver drops
lockfile-only refreshes. See
[the record](../../.fork/decisions/2026-10-21-dependency-security-pins.md).

## (a) Fork-owned additions — files upstream never touches

These cannot conflict on a sync. They only cost when a shared file they depend on
changes shape.

| Area | Files | What it is |
| --- | --- | --- |
| `packages/portal/`, `apps/portal/`, `apps/portal-worker/`, `apps/portal-query/`, `apps/portal-actions/` | 261 | Company portal platform: ingestion, parser, query service, worker, actions, its own schema and `database.types.ts` (generated from its own migration set, fork-only, so not a `regen` file) |
| `Dockerfile.saturn` | 1 | ERP/MES and ops images with reviewed Node pins, pruned app workspace closure, and preserved fork runtime behavior; Portal images retain their separate Dockerfiles |
| `contrib/deploying/gcp-tailscale/` | ~90 | Self-hosted GCP + Tailscale deployment: `deploy.py`/`deploy.sh`, host rollout, release planning, private Postgres, backups runner, Google-domain auth hook, invoice/payment operator tools, operator docs (`README.md`, `WORKFLOW.md`, `INVOICE-*.md`, `PAYMENT-SYNC.md`) and their tests |
| `contrib/deploying/portal/` | ~25 | Terraform + Cloud Build + local stack for the portal platform |
| `apps/erp/app/modules/invoicing/` (25 added) + `packages/jobs/src/invoice-intake/` (22) | 47 | Reviewed invoice intake and recognition: document review UI, intake worker, integration tests |
| `packages/jobs/src/payment-sync/` (8) + `packages/database/src/mercury.ts` | 9 | Mercury payment import with Gmail invoice matching |
| `apps/erp/app/modules/portal/` (10) + `packages/jobs/src/procurement-schedule/` (5) | 15 | ERP-side portal module and procurement schedule jobs |
| `packages/database/supabase/migrations/` | 8 | Fork migrations: `20260906203248_mercury-payment-import`, `20260907030842_invoice-intake`, `…031408_invoice-intake-company-selections`, `…035112_invoice-intake-document-access`, `20260908004744_knowledge-command-receipts`, `…005300_portal-workforce-identity-resolver`, `…012959_portal-function-execution-boundary`, `…014030_portal-procurement-schedule` |
| `packages/database/supabase/tests/` | 3 | pgTAP-style tests for the fork's RLS boundaries |
| `packages/auth/src/services/` | 3 | Google-domain / session helpers used by the deployment's auth hook |
| `apps/erp/app/routes/api+/`, `apps/erp/app/routes/x+/` | 7 | Routes for invoice intake and portal |
| `apps/erp/test/` | 8 | Login integration, localization rendering/checks, invoice browser tests |
| `scripts/lib/` | 7 | Hardened generators: `generate-db-types.ts` (atomic replace, local-URL guard), `swagger-schema.ts` + partner-alias SQL proof, `local-script-config.ts`, tests |
| `scripts/fork/`, `.github/workflows/{generated-files-drift,upstream-sync,resolve-sync-conflicts}.yml`, `docs/fork/` | 8 + 3 + 5 | The sync mechanism (this document's siblings) |
| `.github/workflows/saturn-invoice-check.yml`, `portal-check.yml` | 2 | CI for the fork's invoice and portal code |
| `.fork/` | ~60 | Agent records policy, fork lessons/plans/specs/decisions, `check-locales.ts` and two tests |
| `.claude/rules/public-fork-workflow.md`, `docs/public-fork.md`, `Makefile` | 3 | Public-fork conventions, privacy policy, `make deploy` entry point |
| `contrib/building/`, `apps/assembler/.dockerignore` | 3 | Build-context privacy overlays |

## (b) Modifications to shared upstream files

153 shared files differ. Grouped by intent; the count is files in the group.

| Group | Files (count) | Note |
| --- | --- | --- |
| **Invoice intake wiring** | `apps/erp/app/modules/purchasing/purchasing.service.ts`, `items/items.server.ts`, `items/items.service.ts`, `invoicing/invoicing.models.ts`, `invoicing/invoicing.service.ts`, `invoicing/ui/PurchaseInvoice/*` (3), `routes/x+/purchase-invoice+/{new,$invoiceId}.tsx`, `routes/api+/purchase-invoice.$invoiceId.map-lines.ts`, `routes/api+/document-extraction.ts`, `components/Form/PdfExtractor.tsx`, `modules/purchasing/ui/SupplierInteraction/SupplierInteractionDocuments.tsx`, `modules/documents/documents.service.ts`, `packages/jobs/src/inngest/functions/extraction/extract-document.ts`, `packages/jobs/src/inngest/functions/tasks/company-backup.transforms.ts`, `packages/database/src/audit.config.ts`, `packages/lib/src/events.ts` (~20) | **extension point.** The intake feature edits upstream's invoicing/purchasing services and UI directly. Most of it could move under `modules/saturn/` behind a small set of hooks (a document-review slot on the purchase-invoice page, an `onExtracted` event), leaving one-line registrations in the shared files. Highest merge-cost group. |
| **Item forms: extra fields** | `modules/items/ui/{Parts/PartForm,Tools/ToolForm,Materials/MaterialForm,Services/ServiceForm,Consumables/ConsumableForm}.tsx`, `components/Form/{UnitOfMeasure,SupplierType,Substance,Shape,MaterialType,MaterialGrade}.tsx` (11) | **extension point / upstream.** Repeated small edits to every item form and combobox. A single "additional item fields" slot upstream would remove all eleven; alternatively the field changes themselves may be generic enough to upstream. |
| **Inngest / event dispatch hooks** | `packages/jobs/src/inngest/index.ts`, `apps/erp/app/routes/api+/inngest.ts`, `packages/lib/src/events.ts` (3) | **extension point.** Registers the fork's functions and dispatch setters. Upstream already has a function list; a registration array the fork appends to would reduce this to one line each. |
| **Login / public pages** | `apps/erp/app/routes/_public+/{login,verify}.tsx`, `apps/erp/app/routes/_public+/invite.$code.tsx`, `apps/mes/app/routes/_public+/login.tsx`, `apps/erp/app/root.tsx`, `apps/mes/app/root.tsx` (6) | **upstream.** `SOURCE_CODE_URL` "Source code" link (AGPL §13 source offer) and Google-domain sign-in restrictions. The source-link is generic to any self-hosted install and is the strongest upstream candidate; the domain restriction is a common self-host need too. The invite page's HQ permissions notice (HQ plan 0006B) is **inherent**. |
| **Auth / session** | `packages/auth/src/services/session.server.ts`, `apps/erp/app/routes/api+/v1+/lib/{base,authenticate}.server.ts`, `packages/database/supabase/functions/lib/supabase.ts`, `apps/erp/app/modules/users/users.server.ts` (5) | **inherent / upstream.** Session and API-key handling for the deployment's auth model; review whether the API changes are generic fixes. |
| **Environment schema** | `packages/env/src/index.ts` (1) | **inherent** while the features are fork-only; shrinks as they move behind hooks (fork-owned code can read its own env). |
| **Accounting: post-payment FX** | `packages/database/supabase/functions/post-payment/{index.ts,build-payment-journal.ts,post-payment.test.ts}`, `functions/lib/utils.ts`, `.claude/rules/numeric-precision.md` (5) | **upstream.** Resolutions from the last upstream merge; the journal-type/pool-runtime separation is a generic fix. |
| **Seed data** | `packages/database/supabase/functions/lib/seed.data.ts` (1, 1,363 lines) | **upstream or drop.** Merge resolution debris rather than intent; re-resolve toward upstream on the next sync. |
| **Docs site** | `docs/components/editorial/architecture-diagrams.tsx`, `docs/app/docs/layout.tsx`, `docs/next.config.mjs`, `docs/scripts/generate-agent-kb.ts` (4) | **upstream or drop.** Mostly merge-resolution residue; the generator change is generic. |
| **Generator hardening** | `scripts/generate-db-types.ts`, `scripts/generate-swagger-docs.ts`, `scripts/generate-mcp.ts`, `scripts/lib/{service-metadata,manifest-digest,validator-to-json-schema}.ts`, `scripts/{model-upload,sales-invoice-report,sandbox}.ts` (9) | **upstream.** Atomic output replacement, local-DB guard, deterministic swagger alias, explicit env configuration instead of embedded values. All generic. |
| **Build / CI plumbing** | `turbo.json`, `package.json` (`clean` keeps the lockfile; `prepare` runs `setup-git.sh`; `fast-uri` pin), `pnpm-workspace.yaml` (security-pin values equal to upstream `main`'s, 2026-10-21; take upstream's on sync), `.github/workflows/check.yml` (runs on `saturn/main`), `.github/workflows/deploy.yml`, `contrib/deploying/simple-docker-caddy/deploy.sh` | **inherent** (trunk name, setup hook, explicit `Dockerfile.saturn` selection) / **upstream** (`clean` not deleting the lockfile). Root `Dockerfile` is upstream-owned. |
| **Privacy ignore rules** | `.gitignore`, `.dockerignore`, `apps/assembler/Dockerfile.dockerignore`, `packages/database/supabase/functions/thumbnail/index.ts` (4) | **upstream.** Generic protection of `.env*`, Terraform, Docker and secret artifacts, and removal of embedded service values. |
| **Tests adjusted to upstream changes** | `apps/erp/test/{localized-submodule-ui,i18n-react-macros,mcp-tool-permissions,mcp-tool-metadata,batching-migration-guards,batching-tenant-scope-and-fk-locks}.test.ts`, `routes/x+/job+/$jobId.status.test.ts`, `modules/production/ui/Schedule/Kanban/drag-lifecycle.test.tsx`, `packages/database/src/check-datasets.ts` (9) | **upstream.** Test repairs for upstream refactors; contribute or drop when upstream catches up. |
| **Agent guidance** | `AGENTS.md`, `.claude/skills/README.md` (2) | **inherent.** Records-policy pointer and the sync-docs router row; kept to a few lines. |
| **Translations** | `packages/locale/locales/*/erp.po` (13) | **inherent.** Strings for fork features; managed by upstream's `merge=union` + post-merge normalisation. |
| **Upstream-pending, not fork edits** | `.claude/rules/numeric-precision.md`, `apps/erp/app/routes/api+/mcp+/lib/manifest.ts` | Differ only because upstream moved ahead of the merge base; disappear on the next sync. |

## (c) Generated and configuration files

| File | Generator | Merge behaviour |
| --- | --- | --- |
| `packages/database/src/types.ts`, `packages/database/supabase/functions/lib/types.ts` (identical copies) | `pnpm generate:types` (needs the migrated local DB; `Relationships` blocks sorted for determinism) | `merge=regen` |
| `packages/database/src/swagger-docs-schema.ts` | `pnpm generate:swagger` (needs Studio) | `merge=regen` |
| `packages/jobs/manifests/schema.json` | `pnpm db:check:backups -- --stage` (`regenerate.sh` compares semantically; `exportedAt` and column order are not stable) | `merge=regen` |
| `apps/erp/app/routes/api+/mcp+/lib/tool-manifest.digest.json` | `pnpm generate:mcp` (also postinstall) | `merge=regen` |
| `packages/workflows/src/catalog/*.generated.ts` | `pnpm generate:workflow-catalog` | `merge=regen` |
| `apps/erp/app/modules/agent/kb/**` | `pnpm generate:agent-kb` | `merge=regen` |
| `pnpm-lock.yaml` | `pnpm install` | `merge=regen` |
| `Cargo.lock` | `cargo update --workspace` | `merge=regen` |
| `packages/locale/locales/**/*.po` | `pnpm lingui:extract && pnpm lingui:clean` (authored msgstr, extracted msgid) | upstream's `merge=union` + post-merge hook |
| `packages/portal/src/database.types.ts` | portal platform's own generator (fork-only inputs) | ordinary file; upstream never has it |
| `.gitattributes`, `package.json` `prepare`, `.github/workflows/check.yml` triggers | hand-maintained | the fork's three configuration hooks for this process |
