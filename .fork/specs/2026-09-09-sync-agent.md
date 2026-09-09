# Local upstream integration agent

The operator runs `make sync` from the original checkout. A Python controller
creates or resumes a persistent isolated candidate; the locally authenticated
Codex CLI reconciles authored inputs and repairs generated outputs and CI failures.
The shared integration branch uses merges, never rebases or force pushes.
Deployment is separate.

## Decisions

- Use the installed Codex CLI and its existing login; no production dependency or
  API key is added. This follows the operator's request for autonomous coding-agent
  maintenance. Default execution is autonomous, with a bounded repair budget.
- The controller owns Git writes, records the original reviewed baseline and
  upstream SHA, and independently checks exact-SHA GitHub evidence. Model output
  is a request, never verification evidence.
- Codex runs in workspace-write mode with approvals disabled, user configuration
  and execution rules ignored, and no writable shared Git directory. It receives
  a structured protocol for staging, disposable schema repair, and submission.
- State and raw subprocess output remain in ignored local storage. A process lock
  serializes controller runs. Interruptions retain the candidate and are resumed
  by the same command. Existing unowned worktrees require explicit adoption.
- Freeze verification/control files against the reviewed baseline before executing
  candidate commands; changes to these files require separate reviewed integration.
  This is a fail-closed boundary, not a claim of protection against hostile source.
- Sanitize inherited subprocess environments; never pass production tokens or
  deployment settings. Workspace-write restricts writes, not all host reads.
  Run only trusted upstream source on a developer machine. Strong hostile-code
  isolation requires a separate disposable host without deployment credentials.
- Run local preflight and generated checks, commit through normal hooks, publish
  only the candidate branch, wait for required CI, obtain a separate model review,
  then fast-forward local saturn/main. Do not push saturn/main or deploy.
- Pending CI waits without consuming repair turns. Failed CI returns diagnostic
  logs to the repair agent. Budgets are explicit; access failures preserve state.

## Acceptance

Real disposable Git fixtures prove conflict preservation, explicit staging,
non-rewriting promotion, stale-base refusal, resumability, and rejection of
unverified or tampered candidates. Provider and GitHub boundaries use synthetic
responses in regression tests; a real local Codex smoke test verifies protocol
compatibility without syncing the live repository.

## Implementation evidence

Implemented in `contrib/deploying/gcp-tailscale/sync_agent.py` with a separate
worker prompt and opt-in `smoke_sync_agent.py`. GitHub evidence retains its existing
ValueError contract while distinguishing pending runs from validated failures.
Regression fixtures cover real conflicted merges, exact-SHA promotion, CI repair,
process locking, interrupted preparation/commit/promotion, unsafe paths and changed
verification controls. No live upstream candidate or deployment was changed.
