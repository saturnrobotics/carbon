# Implement the local sync agent

Approved autonomously under the operator's request to implement the complete
workflow. Baseline: `6dd83471173a9365bc65c7849cd2a97f245457f7`.
See [specification](../specs/2026-09-09-sync-agent.md).

- [x] Add regression fixtures in `contrib/deploying/gcp-tailscale/test_sync_agent.py`;
  run `python3 -m unittest discover -s contrib/deploying/gcp-tailscale -p test_sync_agent.py -v`
  and observe the missing behavior fail before implementation.
- [x] Implement `sync_agent.py` and its bounded structured Codex protocol;
  independently control Git writes, local gates, CI polling and promotion.
- [x] Wire the existing Makefile sync target and document invocation, resume,
  budgets, credentials, review boundary and limitations in WORKFLOW.md.
- [x] Run the new fixtures, existing fork and verification fixtures, strict Python
  lint, fork preflight and installer tests. Run a synthetic actual Codex invocation.
  Independently review the diff and fix findings. Keep all evidence local.
- [x] Commit exact public paths through normal hooks. Record the evidence and
  remaining limits; no real upstream sync or deployment during implementation.

Verification: 31 controller fixtures, 14 fork-helper fixtures, 16 GitHub evidence
fixtures, and 152 fork safeguards passed. The opt-in actual Codex 0.144.1 smoke
passed on macOS. Publication and live upstream integration are outside this
implementation run; CI attestation for the feature itself remains separate.
