# Repair fork verification failures

Base: `9d697fe6be9afbbaf7c25a5be8a761b7dea80bfa` (`saturn/main`).

- [x] Reproduce the private PostgreSQL certificate mismatch failure using OpenSSL 3; preserve the rejecting regression and fix the certificate check.
- [x] Diagnose the knowledge runtime database recovery failure using an owned synthetic test stack; fix the proven cause with regression evidence.
- [x] Diagnose the invoice integration timeout; preserve all behavioral assertions and correct the measured cause.
- [x] Run scoped tests, lint, typechecks, snapshot preflight, and generated comparisons. Review the public diff and commit only intended files.
- [ ] Publish a candidate descended from the base and require real `fork-verified` success for that exact SHA. Preserve branch protections; no deployment or check bypass.

Local logs and synthetic runtime evidence belong in ignored `.fork/local/ci-repairs/`.

The PostgreSQL cause is the image's optional supautils permission-hint hook. Disable only that hook consistently in the dev, deployment, local knowledge, evaluation, and CI startup definitions; do not change grants, RLS, or preload libraries. Strict negative SQL proofs must reject infrastructure failure and require the expected permission SQLSTATE.

The later procurement integration command also lacked canonical feature tables in the minimal knowledge fixture. Load the real receipt/scheduler migrations after synthetic predecessors, give the synthetic worker a separate narrow role, and verify repeated setup preserves table identity and restricted runtime roles.

The first candidate passed GitHub source, application, invoice, and knowledge jobs. The schema guard correctly required dedicated platform-transition proof for the new startup setting. Add narrow recognition using full Compose definitions before and after interpolation, reject all other platform changes, and verify an actual base-to-candidate restart with preserved database identity, volumes, data, ledger, and schema. Require fresh/upgrade/committed artifact agreement and real permission denials after the transition. The final exact-SHA CI result is recorded in ignored local evidence and GitHub.
