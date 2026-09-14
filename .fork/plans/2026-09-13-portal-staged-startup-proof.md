# Activate staged Portal revisions for startup proof

Base: `c3b6831c6532c73a02e1fae22449f1a9d7fad9b4`.

An existing service kept all traffic on its prior revision. Its untagged candidate
retired before starting, so the controller could not prove its HTTP startup probe.
A bounded live check added a zero-percent tag to the exact candidate, observed
successful container health, and restored the previous traffic and tags.

- [x] Reproduce missing staging activation and insufficient revision-health checks.
- [x] Add a unique temporary tag while preserving prior traffic and tags.
- [x] Require exact-revision Ready and ContainerHealthy without retired status.
- [x] Remove the owned tag before recording promotion; test rollback, cleanup
  failures, concurrent writers, collisions, first creation, and prior progress.
- [x] Run all 159 Portal Python tests and review the focused source diff.
- [ ] Complete independent review and normal PR checks before integration.

No authentication, schema, dependency, or application-route change is needed.
Live release verification remains separate from source validation.
