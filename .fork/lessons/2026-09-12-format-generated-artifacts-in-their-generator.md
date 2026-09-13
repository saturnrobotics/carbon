# Format a generated artifact inside its generator, not by the commit hook

**Context:** `packages/jobs/manifests/schema.json` is written by `writeSchemaFile`
in `packages/jobs/src/scripts/check-backups.ts` and staged by
`pnpm db:check:backups -- --stage`, which `.husky/pre-commit` runs. The committed
copy on the trunk passed `biome check`, so a regenerated copy failing it looked
like a corrupted write rather than a formatting difference.

**Problem:** `JSON.stringify(value, null, 2)` always breaks arrays across lines,
while the repository's formatter collapses the short ones. The staged-file lint
pattern does cover that path, but the hook runs the formatter *before* the
generator writes and stages, so the freshly written bytes are never formatted.
The trunk copy was clean only because someone had staged it by hand, ahead of the
formatter, in an earlier commit. A branch that regenerated it honestly therefore
failed lint while the branch that hand-staged it passed, which inverts what the
two checks are supposed to mean.

**Rule:** A generator that writes a tracked artifact formats that artifact itself,
before staging it. Do not rely on a commit hook's staged-file formatter for a file
the hook itself stages later, and do not hand-format the committed copy: the next
regeneration silently reverts it. Prove the result is stable by regenerating twice
and format-checking both outputs.

**Applies to:** any tracked generated artifact under a `merge=regen` rule, and
every script that pairs a write with its own `git add`.
