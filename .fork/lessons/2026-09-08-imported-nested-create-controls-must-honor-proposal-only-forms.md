## Nested create controls must honor proposal-only forms

**Context:** Reusing native supplier and item forms to collect proposed records for later transactional approval.

**Problem:** Preventing the outer form submit did not prevent nested creatable selectors or CAD upload controls from writing records early.

**Rule:** Explicitly defer nested master creation and uploads in proposal mode. Keep ordinary forms unchanged, retain existing selector options, and create proposed masters only in the final authorized transaction.

**Applies to:** Reused forms in staged document-review and approval flows.
