## Preserve full database revision precision across the driver boundary

**Context:** Comparing a reviewed draft with its stored PostgreSQL revision before merging invoice lines.

**Problem:** PostgreSQL drivers can return JavaScript Date objects despite generated string types, truncating timestamp precision if application code converts them.

**Rule:** Select date-only values and optimistic-concurrency timestamp tokens as SQL `::text`, then compare the unchanged server token inside the transaction. Use the normal date utilities for user-facing dates.

**Applies to:** Invoice intake, Kysely/pg revision checks, and edits of existing financial documents.
