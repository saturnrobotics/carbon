"""Exercise the real hook SQL in an isolated, temporary PostgreSQL cluster.

Requires PostgreSQL's initdb, pg_ctl and psql on PATH. Never connects to an
existing database, uses no application data, and deletes the cluster afterward.
"""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


DIRECTORY = Path(__file__).resolve().parent
USER_ID = "10000000-0000-0000-0000-000000000001"
EMAIL = "employee@example.com"
CLAIMS = {
    "sub": USER_ID,
    "email": EMAIL,
    "role": "authenticated",
    "is_anonymous": False,
    "amr": [{"method": "oauth", "timestamp": 1234567890}],
    "custom_application_claim": {"keep": True},
}
IDENTITY = {
    "email": EMAIL,
    "email_verified": True,
    "custom_claims": {"hd": "example.com"},
}
# GoTrue v2.189.0's Keycloak provider stores the HQ identity provider's userinfo:
# standard claims at the top level, every other claim under custom_claims.
KEYCLOAK_IDENTITY = {
    "iss": "https://hq.example.com/oidc/keycloak",
    "sub": "synthetic-google-subject",
    "provider_id": "synthetic-google-subject",
    "name": "Synthetic Employee",
    "full_name": "Synthetic Employee",
    "email": EMAIL,
    "email_verified": True,
    "custom_claims": {"hd": "example.com", "hq_capabilities": ["read:app"]},
}


def literal(value):
    if not isinstance(value, str):
        value = json.dumps(value)
    return "'" + value.replace("'", "''") + "'"


class GoogleDomainHookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for binary in ("initdb", "pg_ctl", "psql"):
            if not shutil.which(binary):
                raise RuntimeError(f"Install PostgreSQL and add {binary} to PATH")
        # Keep the socket path below Unix's ~104-byte sockaddr limit on macOS.
        cls.temporary = tempfile.TemporaryDirectory(prefix="carbon-auth-", dir="/tmp")
        cls.cluster = Path(cls.temporary.name)
        cls.environment = {
            key: value for key, value in os.environ.items() if not key.startswith("PG")
        }
        cls.environment["LC_ALL"] = "C"
        cls.started = False
        try:
            cls.command(
                "initdb", "-D", str(cls.cluster / "data"), "-U", "postgres",
                "--auth-local=trust", "--auth-host=reject", "--no-locale",
            )
            cls.command(
                "pg_ctl", "-D", str(cls.cluster / "data"),
                "-l", str(cls.cluster / "postgres.log"), "-w", "start",
                "-o", f"-k {cls.cluster} -c listen_addresses='' -c fsync=off",
            )
            cls.started = True
            cls.sql("""
                CREATE ROLE anon;
                CREATE ROLE authenticated;
                CREATE ROLE supabase_auth_admin;
                CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
                CREATE TABLE auth.users (
                  id UUID PRIMARY KEY,
                  email TEXT,
                  email_confirmed_at TIMESTAMPTZ,
                  raw_user_meta_data JSONB
                );
                CREATE TABLE auth.identities (
                  user_id UUID,
                  provider TEXT,
                  identity_data JSONB
                );
                GRANT SELECT ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
            """)
            cls.install()
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def command(cls, *arguments, input=None, check=True):
        result = subprocess.run(
            arguments, input=input, text=True, capture_output=True,
            env=cls.environment, timeout=60,
        )
        if check and result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    @classmethod
    def sql(cls, statement, *arguments, check=True):
        return cls.command(
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
            "-h", str(cls.cluster), "-p", "5432", "-U", "postgres",
            "-d", "postgres", *arguments, input=statement, check=check,
        )

    @classmethod
    def install(cls, domain="example.com"):
        return cls.sql(
            (DIRECTORY / "google-domain-hook.sql").read_text(),
            "-v", f"allowed_email_domain={domain}",
        )

    @classmethod
    def tearDownClass(cls):
        if cls.started:
            cls.command(
                "pg_ctl", "-D", str(cls.cluster / "data"),
                "-m", "immediate", "-w", "stop", check=False,
            )
        cls.temporary.cleanup()

    def setUp(self):
        self.sql("""
            TRUNCATE auth.users, auth.identities;
            INSERT INTO carbon_private.auth_policy VALUES (TRUE, 'example.com')
            ON CONFLICT (singleton) DO UPDATE SET allowed_email_domain = 'example.com';
        """)
        self.sql(f"""
            INSERT INTO auth.users VALUES (
              {literal(USER_ID)}, {literal(EMAIL)}, CURRENT_TIMESTAMP,
              '{{"email_verified":true,"custom_claims":{{"hd":"example.com"}}}}'
            );
            INSERT INTO auth.identities VALUES (
              {literal(USER_ID)}, 'google', {literal(IDENTITY)}::JSONB
            );
        """)

    def hook(self, method="oauth", claims=None, user_id=USER_ID):
        event = {
            "user_id": user_id,
            "authentication_method": method,
            "claims": CLAIMS if claims is None else claims,
        }
        result = self.sql(
            "SET ROLE supabase_auth_admin; SELECT "
            f"carbon_private.google_domain_access_token({literal(event)}::JSONB);"
        )
        return json.loads(result.stdout)

    def assert_denied(self, **kwargs):
        result = self.hook(**kwargs)
        self.assertEqual(result.get("error", {}).get("http_code"), 403, result)
        self.assertNotIn("claims", result)

    def set_identity(self, identity):
        self.sql(f"UPDATE auth.identities SET identity_data = {literal(identity)}::JSONB;")

    def test_google_oauth_refresh_and_mfa_preserve_all_claims(self):
        for method in ("oauth", "token_refresh", "totp"):
            with self.subTest(method=method):
                self.assertEqual(self.hook(method=method), {"claims": CLAIMS})

    def test_password_magiclink_invite_anonymous_and_unknown_are_rejected(self):
        for method in (
            "password", "magiclink", "invite", "anonymous", "sso/saml", "otp",
            "email/signup", "email_change", "recovery", "", None, "future_method",
        ):
            with self.subTest(method=method):
                self.assert_denied(method=method)

    def test_refresh_requires_original_oauth_authentication(self):
        for amr in (None, {}, [], [{"method": "password"}], [{"method": "totp"}]):
            with self.subTest(amr=amr):
                claims = {**CLAIMS, "amr": amr}
                self.assert_denied(method="token_refresh", claims=claims)

    def test_rejects_identities_from_other_providers(self):
        for provider in ("azure", "github", "email", "sso:synthetic", "Keycloak", "keycloak ", "Google"):
            with self.subTest(provider=provider):
                self.sql(f"UPDATE auth.identities SET provider = {literal(provider)};")
                self.assert_denied()

    def use_keycloak(self, identity=None):
        self.sql(
            "UPDATE auth.identities SET provider = 'keycloak', identity_data = "
            f"{literal(KEYCLOAK_IDENTITY if identity is None else identity)}::JSONB;"
        )

    def test_keycloak_oauth_refresh_and_mfa_preserve_all_claims(self):
        self.use_keycloak()
        for method in ("oauth", "token_refresh", "totp"):
            with self.subTest(method=method):
                self.assertEqual(self.hook(method=method), {"claims": CLAIMS})

    def test_keycloak_still_requires_an_oauth_session(self):
        self.use_keycloak()
        for method in ("password", "magiclink", "sso/saml", "otp", None):
            with self.subTest(method=method):
                self.assert_denied(method=method)
        self.assert_denied(method="token_refresh", claims={**CLAIMS, "amr": [{"method": "password"}]})

    def test_keycloak_rejects_wrong_or_missing_hosted_domain(self):
        for custom_claims in (
            {"hd": "other.example"}, {"hd": "sub.example.com"}, {"hd": ""}, {"hd": None},
            {"hq_capabilities": ["read:app"]}, None,
        ):
            with self.subTest(custom_claims=custom_claims):
                identity = {**KEYCLOAK_IDENTITY, "custom_claims": custom_claims}
                if custom_claims is None:
                    del identity["custom_claims"]
                self.use_keycloak(identity)
                self.assert_denied()

    def test_keycloak_hosted_domain_must_be_inside_custom_claims(self):
        identity = {**KEYCLOAK_IDENTITY, "hd": "example.com", "custom_claims": {}}
        self.use_keycloak(identity)
        self.assert_denied()

    def test_keycloak_requires_boolean_verified_email(self):
        for verified in (False, "true", None):
            with self.subTest(verified=verified):
                self.use_keycloak({**KEYCLOAK_IDENTITY, "email_verified": verified})
                self.assert_denied()
        identity = dict(KEYCLOAK_IDENTITY)
        del identity["email_verified"]
        self.use_keycloak(identity)
        self.assert_denied()

    def test_keycloak_identity_email_must_match_account(self):
        for email in ("someone.else@example.com", "employee@other.example", "", None):
            with self.subTest(email=email):
                self.use_keycloak({**KEYCLOAK_IDENTITY, "email": email})
                self.assert_denied()

    def test_keycloak_account_must_be_confirmed_and_on_the_domain(self):
        self.use_keycloak()
        self.sql("UPDATE auth.users SET email_confirmed_at = NULL;")
        self.assert_denied()
        self.sql("UPDATE auth.users SET email_confirmed_at = CURRENT_TIMESTAMP, email = 'employee@other.example';")
        self.use_keycloak({**KEYCLOAK_IDENTITY, "email": "employee@other.example",
                           "custom_claims": {"hd": "other.example"}})
        self.assert_denied(claims={**CLAIMS, "email": "employee@other.example"})

    def test_account_with_google_and_keycloak_identities_is_admitted_by_either(self):
        # AMR cannot name the session's provider, so one qualifying identity from
        # either enabled provider admits the account (documented in the hook).
        self.sql(f"""
            INSERT INTO auth.identities VALUES (
              {literal(USER_ID)}, 'keycloak', {literal(KEYCLOAK_IDENTITY)}::JSONB
            );
        """)
        self.assertEqual(self.hook(), {"claims": CLAIMS})
        self.sql("UPDATE auth.identities SET identity_data = identity_data || '{\"email_verified\":false}' WHERE provider = 'google';")
        self.assertEqual(self.hook(), {"claims": CLAIMS})
        self.sql("UPDATE auth.identities SET identity_data = identity_data || '{\"email_verified\":false}' WHERE provider = 'keycloak';")
        self.assert_denied()

    def test_rejects_missing_google_identity_even_with_user_metadata(self):
        self.sql("DELETE FROM auth.identities;")
        self.assert_denied()

    def test_requires_boolean_verified_google_email(self):
        for verified in (False, "true", None):
            with self.subTest(verified=verified):
                self.set_identity({**IDENTITY, "email_verified": verified})
                self.assert_denied()

    def test_rejects_consumer_account_missing_signed_hosted_domain(self):
        self.set_identity({"email": EMAIL, "email_verified": True})
        self.assert_denied()

    def test_rejects_different_workspace(self):
        self.set_identity({**IDENTITY, "custom_claims": {"hd": "other.example"}})
        self.assert_denied()

    def test_rejects_wrong_email_domain_suffix_subdomain_and_malformed_address(self):
        for email in (
            "employee@other.example", "employee@badexample.com",
            "employee@example.com.bad", "employee@sub.example.com",
            "employee@example.com@other.example", "@example.com",
        ):
            with self.subTest(email=email):
                self.sql(f"UPDATE auth.users SET email = {literal(email)};")
                self.set_identity({**IDENTITY, "email": email})
                self.assert_denied(claims={**CLAIMS, "email": email})

    def test_identity_email_must_match_account(self):
        self.set_identity({**IDENTITY, "email": "someone.else@example.com"})
        self.assert_denied()

    def test_claim_email_must_match_account(self):
        self.assert_denied(claims={**CLAIMS, "email": "someone.else@example.com"})

    def test_user_id_must_match_claim_subject(self):
        self.assert_denied(user_id="10000000-0000-0000-0000-000000000002")

    def test_rejects_unconfirmed_account(self):
        self.sql("UPDATE auth.users SET email_confirmed_at = NULL;")
        self.assert_denied()

    def test_rejects_anonymous_or_privileged_claims(self):
        self.assert_denied(claims={**CLAIMS, "is_anonymous": True})
        self.assert_denied(claims={**CLAIMS, "role": "service_role"})

    def test_missing_policy_fails_closed(self):
        self.sql("DELETE FROM carbon_private.auth_policy;")
        self.assert_denied()

    def test_domain_change_applies_on_refresh(self):
        self.sql("UPDATE carbon_private.auth_policy SET allowed_email_domain = 'other.example';")
        self.assert_denied(method="token_refresh")

    def test_normalizes_email_and_hosted_domain_case(self):
        self.sql("UPDATE auth.users SET email = 'Employee@EXAMPLE.COM';")
        identity = copy.deepcopy(IDENTITY)
        identity["email"] = "EMPLOYEE@example.com"
        identity["custom_claims"]["hd"] = "EXAMPLE.COM"
        self.set_identity(identity)
        self.assertEqual(self.hook(), {"claims": CLAIMS})

    def test_install_is_repeatable_and_domain_value_is_sql_escaped(self):
        self.install()
        self.install("EXAMPLE.COM")
        self.assertEqual(self.hook(), {"claims": CLAIMS})
        with self.assertRaises(AssertionError):
            self.install("example.com'); DROP SCHEMA auth CASCADE; --")
        self.assertEqual(self.hook(), {"claims": CLAIMS})

    # HQ plan 0006B (B8). The stubs stand in for the Saturn authz migration's
    # carbon_private.authz_projection_enabled() and for HQ's authz functions,
    # with the signatures and grants plan 0006B B4 gives them.
    def manage(self, enabled=True, subject="user:synthetic-google-subject", capabilities=()):
        self.sql(f"""
            CREATE TABLE public.hook_test_authz (enabled BOOLEAN, subject TEXT, capabilities TEXT[]);
            INSERT INTO public.hook_test_authz VALUES (
              {str(enabled).upper()},
              {"NULL" if subject is None else literal(subject)},
              ARRAY[{", ".join(literal(c) for c in capabilities)}]::TEXT[]
            );
            CREATE FUNCTION carbon_private.authz_projection_enabled() RETURNS BOOLEAN
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
              AS $$ SELECT enabled FROM public.hook_test_authz $$;
            REVOKE ALL ON FUNCTION carbon_private.authz_projection_enabled() FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION carbon_private.authz_projection_enabled() TO supabase_auth_admin;
            CREATE SCHEMA authz;
            CREATE FUNCTION authz.subject_of_auth_user(auth_uid UUID) RETURNS TEXT
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
              AS $$ SELECT subject FROM public.hook_test_authz WHERE auth_uid = {literal(USER_ID)}::UUID $$;
            CREATE FUNCTION authz.capabilities(subject TEXT, namespace TEXT) RETURNS TEXT[]
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
              AS $$ SELECT CASE WHEN namespace = 'api' THEN capabilities END FROM public.hook_test_authz $$;
            REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
            GRANT USAGE ON SCHEMA authz TO supabase_auth_admin;
            GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA authz TO supabase_auth_admin;
        """)
        self.addCleanup(self.sql, """
            DROP SCHEMA IF EXISTS authz CASCADE;
            DROP FUNCTION IF EXISTS carbon_private.authz_projection_enabled();
            DROP TABLE IF EXISTS public.hook_test_authz;
        """)

    def test_authz_claim_is_absent_until_the_projection_is_enabled(self):
        forged = {**CLAIMS, "authz_api": ["api:supabase.storage"]}
        self.assertEqual(self.hook(claims=forged), {"claims": CLAIMS})
        self.manage(enabled=False, capabilities=("use:api:supabase.rest",))
        self.assertEqual(self.hook(claims=forged), {"claims": CLAIMS})

    def test_authz_claim_lists_the_api_resources_authz_grants(self):
        self.manage(capabilities=(
            "use:api:supabase.rest", "read:hq:app", "use:api:supabase.realtime",
            "use:api:supabase.rest", "admin:authz:grant",
        ))
        expected = {**CLAIMS, "authz_api": ["api:supabase.realtime", "api:supabase.rest"]}
        for method in ("oauth", "token_refresh", "totp"):
            with self.subTest(method=method):
                self.assertEqual(self.hook(method=method), {"claims": expected})
        # Neither a forged top-level claim nor user-editable metadata changes it.
        forged = {**CLAIMS, "authz_api": ["api:supabase.storage"],
                  "user_metadata": {"authz_api": ["api:supabase.functions"]}}
        self.assertEqual(
            self.hook(claims=forged)["claims"]["authz_api"],
            ["api:supabase.realtime", "api:supabase.rest"],
        )

    def test_authz_claim_is_empty_without_api_grants(self):
        self.manage(capabilities=("read:hq:app",))
        self.assertEqual(self.hook(), {"claims": {**CLAIMS, "authz_api": []}})

    def test_unknown_or_disabled_subject_gets_no_token(self):
        self.manage(subject=None, capabilities=("use:api:supabase.rest",))
        for method in ("oauth", "token_refresh"):
            with self.subTest(method=method):
                result = self.hook(method=method)
                self.assertEqual(result["error"]["http_code"], 403)
                self.assertIn("not active in HQ", result["error"]["message"])
                self.assertNotIn("claims", result)

    def test_workspace_rules_still_apply_when_authz_manages_carbon(self):
        self.manage(capabilities=("use:api:supabase.rest",))
        self.set_identity({**IDENTITY, "custom_claims": {"hd": "other.example"}})
        self.assert_denied()

    def test_an_authz_failure_refuses_the_token(self):
        self.manage(capabilities=("use:api:supabase.rest",))
        self.sql("DROP FUNCTION authz.capabilities(TEXT, TEXT);")
        # GoTrue refuses to issue a token when the hook errors.
        with self.assertRaises(AssertionError):
            self.hook()

    def test_client_roles_cannot_call_hook_or_change_policy(self):
        for role in ("anon", "authenticated"):
            for query in (
                "SELECT carbon_private.google_domain_access_token('{}');",
                "SELECT * FROM carbon_private.auth_policy;",
                "UPDATE carbon_private.auth_policy SET allowed_email_domain = 'other.example';",
            ):
                with self.subTest(role=role, query=query):
                    result = self.sql(f"SET ROLE {role}; {query}", check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("permission denied", result.stderr)
        result = self.sql(
            "SET ROLE supabase_auth_admin; "
            "UPDATE carbon_private.auth_policy SET allowed_email_domain = 'other.example';",
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("permission denied", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
