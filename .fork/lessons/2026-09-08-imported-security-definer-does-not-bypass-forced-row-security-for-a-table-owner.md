## SECURITY DEFINER does not bypass forced row security for a table owner

**Context:** A maintenance function needed narrowly scoped access to purge expired rows from forced-RLS tables.

**Problem:** Owning a `SECURITY DEFINER` function with the table-owner role still left its updates and deletes subject to `FORCE ROW LEVEL SECURITY`. Moving the function to a dedicated owner also restored PostgreSQL's default `PUBLIC EXECUTE` grant unless the new owner reset the ACL.

**Rule:** For fixed-policy maintenance over forced-RLS tables, use a non-login, non-bypass function-owner role with explicit operation-specific table grants and RLS policies. Temporarily grant only what is needed to transfer ownership, remove every temporary membership, and revoke `PUBLIC EXECUTE` after the final ownership change. Test the function through its real caller role and prove ordinary runtime roles cannot execute it.

**Applies to:** Retention, recovery, administrative repair, and other `SECURITY DEFINER` functions over forced-RLS schemas.
