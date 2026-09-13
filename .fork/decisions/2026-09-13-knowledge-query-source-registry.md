# The query service reads its live-source registry from configuration

**Date:** 2026-09-13
**Scope:** Tasks 03 and 04 of `.fork/plans/2026-09-13-knowledge-erp-join-repairs.md`.
**Base:** `saturn/main` at `eb5da21766`.

## The finding

`createItemSearchHandler` and `createReadHandler` were both constructed with no
`sources`, and no configuration value mapped to a source registry. Only test code
ever supplied one, so a deployed service could not be told that a Carbon ERP
existed. `KNOWLEDGE_SOURCES_JSON` appeared in two tests as configuration the
release deliberately ignored.

Separately, `createReadHandler` enabled the structured live-source path only when
a registry was present **and no manual source was configured**. The manual source
is required configuration on the released profile, so the structured path was
unreachable there as a side effect of a second setting rather than by intent.

## Decisions

- **One configuration input, validated at start-up.** `KNOWLEDGE_SOURCES_JSON` is
  read by `readSourceRegistryConfiguration` and parsed with
  `sourceRegistryConfigurationSchema` — the same runtime schema every consumer
  validates against — following the shape of the two registries the service
  already reads that way. Absent means no live source, which is the released
  profile's own shape and stays supported.
- **Malformed refuses to boot.** The parse throws inside `isQueryReady`, so
  `/health` answers `not-configured`, the staged revision never becomes Ready and
  the promotion fails with a reason. Starting with no sources instead would have
  presented as an empty corpus rather than as a misconfiguration, and nobody
  would have gone looking for the typo.
- **HTTPS-only origins without credentials are inherited, not restated.** The
  registry schema already refuses a plaintext origin, embedded credentials, and a
  path, query or fragment — the policy the transport applies to a URL it
  acquires. Configuration is not a way around it. Pinned by tests rather than
  duplicated in a second place that could drift.
- **The operator's decision: the two coexist, manual primary.** The structured
  path is enabled by the registry and the router's decision, and by nothing else.
  A registered source answers only the structured intents the router names; every
  other question, and every structured one no registered source answers, still
  falls through to the manual index.
- **The structured path sees the reader's own request.** The manual pin rewrites
  `context.source` to confine the *document* index read to the upload library. A
  live source is not in that library, so passing the rewritten request would have
  left every registered source unpermitted — unreachability under a different
  name — and would have dropped an ambiguity choice's `entityId`. The router's
  decision is unchanged either way: it reads the request text, which the rewrite
  never touches.
- **The release planner admits the key for the query unit alone,** through a new
  `OPTIONAL_ENVIRONMENT` allowance (absence is never an error, unlike
  `REQUIRED_ENVIRONMENT`), and checks the same shape before any cloud write.
  `kind` is restricted to `carbon`: kanban belongs to the deferred command
  surface and the generic adapters are excluded from this release, so admitting
  the key without that restriction would have reversed a standing release
  decision by the back door. Which Carbon source a deployment registers remains
  entirely the operator's.

## Known limit, recorded rather than fixed

With any registry configured, "the manual for the item we received" is answered
by the Carbon resolver, and a reading company with no active `carbon` source row
of its own receives a clarification with no choices rather than falling through
to keyword search. That shape is pre-existing in `resolveRecentManual` and
identical on the profile where the path was already reachable; enabling the path
on the released profile is what makes it reachable there. Documented in
`contrib/deploying/knowledge/README.md` beside the registry.

## Verification

Recorded in the pull request's verification table. The containerised browser
suite ran as `knowledge-a4928-registry` on its own ports and image tag and was
removed afterwards; no shared stack was touched.
