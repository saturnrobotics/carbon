## Autofixes need semantic review and complete lint verification

**Context:** An unused catch binding remained in newly added code and Biome offered an underscore rename as an unsafe fix.

**Problem:** Treating a diagnostic as an operator task or applying a name-only workaround leaves unnecessary code and weakens the engineering handoff.

**Rule:** Run scoped safe autofixes, inspect their changes, and repair remaining diagnostics at the cause. Omit an unused catch binding instead of renaming it; preserve side effects when removing other unused values. Never add dummy reads, suppressions, or rule exemptions merely to quiet lint. Verify changed code with lint before declaring completion.

**Applies to:** All agent-authored code, lint cleanup, and commit preparation.
