# Prove the exact staged Cloud Run revision started

**Context:** Existing service traffic is pinned while a candidate is checked.

**Problem:** A zero-traffic revision without a tag may retire before starting.
Service readiness, or revision Ready with reason Retired, does not prove that its
HTTP startup probe ran. A fake control plane that always marks new revisions
ready can conceal this gap.

**Rule:** Keep existing traffic and tags, activate the candidate with a unique
protected zero-percent staging tag whose generated URL fits DNS label limits,
and require exact-revision Ready plus
ContainerHealthy before promotion. Remove only the owned staging tag before
recording success. On failure preserve prior traffic and configuration; never
restore over an observed concurrent newer revision or remove a retargeted tag. Test cleanup
failure and retired/missing-health conditions, and validate the behavior against
the provider without bypassing IAP or issuing production business requests.

**Applies to:** Portal's Cloud Run release controller and future staged rollouts.
