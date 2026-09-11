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

DRYRUN_PLACEHOLDER
