# Fork records

[agent-policy.md](agent-policy.md) is the persistent records policy for agents. The
root `AGENTS.md` loads it, and `CLAUDE.md` imports that root entry point.

Keep fork lessons, plans, specs, research, decisions, and reusable playbooks here.
Each lesson or decision gets its own dated file. Read relevant upstream `.ai/`
records without appending fork history to them. `.fork/local/` holds ignored
execution logs, screenshots, fixtures, and transient state. Public-fork privacy
applies to every tracked record. Existing authored run evidence moved to
`decisions/archive/` is historical documentation, not a destination for future
runtime output.

Two application checks also live here because they have no upstream home:
`check-locales.ts` (source message coverage across every locale) and the tests
under `tests/`.
