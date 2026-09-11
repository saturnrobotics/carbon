# Fork drift

The fork's diff against `upstream/main` is a cost paid on every sync. Track it
here; regenerate the numbers with `bash scripts/fork/drift.sh` and add a snapshot
after each sync PR. The goal is a downward trend, driven by the upstreaming and
extension-point work listed in [`CUSTOMIZATIONS.md`](CUSTOMIZATIONS.md) §(b).

`A...B` diffs below count only fork-side changes since the merge base with
upstream; pending upstream commits are listed separately.

## Snapshot 1 — before the purge (saturn/main `b07db8ca61`, 2026-09-11)

```
 763 files changed, 122743 insertions(+), 5652 deletions(-)

fork-added 604 · shared modified 156 · upstream files deleted 3 · upstream commits pending 22
```

Top 20 shared upstream files by lines changed (added+deleted):

```
  6328  +5943  -385   packages/database/src/swagger-docs-schema.ts
  6282  +3287  -2995  packages/jobs/manifests/schema.json
  2188  +2182  -6     packages/database/supabase/functions/lib/types.ts
  2188  +2182  -6     packages/database/src/types.ts
  1363  +1249  -114   packages/database/supabase/functions/lib/seed.data.ts
  1096  +956   -140   docs/components/editorial/architecture-diagrams.tsx
   858  +846   -12    packages/locale/locales/zh/erp.po
   858  +846   -12    packages/locale/locales/tr/erp.po
   858  +846   -12    packages/locale/locales/hi/erp.po
   858  +846   -12    packages/locale/locales/de/erp.po
   856  +845   -11    packages/locale/locales/ru/erp.po
   856  +845   -11    packages/locale/locales/pt/erp.po
   856  +845   -11    packages/locale/locales/pl/erp.po
   856  +845   -11    packages/locale/locales/ko/erp.po
   856  +845   -11    packages/locale/locales/ja/erp.po
   856  +845   -11    packages/locale/locales/it/erp.po
   856  +845   -11    packages/locale/locales/fr/erp.po
   856  +845   -11    packages/locale/locales/es/erp.po
   844  +839   -5     packages/locale/locales/en/erp.po
   663  +627   -36    pnpm-lock.yaml
```

## Snapshot 2 — after the purge (`chore/fork-sync-tooling` at `5c11eb4c4e`, 2026-09-11)

```
 721 files changed, 112861 insertions(+), 5646 deletions(-)

fork-added 565 · shared modified 153 · upstream files deleted 3 · upstream commits pending 22
```

The purge removed 42 fork-added files and restored 3 shared files (`.husky/pre-commit`, `.husky/post-merge`, `.gitattributes`) to upstream's version: 9,882 lines of fork-only diff gone, no application code touched. The remaining shared-file drift is dominated by generated files (swagger, backup manifest, DB types — now `merge=regen`, so they no longer cost anything on merge) and the 13 translation catalogs.

Top 20 shared upstream files by lines changed (added+deleted):

```
  6328  +5943  -385   packages/database/src/swagger-docs-schema.ts
  6282  +3287  -2995  packages/jobs/manifests/schema.json
  2188  +2182  -6     packages/database/supabase/functions/lib/types.ts
  2188  +2182  -6     packages/database/src/types.ts
  1363  +1249  -114   packages/database/supabase/functions/lib/seed.data.ts
  1096  +956   -140   docs/components/editorial/architecture-diagrams.tsx
   858  +846   -12    packages/locale/locales/zh/erp.po
   858  +846   -12    packages/locale/locales/tr/erp.po
   858  +846   -12    packages/locale/locales/hi/erp.po
   858  +846   -12    packages/locale/locales/de/erp.po
   856  +845   -11    packages/locale/locales/ru/erp.po
   856  +845   -11    packages/locale/locales/pt/erp.po
   856  +845   -11    packages/locale/locales/pl/erp.po
   856  +845   -11    packages/locale/locales/ko/erp.po
   856  +845   -11    packages/locale/locales/ja/erp.po
   856  +845   -11    packages/locale/locales/it/erp.po
   856  +845   -11    packages/locale/locales/fr/erp.po
   856  +845   -11    packages/locale/locales/es/erp.po
   844  +839   -5     packages/locale/locales/en/erp.po
   663  +627   -36    pnpm-lock.yaml
```

## Snapshot 3 — dry-run of the first sync with the new tooling (2026-09-11)

