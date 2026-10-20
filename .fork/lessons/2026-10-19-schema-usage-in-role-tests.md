# Model schema USAGE when testing another role's grants

**Context:** A fork migration granted a non-Carbon role column SELECT and row
policies on tables in `public`, and its SQL test passed on Carbon's local stack.

**Problem:** The local stack grants PUBLIC USAGE on `public`; the target database
did not, so every read by that role failed with "permission denied for schema
public" before any column grant or policy applied.

**Rule:** A migration that lets a role read objects in a schema grants that role
USAGE on the schema itself, never relying on PUBLIC. Its test revokes PUBLIC's
USAGE inside the test transaction and asserts the role's own grant, so a missing
schema grant fails the test.

**Applies to:** `saturn-*` migrations and tests that grant access to roles outside
Carbon's own (`hq_*`, `authz_*`, and similar).
