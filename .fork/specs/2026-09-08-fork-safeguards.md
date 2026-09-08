# Fork integration safeguards

Approved scope: implement the preceding repository audit and the user’s request for durable, tested agent rules. Autonomous implementation is authorized. No production data/schema changes, history rewrites, force pushes, or live deployment.

## Acceptance
- A dependency-free preflight inspects Git revision/index contents before installers can repair corruption. It rejects conflict markers, malformed contract JSON, forbidden tracked runtime artifacts/private keys, missing policy wiring, and modified historical migrations relative to an explicit baseline.
- A generated-artifact registry distinguishes tracked contracts, disposable output, authored translations, and the lockfile. Fresh generation is compared to the original Git snapshot, not postinstall output; repeated generation is checked for stability.
- CI runs for every integration-branch PR/push, reports one required result, and tests both accepted and deliberately corrupted fixtures. Missing/skipped mandatory checks cannot count as release verification.
- Deployment requires successful fork verification for its exact source revision before cloud mutations. Upstream synchronization preserves history and runs in a separate branch; promotion requires verification.
- Database generation preserves last-good files on failure. MCP caching cannot omit transitive inputs. Schema verification runs only in disposable CI infrastructure, validates migration provenance, and compares fresh and upgrade paths.
- Fork-specific lessons/specs/plans move to a distinct namespace without losing authored content. Persistent agent entry points route there; generated harness copies are not edited as source.
- Existing committed digest corruption and forbidden generated artifacts are repaired. The user’s original uncommitted lockfile remains byte-for-byte unchanged.
- Tests exercise gate failures and policy loading, not merely happy-path command invocation. Independent review and cold-reading verify the workflow instructions.

## Boundaries
No application feature redesign, authentication/RBAC changes, production dependencies, or automatic deployment. Existing unrelated failures must be demonstrated and reported; they cannot be silently converted into a successful release gate.
