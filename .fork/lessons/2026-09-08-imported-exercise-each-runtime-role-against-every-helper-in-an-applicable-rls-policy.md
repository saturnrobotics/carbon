## Exercise each runtime role against every helper in an applicable RLS policy

**Context:** The real background delivery path selected an upload source as the ingestion role.

**Problem:** A shared source SELECT policy referenced a human visibility helper in another OR branch. PostgreSQL required its EXECUTE privilege even though the machine branch was the intended authorization path; mocked processor tests did not catch the failure.

**Rule:** Verify helper execution privileges through actual runtime-role queries. Do not rely on Boolean short-circuiting to avoid permission checks. Use a narrow helper grant or role-specific policy, then prove that unassigned callers, sources and companies still return no rows.

**Applies to:** Shared RLS policies and background ingestion role integration tests.
