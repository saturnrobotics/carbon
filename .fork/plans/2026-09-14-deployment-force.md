# Explicit deployment CI override

The user authorizes an invocation-only override of GitHub verification evidence.

- [x] Add regression coverage for default enforcement, explicit override, CLI/Make forwarding and retained source checks.
- [x] Add --force to both deployment scripts and FORCE=1 / -- --force to Make deployment targets only.
- [x] Document the exception and its boundaries without changing GitHub checks or fabricating success receipts.
- [x] Run both deployment Python suites, scoped lint/format, Make dry-runs and independent review.
- [ ] Integrate through normal PR/CI; do not run a forced deployment as part of implementation.

Validation: 223 ERP deployment tests and 190 Portal tests pass. Scoped Ruff lint/format and Make dry-runs pass; independent review found no blockers. ERP tests use the existing pinned deployment Python and OpenSSL 3. No runtime/provider contract changes or production deployment were required.
