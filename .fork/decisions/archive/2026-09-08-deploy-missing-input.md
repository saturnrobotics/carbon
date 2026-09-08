# Bugfix run: deployment missing-input diagnostics

- Mode: autonomous; diagnose, fix, offline regression verification.
- Request: diagnose a generic FileNotFoundError from make deploy.
- Root cause (high confidence): apply reads the required private release plan before invoking deployment. A missing input raises FileNotFoundError from Path.stat; the CLI's privacy guard suppresses the filename.
- Fix: translate missing private input into an actionable ValueError identifying the configuration path and preparation instructions. Preserve other exception redaction and existing deployment safeguards.
- Verification: regression failed before the fix with FileNotFoundError; all 48 deploy, release planner, and service rollout tests passed after the fix. Guarded CLI preflight identified the missing release plan without invoking deployment. Scoped diff whitespace check passed.
- Browser verification: skipped; Python CLI behavior covered by regression.
- Commit: skipped; not requested.
- Outcome: diagnostics fixed. Deployment still requires a reviewed private release manifest with actual release inputs; no placeholder manifest was generated and no cloud rollout was attempted.
