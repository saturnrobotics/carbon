# Google Workspace authentication policy

The deployment enables only Google OAuth in GoTrue and sets Carbon's
`AUTH_PROVIDERS=google`. The application hides its email form and rejects email
login/signup actions when that provider is disabled. The database hook enforces
the access restriction before GoTrue issues tokens, including tokens requested
directly from Supabase.

`google-domain-hook.sql` installs a private deployment policy outside Carbon's
application migrations. After GoTrue initializes its `auth` schema, and before
enabling login, apply it as the database administrator:

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v allowed_email_domain="$AUTH_ALLOWED_GOOGLE_DOMAIN" \
  -f auth/google-domain-hook.sql
```

The deployment obtains that value from private configuration. The script is
transactional and repeatable. It never modifies application tables. The private
schema is excluded from PostgREST, and client roles cannot read its configuration
or execute its hook. Only `supabase_auth_admin` can invoke the hook; it cannot
change the policy.

Enable these GoTrue settings after installation:

```dotenv
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/carbon_private/google_domain_access_token
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_EMAIL_ENABLED=false
GOTRUE_EXTERNAL_PHONE_ENABLED=false
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false
GOTRUE_EXTERNAL_AZURE_ENABLED=false
GOTRUE_SAML_ENABLED=false
GOTRUE_DISABLE_SIGNUP=false
```

Keep **every other OAuth provider disabled**. Supabase's session authentication
method records OAuth without identifying which provider authenticated that
session. The hook relies on Google being the sole enabled OAuth provider.
The Google OAuth application's audience must also be **Internal** within the
Google Workspace organization. This is a required second boundary, configured
in Google Auth Platform, not a browser `hd` hint.

The hook requires all of the following:

- An OAuth session, including its later token refresh and TOTP challenges.
- An exact match between the token's subject/email and the Supabase account.
- A Google identity with a verified email matching the account.
- The configured email domain and Google's signed Workspace `hd` claim matching
  exactly. Consumer accounts, other domains and subdomains are rejected.

It reads trusted `auth.identities.identity_data`, never client-writable user
metadata. Empty configuration and missing claims fail closed. It preserves
Carbon's token claims, company membership and RLS behavior. First authorized
Google login can create a user; Carbon's existing ERP onboarding creates the
company. Further users still need company membership to access its records.
An invite's email link is not a login bypass: invited users sign in using Google.

For user offboarding, deactivate the Carbon account and revoke its Supabase
sessions as well as disabling its Google Workspace account. Supabase refreshes
its own sessions without contacting Google on every refresh. Existing access
tokens remain valid until their configured expiry.

The tested GoTrue version is `supabase/gotrue:v2.189.0`. Its
[Google OIDC parser](https://github.com/supabase/auth/blob/v2.189.0/internal/api/provider/oidc.go)
preserves the validated `hd` claim as `custom_claims.hd`; the
[OAuth callback](https://github.com/supabase/auth/blob/v2.189.0/internal/api/external.go)
stores provider email and verification in identity data. Supabase documents
[custom access-token hook inputs](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook)
and [self-hosted hook configuration](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-hooks).
Recheck those contracts before upgrading GoTrue.

Run the SQL regression suite with PostgreSQL's `initdb`, `pg_ctl` and `psql` on
`PATH`:

```sh
python3 contrib/deploying/gcp-tailscale/auth/test_google_domain_hook.py
```

The tests execute the installed hook as `supabase_auth_admin` in a temporary
cluster listening only on its own Unix socket. They exercise valid login,
refresh and MFA, domain/identity spoofing, non-Google methods, missing claims,
policy changes, repeatable installation and database privileges. They do not
connect to the application's database. A real Google login from the tailnet
remains a required deployment acceptance check.

## Edge function boundary

The deployment mounts `edge-main/` instead of the development dispatcher. It
verifies the HS256 signature and expiry of Supabase bearer tokens **before**
creating any function worker, preventing forged `service_role` claims from
reaching functions that decode their caller's token. The shared permissions
helper also binds an authenticated user's permission lookup to that token's
subject. Service calls retain their existing behavior after verification.

The dispatcher sets the function import map explicitly and limits CORS to the
configured ERP/MES origins. OPTIONS returns preflight headers without executing
a worker. Its only bearer exceptions are the existing `image-resizer` and
`logo-resizer` POST uploads: these functions transform the submitted bytes and
do not read application data. They still require Tailscale network access.
The signed anon token can call only `event-wake`, matching Carbon's existing
database queue trigger. Every other function requires a signed authenticated
or service-role token.

With Node 22+ and workspace dependencies installed, exercise the dispatcher and
the real shared permission helper against a local PostgREST stub:

```sh
node --experimental-strip-types --test \
  contrib/deploying/gcp-tailscale/auth/test_edge_dispatcher.mjs
```

No external account or database is used. These tests cover signature/algorithm
forgery, token expiry, role validation, CORS, restricted anonymous access,
worker error sanitization, and attempts to request another user's permissions.
