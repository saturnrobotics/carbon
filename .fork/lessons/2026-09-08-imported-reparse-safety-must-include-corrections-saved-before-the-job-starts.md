## Reparse safety must include corrections saved before the job starts

**Context:** A later receipt or explicit reparse starts a new extraction generation for an existing intake.

**Problem:** Revision checks preserved edits made during inference, but successful hydration still replaced corrections that existed before admission. Happy-path extraction counts and concurrent-edit tests did not prove preservation.

**Rule:** Keep immutable extraction output separate from saved review decisions. Test both late-document arrival and explicit reparse after saved header/line corrections, and require explicit acknowledgement of newly extracted evidence. Apply one eligibility policy to every duplicate-source guard. Validate all unresolved attachment decisions and the complete resulting Draft, not only incoming lines.

**Applies to:** Invoice intake, document retries, payment reconciliation, and generated proposals.
