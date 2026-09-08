## Deployment machinery is the agent's responsibility

**Context:** Completing deployment automation for an operator who wants to add features and run `make deploy`.

**Problem:** Requiring hand-written release inputs, mandatory preview commands, and a separate baseline command turned internal deployment work into operator homework.

**Rule:** Keep the normal deployment interface to `make deploy`. Generate inputs and select the appropriate rollout automatically, including initial release tracking, while retaining recovery snapshots and verification. Treat planning/check commands as optional diagnostics. Complete setup and routine integration work within the authorized scope; ask for user action only when access or a product decision cannot be resolved by the agent. Report actual verification and remaining blockers clearly instead of assigning an engineering checklist to the user.

**Applies to:** Deployment tooling, feature delivery, and operator handoffs.
