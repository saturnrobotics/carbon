# Validate the client the operator command actually selects

**Context:** An operator connection passed a focused check with a newer client explicitly selected.

**Problem:** The normal command still selected an incompatible client from PATH and failed certificate identity verification.

**Rule:** Encode documented client requirements in preflight and pass the selected executable through the real command adapter. Verify from the ordinary shell environment without an unreported PATH override. Preserve strict TLS and prove rejection followed by success against the same connection when diagnosing client compatibility.

**Applies to:** Portal operator connections and deployment prerequisites.
