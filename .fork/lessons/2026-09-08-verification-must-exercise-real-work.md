# A check must exercise its claimed behavior

Context → Broad verification exposed stale upstream test assumptions, missing fixture dependencies, silently skipped database tests, and generated output from a helper different from the production generator.

Problem → A test name or successful subprocess exit does not establish that the intended source, files, database path, or candidate revision was checked.

Rule → Trace each gate to its real inputs and call sites. Require nonempty test collection, no skipped mandatory tests, actual lint file counts, pinned tool resolution, and exact candidate identity. Preserve behavioral assertions when upstream moves a call or consolidates a migration. Reproduce unrelated failures and report them as blockers; never remove assertions merely to obtain a green release.

Applies to → CI changes, upstream sync, test maintenance, generator verification, and agent claims of completion.
