# Verify source coverage and translation completeness separately

Context → Locale compilation passed with missing translations, and the standalone
completeness checker only inspected messages already present in the catalogs.

Problem → An agent could add a translated JSX message but omit extraction, leaving
other languages without that message while both existing checks passed.

Rule → Use the pinned Lingui extractor to check current source message IDs against
every configured locale without rewriting catalogs. Run the existing completeness
check as well as compilation. Missing source coverage, empty translations, and
extraction errors must fail CI. Preserve unrelated authored obsolete translations;
do not delete them merely to make a generated-file comparison pass.

Applies to → `.fork/check-locales.ts`, locale regression fixtures, and required
source CI for agent-authored interface changes.