`FORK_TRUNK=chore/fork-sync-tooling bash scripts/fork/sync-upstream.sh --dry-run`
(the trunk was overridden to this branch so the new `.gitattributes` applied; the
merge was aborted and the temporary branch deleted afterwards):

```
DRY RUN — nothing was committed.
  branch that would be created : sync/upstream-2026-09-11
  upstream target              : upstream/main @ 404dd0bfe4
  pending upstream commits     : 23
  files changed by the merge   : 470
  regen-driver files from upstream (13):
      apps/erp/app/modules/agent/kb/docs/reference/accounting.md
      apps/erp/app/modules/agent/kb/docs/reference/batching.md
      apps/erp/app/modules/agent/kb/docs/reference/payments.md
      apps/erp/app/modules/agent/kb/docs/reference/rmas.md
      apps/erp/app/modules/agent/kb/docs/reference/scheduling.md
      apps/erp/app/modules/agent/kb/docs/reference/supplier-returns.md
      apps/erp/app/modules/agent/kb/manifest.json
      apps/erp/app/routes/api+/mcp+/lib/tool-manifest.digest.json
      packages/database/src/swagger-docs-schema.ts
      packages/database/src/types.ts
      packages/database/supabase/functions/lib/types.ts
      packages/jobs/manifests/schema.json
      pnpm-lock.yaml
  CONFLICTS in 16 file(s):
      apps/erp/app/modules/accounting/accounting.periods.test.ts
      apps/erp/app/modules/production/ui/Schedule/Kanban/drag-lifecycle.test.tsx
      apps/erp/app/modules/purchasing/purchasing.service.ts
      apps/erp/app/routes/x+/job+/$jobId.status.test.ts
      apps/erp/package.json
      apps/erp/test/batching-migration-guards.test.ts
      apps/erp/test/batching-tenant-scope-and-fk-locks.test.ts
      apps/erp/test/i18n-react-macros.test.ts
      apps/erp/test/localized-submodule-ui.test.ts
      docs/app/docs/layout.tsx
      packages/database/supabase/functions/lib/seed.data.ts
      packages/database/supabase/functions/post-memo/build-memo-journal.ts
      packages/database/supabase/functions/post-payment/build-payment-journal.ts
      packages/database/supabase/functions/post-payment/index.ts
      packages/database/supabase/functions/post-payment/post-payment.test.ts
      scripts/lib/service-metadata.ts
  » migrations introduced relative to f379a5cd632717692b68304972ca905d28375201 (newest already on base: 20260909014032):
      ! packages/database/supabase/migrations/20260908021155_accounting_posting_corrections.sql (older than 20260909014032)
      ! packages/database/supabase/migrations/20260908030026_accounting_balances_and_reports.sql (older than 20260909014032)
      ! packages/database/supabase/migrations/20260908142501_returns-module.sql (older than 20260909014032)
        packages/database/supabase/migrations/20260909173619_preserve_inactive_account_report_balances.sql
        packages/database/supabase/migrations/20260909174352_account_for_memo_refunds_in_subledger_reports.sql
        packages/database/supabase/migrations/20260909195813_returnable-receipt-lines-rpc.sql
        packages/database/supabase/migrations/20260910093006_assembly-step-lineage.sql
        packages/database/supabase/migrations/20260911130000_backfill-tracked-entity-item-id.sql
  ! 3 migration(s) above are timestamped before the newest migration already on f379a5cd632717692b68304972ca905d28375201.
  ! Supabase applies by version, so they will still run on databases that have not seen them,
  ! but confirm they do not assume schema state that a later fork migration already changed.
```

Reading: 23 upstream commits are pending. All 13 generated files the merge
touches were taken from upstream by the `regen` driver without conflict — under
the old process every one of them was a hand-resolved conflict. 16 real files
conflict; they fall into three of the groups in `CUSTOMIZATIONS.md` §(b): the
accounting/post-payment merge residue (5 files, **upstream or re-resolve toward
upstream**), the test files adjusted to earlier upstream refactors (7 files,
**drop the fork versions**), and the invoice-intake wiring in
`purchasing.service.ts` plus the generator hardening in `service-metadata.ts`
(**extension point** / **upstream**). `seed.data.ts` and `docs/app/docs/layout.tsx`
are merge debris to re-resolve toward upstream. Three incoming upstream migrations
are timestamped before the fork's newest migration; they touch accounting and the
returns module, not the fork's tables, so the ordering warning is informational.

