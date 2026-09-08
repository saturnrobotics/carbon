# Fork maintenance

[agent-policy.md](agent-policy.md) is the persistent workflow policy for agents.
The root `AGENTS.md` loads it, and `CLAUDE.md` imports that root entry point. The
[fork-maintenance skill](../.claude/skills/fork-maintenance/SKILL.md) supplies the
integration procedure; the existing installer copies it into the Codex harness.

Keep fork lessons, plans, specs, research, and reusable playbooks here. Each lesson
or decision gets its own dated file. Read relevant upstream `.ai/` records without
appending fork history to them. `.fork/local/` holds ignored execution logs,
screenshots, fixtures, and transient state. Public-fork privacy applies to every
tracked record. Existing authored run evidence moved to `decisions/archive/` is
historical documentation, not a destination for future runtime output.

[generated-artifacts.json](generated-artifacts.json) records ownership and
reproduction requirements. Check committed inputs before installation:

```bash
python3 .fork/verify.py preflight --revision HEAD
```

After reconciling source inputs and installing the repository-pinned dependencies,
verify generation and the safeguards themselves:

```bash
python3 .fork/verify.py generated
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .fork/tests -v
```

Integration requires the previous reviewed revision as the preflight `--base`,
scoped application checks, and successful `fork-verified` CI for the exact commit.
See the [branch workflow](../contrib/deploying/gcp-tailscale/WORKFLOW.md) for
synchronization and promotion. These checks detect corrupted inputs, artifact
drift, and integration-policy violations; behavior tests and actual deployment
configuration validation remain necessary.
