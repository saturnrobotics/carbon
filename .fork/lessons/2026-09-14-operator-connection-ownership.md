# Deployment owns its operator connection

**Context:** A single-command preflight depended on a separately running private tunnel.

**Problem:** The tunnel expired while libpq retained its local port, causing connection refusal.

**Rule:** Track the connection lifecycle in the command that needs it. Use a private,
invocation-owned listener and temporary credentials; preserve remote TLS identity and
password-file port matching. Bound startup and clean up descendants on success,
failure and interruption. A failed database tunnel must not prevent independent
provider rollback or Scheduler cleanup. Prove real process/listener cleanup locally,
then verify the authenticated provider route with bounded read-only queries.

**Applies to:** Portal deployment and operator connection tooling.
