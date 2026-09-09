# Ordered upstream and sync-agent integration

Authorized order: first merge the existing upstream integration candidate into
`saturn/main`, then merge `feat/sync-agent` on top. Preserve both histories and
require exact-revision fork verification before each promotion. Do not deploy.

Reviewed starting revision: `6dd83471173a9365bc65c7849cd2a97f245457f7`.
Pinned upstream: `fd36363b6bc508e29d7630b505f074fdba0e7762`.
Sync-agent feature: `715f3fad79133f2c38f20c97d0775669ace1300b`, including the
pending-merge index-preflight regression repair.

- [x] Reconcile the login, lockfile and generated MCP conflicts; bootstrap pinned
  tools, regenerate owned outputs and validate the reviewed index.
- [ ] Commit the upstream candidate with normal hooks, publish it for exact-SHA CI,
  resolve failures and promote that verified commit to local `saturn/main`.
- [ ] Merge the sync-agent feature into a descendant of the first candidate,
  run scoped regressions and generation checks, publish for CI and promote only
  after the resulting revision passes.

Raw diagnostics and local paths stay under ignored `.fork/local/`.

Local evidence before promotion: all four non-schema generated artifact groups
pass; 152 safeguard tests and 33 controller tests pass. Fresh and upgraded schemas
agree with committed artifacts for the upstream candidate. Exact-revision CI and
the two ordered promotions remain mandatory; candidate preparation may overlap.

Upstream candidate for first promotion:
`dd9c52d9701bff68fedb96bf990d0b4ed4b92257`. Its additional repairs separate a
pure journal type from a runtime driver and initialize the real PDF runtime in
bounded test setup. The combined candidate includes this exact revision and the
feature history. All 204 operator tests pass with the required local toolchain.
