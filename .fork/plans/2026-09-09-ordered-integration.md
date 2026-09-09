# Ordered upstream and sync-agent integration

Authorized order: first merge the existing upstream integration candidate into
`saturn/main`, then merge `feat/sync-agent` on top. Preserve both histories and
require exact-revision fork verification before each promotion. Do not deploy.

Reviewed starting revision: `6dd83471173a9365bc65c7849cd2a97f245457f7`.
Pinned upstream: `fd36363b6bc508e29d7630b505f074fdba0e7762`.
Sync-agent feature: `ebe9acebe7` (resolve the full object before integration).

- [x] Reconcile the login, lockfile and generated MCP conflicts; bootstrap pinned
  tools, regenerate owned outputs and validate the reviewed index.
- [ ] Commit the upstream candidate with normal hooks, publish it for exact-SHA CI,
  resolve failures and promote that verified commit to local `saturn/main`.
- [ ] Merge the sync-agent feature into a descendant of the newly promoted revision,
  run scoped regressions and generation checks, publish for CI and promote only
  after the resulting revision passes.

Raw diagnostics and local paths stay under ignored `.fork/local/`.
