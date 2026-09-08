## Prove restricted-role publication before building the surrounding workflow

**Context:** A document workflow passed mocked services but failed its first browser run with a publish-only user.

**Problem:** INSERT/UPDATE with RETURNING or ON CONFLICT invokes additional PostgreSQL SELECT-policy checks, including visibility of the new row. An owner-admin grant also both escalated uploaders and made publication require admin. Repeated failed tests left published fixture documents in later suites' search corpus.

**Rule:** Exercise capture, review, publication, replay and deletion through the exact runtime roles early, including a publisher without admin. Keep permissions tied to the operation, never repair a failure by broadening the fixture user. Give each integration run unique content and clean its own visible fixture records even after a failed assertion.

**Applies to:** Forced-RLS document workflows, immutable publication, and shared disposable integration databases.
