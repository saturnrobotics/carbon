# Prove deployment boundaries before release

**Context:** Local functional tests passed while release attempts exposed runtime,
provider request, and managed revision differences.

**Problem:** Full deployments became the first integration test for behavior that
could have been checked earlier. Rebuilding and retrying compounded the delay.

**Rule:** Follow the ordered verification stages in
[the fork policy](../agent-policy.md#verify-deployment-boundaries-before-release).
Use the actual production image and protocol client, validate rendered provider
requests, and isolate the remaining live platform checks before a full release.
Preserve exact private evidence and reuse it only while relevant inputs remain
unchanged. Google sign-in is a live identity check, not a blocker to local proof.

**Applies to:** Coding agents changing deployed applications, container images,
provider integrations, release tooling, or infrastructure configuration.
