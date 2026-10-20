# Read Supabase's auth tables through a definer, and stub their row level security

**Context:** HQ's authz service read GoTrue's `auth.identities` through a column
grant to its owner role, and its tests passed against a stand-in table.

**Problem:** GoTrue enables row level security on `auth.identities` and adds no
policy. A column grant there reads zero rows without an error, so every caller
saw "no identity": a seed skipped every user, and a projection would have given
everyone no permissions. The stand-in had row level security off, so nothing
failed until the shared database.

**Rule:** Another role reads Supabase's `auth` tables only through a fork-owned
SECURITY DEFINER reader in `carbon_private`, owned by the administrator, with
`search_path=''`, no PUBLIC EXECUTE and a guarded grant to that role. Tests that
stand in for an `auth` table enable (and force) row level security with no
policy, as GoTrue does, so a direct grant fails the test.

**Applies to:** `saturn-*` migrations and HQ's fixtures that read `auth.users`,
`auth.identities` or any other GoTrue table for a role outside Carbon's own.
