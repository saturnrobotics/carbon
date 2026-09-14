# Portal PostgreSQL TLS host verification

Base: `05ecb08c5fbd0a428d770aefc9ab72697ff21a85`.

Problem: pg upgrades a connected socket without a TLS host for literal IP addresses.
Node then verifies localhost, rejecting a valid IP-only certificate SAN.

- [x] Reproduce with real pg, PostgreSQL SSLRequest, and ephemeral synthetic certificates.
- [x] Add `portalPoolConfig` to the existing server-only database module. Preserve
  verify-full chain and identity checks, certificate material, and pool limits.
- [x] Route schema, query, worker, retention, and enrollment/revocation pools through
  the helper; remove URL TLS parameters that would overwrite explicit TLS options.
- [x] Verify correct IPv4/DNS identities, IPv6 normalization, wrong identity and CA rejection,
  host overrides, duplicate parameter rejection, and local plaintext compatibility.
- [x] Run scoped Portal/query/worker tests and typechecks; review public diff.
- [ ] Complete normal PR checks and independent final review before integration.

Validation: `pnpm --filter @carbon/portal test` (487 tests),
`pnpm --filter portal-query test` (85), `pnpm --filter portal-worker test` (142),
on Node 22.23.2, scoped Turbo typechecks, and query/worker builds pass. Production verification remains a separate
release step; the regression server performs no real database operations.

The production network contract requires private IPv4. Literal IPv6 normalization
is tested separately; Node 22.23.2 has an upstream fail-closed IPv6 SAN verifier
regression ([Node issue 64144](https://github.com/nodejs/node/issues/64144)).
This change does not replace Node's verifier or claim IPv6 runtime support.
