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
must stay a fork edit. Nothing here has been reshaped yet; this is the map.

## (a) Fork-owned additions — files upstream never touches

These cannot conflict on a sync. They only cost when a shared file they depend on
changes shape.

| Area | Files | What it is |
| --- | --- | --- |
| `packages/knowledge/`, `apps/knowledge/`, `apps/knowledge-worker/`, `apps/knowledge-query/`, `apps/knowledge-actions/` | 261 | Company knowledge platform: ingestion, parser, query service, worker, actions, its own schema and `database.types.ts` (generated from its own migration set, fork-only, so not a `regen` file) |
| `contrib/deploying/gcp-tailscale/` | ~90 | Self-hosted GCP + Tailscale deployment: `deploy.py`/`deploy.sh`, host rollout, release planning, private Postgres, backups runner, Google-domain auth hook, invoice/payment operator tools, operator docs (`README.md`, `WORKFLOW.md`, `INVOICE-*.md`, `PAYMENT-SYNC.md`) and their tests |
| `contrib/deploying/knowledge/` | ~25 | Terraform + Cloud Build + local stack for the knowledge platform |
| `apps/erp/app/modules/invoicing/` (25 added) + `packages/jobs/src/invoice-intake/` (22) | 47 | Reviewed invoice intake and recognition: document review UI, intake worker, integration tests |
| `packages/jobs/src/payment-sync/` (8) + `packages/database/src/mercury.ts` | 9 | Mercury payment import with Gmail invoice matching |
| `apps/erp/app/modules/knowledge/` (10) + `packages/jobs/src/procurement-schedule/` (5) | 15 | ERP-side knowledge module and procurement schedule jobs |
| `packages/database/supabase/migrations/` | 8 | Fork migrations: `20260906203248_mercury-payment-import`, `20260907030842_invoice-intake`, `…031408_invoice-intake-company-selections`, `…035112_invoice-intake-document-access`, `20260908004744_knowledge-command-receipts`, `…005300_knowledge-workforce-identity-resolver`, `…012959_knowledge-function-execution-boundary`, `…014030_knowledge-procurement-schedule` |
| `packages/database/supabase/tests/` | 3 | pgTAP-style tests for the fork's RLS boundaries |
| `packages/auth/src/services/` | 3 | Google-domain / session helpers used by the deployment's auth hook |
| `apps/erp/app/routes/api+/`, `apps/erp/app/routes/x+/` | 7 | Routes for invoice intake and knowledge |
| `apps/erp/test/` | 8 | Login integration, localization rendering/checks, invoice browser tests |
| `scripts/lib/` | 7 | Hardened generators: `generate-db-types.ts` (atomic replace, local-URL guard), `swagger-schema.ts` + partner-alias SQL proof, `local-script-config.ts`, tests |
| `scripts/fork/`, `.github/workflows/{generated-files-drift,upstream-sync,resolve-sync-conflicts}.yml`, `docs/fork/` | 8 + 3 + 5 | The sync mechanism (this document's siblings) |
| `.github/workflows/saturn-invoice-check.yml`, `knowledge-check.yml` | 2 | CI for the fork's invoice and knowledge code |
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
| **Login / public pages** | `apps/erp/app/routes/_public+/{login,verify}.tsx`, `apps/erp/app/routes/_public+/invite.$code.tsx`, `apps/mes/app/routes/_public+/login.tsx`, `apps/erp/app/root.tsx`, `apps/mes/app/root.tsx` (6) | **upstream.** `SOURCE_CODE_URL` "Source code" link (AGPL §13 source offer) and Google-domain sign-in restrictions. The source-link is generic to any self-hosted install and is the strongest upstream candidate; the domain restriction is a common self-host need too. |
| **Auth / session** | `packages/auth/src/services/session.server.ts`, `apps/erp/app/routes/api+/v1+/lib/{base,authenticate}.server.ts`, `packages/database/supabase/functions/lib/supabase.ts` (4) | **inherent / upstream.** Session and API-key handling for the deployment's auth model; review whether the API changes are generic fixes. |
| **Environment schema** | `packages/env/src/index.ts` (1) | **inherent** while the features are fork-only; shrinks as they move behind hooks (fork-owned code can read its own env). |
| **Accounting: post-payment FX** | `packages/database/supabase/functions/post-payment/{index.ts,build-payment-journal.ts,post-payment.test.ts}`, `functions/lib/utils.ts`, `.claude/rules/numeric-precision.md` (5) | **upstream.** Resolutions from the last upstream merge; the journal-type/pool-runtime separation is a generic fix. |
| **Seed data** | `packages/database/supabase/functions/lib/seed.data.ts` (1, 1,363 lines) | **upstream or drop.** Merge resolution debris rather than intent; re-resolve toward upstream on the next sync. |
| **Docs site** | `docs/components/editorial/architecture-diagrams.tsx`, `docs/app/docs/layout.tsx`, `docs/next.config.mjs`, `docs/scripts/generate-agent-kb.ts` (4) | **upstream or drop.** Mostly merge-resolution residue; the generator change is generic. |
| **Generator hardening** | `scripts/generate-db-types.ts`, `scripts/generate-swagger-docs.ts`, `scripts/generate-mcp.ts`, `scripts/lib/{service-metadata,manifest-digest,validator-to-json-schema}.ts`, `scripts/{model-upload,sales-invoice-report,sandbox}.ts` (9) | **upstream.** Atomic output replacement, local-DB guard, deterministic swagger alias, explicit env configuration instead of embedded values. All generic. |
| **Build / CI plumbing** | `turbo.json`, `Dockerfile`, `package.json` (`clean` keeps the lockfile; `prepare` runs `setup-git.sh`), `.github/workflows/check.yml` (runs on `saturn/main`) (4) | **inherent** (trunk name, setup hook) / **upstream** (`clean` not deleting the lockfile). |
| **Privacy ignore rules** | `.gitignore`, `.dockerignore`, `apps/assembler/Dockerfile.dockerignore`, `packages/database/supabase/functions/thumbnail/index.ts` (4) | **upstream.** Generic protection of `.env*`, Terraform, Docker and secret artifacts, and removal of embedded service values. |
| **Tests adjusted to upstream changes** | `apps/erp/test/{localized-submodule-ui,i18n-react-macros,mcp-tool-permissions,mcp-tool-metadata,batching-migration-guards,batching-tenant-scope-and-fk-locks}.test.ts`, `routes/x+/job+/$jobId.status.test.ts`, `modules/production/ui/Schedule/Kanban/drag-lifecycle.test.tsx`, `packages/database/src/check-datasets.ts` (9) | **upstream.** Test repairs for upstream refactors; contribute or drop when upstream catches up. |
| **Agent guidance** | `AGENTS.md`, `.claude/skills/README.md` (2) | **inherent.** Records-policy pointer and the sync-docs router row; kept to a few lines. |
| **Translations** | `packages/locale/locales/*/erp.po` (13) | **inherent.** Strings for fork features; managed by upstream's `merge=union` + post-merge normalisation. |
| **Upstream-pending, not fork edits** | `.claude/rules/numeric-precision.md`, `apps/erp/app/routes/api+/mcp+/lib/manifest.ts` | Differ only because upstream moved ahead of the merge base; disappear on the next sync. |

## (c) Generated and configuration files

| File | Generator | Merge behaviour |
| --- | --- | --- |
| `packages/database/src/types.ts`, `packages/database/supabase/functions/lib/types.ts` (identical copies) | `pnpm generate:types` (needs the migrated local DB) | `merge=regen` |
| `packages/database/src/swagger-docs-schema.ts` | `pnpm generate:swagger` (needs Studio) | `merge=regen` |
| `packages/jobs/manifests/schema.json` | `pnpm db:check:backups -- --stage` | `merge=regen` |
| `apps/erp/app/routes/api+/mcp+/lib/tool-manifest.digest.json` | `pnpm generate:mcp` (also postinstall) | `merge=regen` |
| `packages/workflows/src/catalog/*.generated.ts` | `pnpm generate:workflow-catalog` | `merge=regen` |
| `apps/erp/app/modules/agent/kb/**` | `pnpm generate:agent-kb` | `merge=regen` |
| `pnpm-lock.yaml` | `pnpm install` | `merge=regen` |
| `Cargo.lock` | `cargo update --workspace` | `merge=regen` |
| `packages/locale/locales/**/*.po` | `pnpm lingui:extract && pnpm lingui:clean` (authored msgstr, extracted msgid) | upstream's `merge=union` + post-merge hook |
| `packages/knowledge/src/database.types.ts` | knowledge platform's own generator (fork-only inputs) | ordinary file; upstream never has it |
| `.gitattributes`, `package.json` `prepare`, `.github/workflows/check.yml` triggers | hand-maintained | the fork's three configuration hooks for this process |
